/**
 * WebGL custom layer: billboarded proportional donut markers for clusters.
 * Buffer rebuilds on moveend/idle; pixel→NDC sizing happens in the shader.
 * Hit-testing is handled by the companion "clusters" circle layer.
 */
import maplibregl, { type CustomRenderMethodInput } from "maplibre-gl";

import { MAP_STYLE_IDS } from "../../maps/mapStyle";
import { prefersReducedMotion } from "../../utils/reducedMotion";

const VS = `
attribute vec3 a_pos;          // Mercator xyz (z = altitude → terrain-aware)
attribute vec2 a_uv;           // Local corner [-1, 1] (+y = up)
attribute float a_pixelRadius; // Cluster radius in CSS pixels
attribute float a_ratio;       // Online fraction, 0..1

uniform mat4 u_matrix;
uniform vec2 u_viewport;       // Framebuffer px
uniform float u_dpr;           // devicePixelRatio
uniform float u_alpha;         // Layer-wide opacity multiplier (0..1)

varying vec2 v_uv;
varying float v_ratio;
varying float v_alpha;

void main() {
  vec4 clip = u_matrix * vec4(a_pos, 1.0);

  // CSS-pixel → physical → NDC. u_dpr keeps donuts aligned with native layers on HiDPI.
  vec2 ndcOffset = a_uv * (a_pixelRadius * 2.0 * u_dpr) / u_viewport;
  clip.xy += ndcOffset * clip.w;

  gl_Position = clip;
  v_uv = a_uv;
  v_ratio = a_ratio;
  v_alpha = u_alpha;
}
`;

const FS = `
precision highp float;
varying vec2 v_uv;
varying float v_ratio;
varying float v_alpha;

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

const float OUTER_R = 0.96;
// Inner edge of the online/offline ring. OUTER_R - INNER_R is the visible
// ring thickness — raising INNER_R slims the ring without changing the
// cluster footprint (count text + hit-test radius stay the same).
const float INNER_R = 0.78;
const float EDGE_AA = 0.035;

const vec4 COL_BG      = vec4(0.059, 0.090, 0.164, 0.88);
const vec4 COL_ONLINE  = vec4(0.196, 0.941, 0.196, 1.00); // #32f032 (DEFAULT_NODE_COLOR)
const vec4 COL_OFFLINE = vec4(0.447, 0.475, 0.541, 0.85); // #72798a (OFFLINE_NODE_COLOR)
const vec4 COL_BORDER  = vec4(1.000, 1.000, 1.000, 0.15);

void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;

  float outerMask = 1.0 - smoothstep(OUTER_R, OUTER_R + EDGE_AA, d);

  vec4 color = COL_BG;

  float ringMask = smoothstep(INNER_R - EDGE_AA, INNER_R + EDGE_AA, d);

  // Angle from 12 o'clock clockwise in [0, TAU)
  float angle = atan(v_uv.x, v_uv.y);
  float cwa   = angle < 0.0 ? angle + TAU : angle;

  vec4 ringColor;
  if (v_ratio >= 0.999) {
    ringColor = COL_ONLINE;
  } else if (v_ratio <= 0.001) {
    ringColor = COL_OFFLINE;
  } else {
    float gap = 0.05; // radian gap between segments
    float boundary = v_ratio * TAU;
    bool inOnline  = cwa < boundary - gap * 0.5;
    bool inOffline = cwa > boundary + gap * 0.5 && cwa < TAU - gap * 0.5;
    if (inOnline)       ringColor = COL_ONLINE;
    else if (inOffline) ringColor = COL_OFFLINE;
    else                ringColor = COL_BG;
  }

  color = mix(color, ringColor, ringMask);

  float borderMask = smoothstep(OUTER_R - 0.015, OUTER_R - 0.005, d) * (1.0 - smoothstep(OUTER_R, OUTER_R + 0.01, d));
  color = mix(color, COL_BORDER, borderMask * 0.8);

  gl_FragColor = color * outerMask * v_alpha;
}
`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type);
  if (!s) throw new Error("Failed to create shader");
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`Donut shader compile error: ${log ?? "(no log)"}`);
  }
  return s;
}

// Matches the "clusters" circle hit-test layer radius curve
function pixelRadiusForCount(count: number): number {
  const c = Math.max(count, 2);
  if (c <= 10)  return 16 + (22 - 16) * ((c - 2)   / (10 - 2));
  if (c <= 25)  return 22 + (30 - 22) * ((c - 10)  / (25 - 10));
  if (c <= 100) return 30 + (44 - 30) * ((c - 25)  / (100 - 25));
  if (c <= 200) return 44 + (52 - 44) * ((c - 100) / (200 - 100));
  return 52;
}

export class ClusterDonutLayer implements maplibregl.CustomLayerInterface {
  readonly id = "clusters-donuts";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: maplibregl.Map | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private aPos = -1;
  private aUv = -1;
  private aPixelRadius = -1;
  private aRatio = -1;
  private uMatrix: WebGLUniformLocation | null = null;
  private uViewport: WebGLUniformLocation | null = null;
  private uDpr: WebGLUniformLocation | null = null;
  private uAlpha: WebGLUniformLocation | null = null;
  private alpha = 1;
  private vertexCount = 0;
  /** Rebuild vertex buffer at the start of the next render() — rebuilding inside
   *  render() avoids stale features since sourcedata/moveend can fire before tiles re-render. */
  private dirty = true;
  /** Cache of the last queryRenderedFeatures pass — render() rebuilds the GPU
   *  buffer from this each frame with fresh terrain z when terrain is on. */
  private lastClusters: { lng: number; lat: number; r: number; ratio: number; key: string }[] = [];

  /** Per-cluster ratio tween (keyed by rounded position, like the dedupe). */
  private anim = new Map<string, { from: number; to: number; start: number }>();
  private static readonly RATIO_TWEEN_MS = 500;

  private onMoveend: (() => void) | null = null;
  private onIdle: (() => void) | null = null;
  private onSourceData: ((e: maplibregl.MapSourceDataEvent) => void) | null = null;
  private moveendTimer: ReturnType<typeof setTimeout> | null = null;

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext): void {
    this.map = map;
    this.gl = gl;

    const vs = compile(gl, gl.VERTEX_SHADER, VS);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FS);
    const program = gl.createProgram();
    if (!program) throw new Error("Failed to create donut program");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Donut program link error: ${gl.getProgramInfoLog(program) ?? "(no log)"}`);
    }
    this.program = program;
    this.aPos = gl.getAttribLocation(program, "a_pos");
    this.aUv = gl.getAttribLocation(program, "a_uv");
    this.aPixelRadius = gl.getAttribLocation(program, "a_pixelRadius");
    this.aRatio = gl.getAttribLocation(program, "a_ratio");
    this.uMatrix = gl.getUniformLocation(program, "u_matrix");
    this.uViewport = gl.getUniformLocation(program, "u_viewport");
    this.uDpr = gl.getUniformLocation(program, "u_dpr");
    this.uAlpha = gl.getUniformLocation(program, "u_alpha");

    this.buffer = gl.createBuffer();

    const markDirty = () => {
      this.dirty = true;
      map.triggerRepaint();
    };
    // Trailing-debounce moveend (fires many times per zoom/pan); idle catches the settled state.
    this.onMoveend = () => {
      if (this.moveendTimer != null) clearTimeout(this.moveendTimer);
      this.moveendTimer = setTimeout(() => {
        this.moveendTimer = null;
        markDirty();
      }, 120);
    };
    this.onIdle = markDirty;
    this.onSourceData = (e) => {
      if (e.sourceId === "nodes_clustered") {
        // Hide stale donuts while tiles re-render after setData(); render() will rebuild.
        this.vertexCount = 0;
        this.dirty = true;
        map.triggerRepaint();
        return;
      }
      // Kick a repaint when DEM tiles arrive on an idle map; render's per-frame
      // z-refresh picks up the new elevation. No dirty — cluster set is unchanged.
      if (e.sourceId === MAP_STYLE_IDS.terrainSource) {
        map.triggerRepaint();
      }
    };
    map.on("moveend", this.onMoveend);
    map.on("idle", this.onIdle);
    map.on("sourcedata", this.onSourceData);
  }

  onRemove(map: maplibregl.Map, gl: WebGLRenderingContext): void {
    if (this.moveendTimer != null) {
      clearTimeout(this.moveendTimer);
      this.moveendTimer = null;
    }
    if (this.onMoveend) map.off("moveend", this.onMoveend);
    if (this.onIdle) map.off("idle", this.onIdle);
    if (this.onSourceData) map.off("sourcedata", this.onSourceData);
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
    this.buffer = null;
    this.program = null;
    this.gl = null;
    this.map = null;
    this.vertexCount = 0;
    this.onMoveend = null;
    this.onIdle = null;
    this.onSourceData = null;
    this.anim.clear();
  }

  /** Layer-wide opacity multiplier (0..1). Used to dim donuts when an RF tool is active. */
  setAlpha(alpha: number): void {
    const a = Math.max(0, Math.min(1, alpha));
    if (a === this.alpha) return;
    this.alpha = a;
    this.map?.triggerRepaint();
  }

  private rebuild(): void {
    const map = this.map;
    if (!map) return;
    if (!map.getLayer("clusters")) {
      this.lastClusters = [];
      this.vertexCount = 0;
      return;
    }

    const features = map.queryRenderedFeatures({ layers: ["clusters"] });

    // Dedupe by position — cluster_ids can flip across setData calls
    const seen = new Set<string>();
    const next: { lng: number; lat: number; r: number; ratio: number; key: string }[] = [];

    for (const f of features) {
      const coords = (f.geometry as any)?.coordinates;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const lng = coords[0] as number;
      const lat = coords[1] as number;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

      const key = `${Math.round(lng * 1e5)},${Math.round(lat * 1e5)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const count = (f.properties?.point_count as number) ?? 0;
      const online = (f.properties?.onlineCount as number) ?? 0;
      const ratio = count > 0 ? online / count : 0;

      next.push({ lng, lat, r: pixelRadiusForCount(count), ratio, key });
    }

    this.reconcileTweens(next);
    this.lastClusters = next;
    this.uploadVerts();
  }

  /** Start a tween for each cluster whose ratio target changed; prune the rest. */
  private reconcileTweens(next: { ratio: number; key: string }[]): void {
    const now = performance.now();
    const reduce = prefersReducedMotion();
    const live = new Set<string>();
    for (const c of next) {
      live.add(c.key);
      const prev = this.anim.get(c.key);
      if (reduce || !prev) {
        this.anim.set(c.key, { from: c.ratio, to: c.ratio, start: now }); // snap (reduced-motion / first sighting)
      } else if (Math.abs(prev.to - c.ratio) > 0.0005) {
        this.anim.set(c.key, { from: this.evalTween(prev, now), to: c.ratio, start: now });
      }
    }
    for (const k of this.anim.keys()) if (!live.has(k)) this.anim.delete(k);
  }

  private evalTween(a: { from: number; to: number; start: number }, now: number): number {
    if (a.from === a.to) return a.to;
    const t = Math.min(1, Math.max(0, (now - a.start) / ClusterDonutLayer.RATIO_TWEEN_MS));
    return a.from + (a.to - a.from) * (1 - Math.pow(1 - t, 3)); // easeOutCubic
  }

  private hasActiveTween(now: number): boolean {
    for (const a of this.anim.values()) {
      if (a.from !== a.to && now - a.start < ClusterDonutLayer.RATIO_TWEEN_MS) return true;
    }
    return false;
  }

  /** Build verts from `lastClusters` with current terrain elevations and upload. */
  private uploadVerts(): void {
    const map = this.map;
    const gl = this.gl;
    if (!map || !gl || !this.buffer) return;
    if (this.lastClusters.length === 0) { this.vertexCount = 0; return; }

    const terrainEnabled = !!map.getTerrain?.();
    const elevationAt = (lng: number, lat: number): number => {
      if (!terrainEnabled) return 0;
      // Want exaggerated elevation here: mercatorMatrix doesn't scale terrain,
      // so vertex z must already be in the same exaggerated space as the rendered mesh.
      const e = map.queryTerrainElevation?.({ lng, lat });
      return Number.isFinite(e) ? (e as number) : 0;
    };

    // 6 verts/cluster × 7 floats: x, y, z, ux, uy, r, ratio
    const floatsPerVertex = 7;
    const vertsPerCluster = 6;
    const verts = new Float32Array(this.lastClusters.length * vertsPerCluster * floatsPerVertex);

    const corners: [number, number][] = [
      [-1,  1], [-1, -1], [ 1, -1],  // UL, LL, LR
      [-1,  1], [ 1, -1], [ 1,  1],  // UL, LR, UR
    ];

    const now = performance.now();
    let i = 0;
    for (const c of this.lastClusters) {
      const a = this.anim.get(c.key);
      const ratio = a ? this.evalTween(a, now) : c.ratio;
      const mc = maplibregl.MercatorCoordinate.fromLngLat({ lng: c.lng, lat: c.lat }, elevationAt(c.lng, c.lat));
      for (const [ux, uy] of corners) {
        verts[i++] = mc.x;
        verts[i++] = mc.y;
        verts[i++] = mc.z;
        verts[i++] = ux;
        verts[i++] = uy;
        verts[i++] = c.r;
        verts[i++] = ratio;
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    this.vertexCount = this.lastClusters.length * vertsPerCluster;
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.program || !this.buffer) return;

    const now = performance.now();

    // Rebuild inside render() so queryRenderedFeatures sees current tile state
    if (this.dirty) {
      this.rebuild();
      this.dirty = false;
    } else if (this.hasActiveTween(now) || (this.map?.getTerrain?.() && this.lastClusters.length > 0)) {
      // Re-evaluate per frame while a ratio tween runs, or to re-drape on terrain.
      this.uploadVerts();
    }

    if (this.vertexCount === 0) return;

    // Shader expects 0..1 Mercator → clip; the public `modelViewProjectionMatrix`
    // expects coord×worldSize. Internal `mercatorMatrix` has the worldSize baked in.
    const tr = this.map ? (this.map as unknown as { transform?: { mercatorMatrix?: Float32List | number[] } }).transform : undefined;
    const matrix = (tr?.mercatorMatrix ?? options.modelViewProjectionMatrix) as Float32List;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMatrix, false, matrix);
    gl.uniform2f(this.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.uDpr, window.devicePixelRatio || 1);
    gl.uniform1f(this.uAlpha, this.alpha);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    // per-vertex: pos.xyz (12) | uv (8) | pixelRadius (4) | ratio (4) = 28 B
    const stride = 7 * 4;
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aUv);
    gl.vertexAttribPointer(this.aUv, 2, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(this.aPixelRadius);
    gl.vertexAttribPointer(this.aPixelRadius, 1, gl.FLOAT, false, stride, 20);
    gl.enableVertexAttribArray(this.aRatio);
    gl.vertexAttribPointer(this.aRatio, 1, gl.FLOAT, false, stride, 24);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.drawArrays(gl.TRIANGLES, 0, this.vertexCount);

    gl.disableVertexAttribArray(this.aPos);
    gl.disableVertexAttribArray(this.aUv);
    gl.disableVertexAttribArray(this.aPixelRadius);
    gl.disableVertexAttribArray(this.aRatio);

    if (this.hasActiveTween(now)) this.map?.triggerRepaint();
  }
}
