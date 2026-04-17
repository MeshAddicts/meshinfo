/**
 * Custom WebGL layer that renders proportional donut-chart cluster markers.
 *
 * Architecture:
 *   - One quad per cluster, rendered in world space at the cluster's Mercator
 *     coordinates. The quad's screen size is controlled in the vertex shader
 *     via pixel→NDC conversion so donuts stay a fixed size on screen regardless
 *     of zoom or camera pitch (billboarded).
 *   - Fragment shader draws the donut using polar math: distance from center
 *     determines if the pixel is hole / ring / outside; angle determines if
 *     a ring pixel is "online" (green) or "offline" (gray).
 *   - Hit-testing is handled by a companion circle layer ("clusters") — this
 *     layer is visual-only. Counts are drawn by a separate text symbol layer.
 *
 * The buffer rebuilds on `moveend` / `idle`. The vertex shader reads the
 * current pixel→NDC ratio from uniforms every frame, so zoom animations stay
 * smooth without buffer rebuilds.
 */
import mapboxgl from "mapbox-gl";

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VS = `
attribute vec3 a_pos;          // Mercator coordinates of cluster center (x, y, z);
                               // z is altitude in Mercator units so the donut
                               // tracks terrain elevation in 3D views.
attribute vec2 a_uv;           // Local corner [-1, 1] in screen-space (+y = up)
attribute float a_pixelRadius; // Cluster radius in CSS pixels
attribute float a_ratio;       // Online fraction, 0..1

uniform mat4 u_matrix;
uniform vec2 u_viewport;       // Framebuffer width, height in physical pixels
uniform float u_dpr;           // devicePixelRatio (1 on standard displays, 2+ on HiDPI)

varying vec2 v_uv;
varying float v_ratio;

void main() {
  // Project the center into clip space (terrain-aware via a_pos.z).
  vec4 clip = u_matrix * vec4(a_pos, 1.0);

  // Convert CSS-pixel radius to physical pixels, then to NDC.  Without
  // the u_dpr factor, donuts render at 1/DPR their intended size on
  // HiDPI displays while Mapbox's native layers (which DPR-correct
  // automatically) render at full size — causing misalignment.
  vec2 ndcOffset = a_uv * (a_pixelRadius * 2.0 * u_dpr) / u_viewport;
  clip.xy += ndcOffset * clip.w;

  gl_Position = clip;
  v_uv = a_uv;
  v_ratio = a_ratio;
}
`;

const FS = `
precision highp float;
varying vec2 v_uv;
varying float v_ratio;

const float PI  = 3.14159265359;
const float TAU = 6.28318530718;

const float OUTER_R = 0.96;
const float INNER_R = 0.60;
const float EDGE_AA = 0.035;

const vec4 COL_BG      = vec4(0.059, 0.090, 0.164, 0.88);
const vec4 COL_ONLINE  = vec4(0.133, 0.773, 0.369, 1.00);
const vec4 COL_OFFLINE = vec4(0.450, 0.480, 0.530, 0.85);
const vec4 COL_BORDER  = vec4(1.000, 1.000, 1.000, 0.15);

void main() {
  float d = length(v_uv);
  if (d > 1.0) discard;

  // Outer edge anti-aliasing (circle silhouette)
  float outerMask = 1.0 - smoothstep(OUTER_R, OUTER_R + EDGE_AA, d);

  // Start with the glassy dark "hole" fill
  vec4 color = COL_BG;

  // Ring area: smoothly blend from hole into the arc at INNER_R
  float ringMask = smoothstep(INNER_R - EDGE_AA, INNER_R + EDGE_AA, d);

  // Compute angle measured from 12 o'clock, increasing clockwise, in [0, TAU)
  float angle = atan(v_uv.x, v_uv.y);           // 0 at (0, +1); +PI/2 at (+1, 0); etc.
  float cwa   = angle < 0.0 ? angle + TAU : angle;

  // Determine arc color
  vec4 ringColor;
  if (v_ratio >= 0.999) {
    ringColor = COL_ONLINE;
  } else if (v_ratio <= 0.001) {
    ringColor = COL_OFFLINE;
  } else {
    // Small gap between segments for visual separation
    float gap = 0.05; // radians
    float boundary = v_ratio * TAU;
    bool inOnline  = cwa < boundary - gap * 0.5;
    bool inOffline = cwa > boundary + gap * 0.5 && cwa < TAU - gap * 0.5;
    if (inOnline)       ringColor = COL_ONLINE;
    else if (inOffline) ringColor = COL_OFFLINE;
    else                ringColor = COL_BG; // gap (shows through to hole color)
  }

  color = mix(color, ringColor, ringMask);

  // Subtle white outer border
  float borderMask = smoothstep(OUTER_R - 0.015, OUTER_R - 0.005, d) * (1.0 - smoothstep(OUTER_R, OUTER_R + 0.01, d));
  color = mix(color, COL_BORDER, borderMask * 0.8);

  gl_FragColor = color * outerMask;
}
`;

// ---------------------------------------------------------------------------
// Shader helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Size curve — matches the circle hit-test layer radius interpolation
// ---------------------------------------------------------------------------

function pixelRadiusForCount(count: number): number {
  const c = Math.max(count, 2);
  if (c <= 10)  return 16 + (22 - 16) * ((c - 2)   / (10 - 2));
  if (c <= 25)  return 22 + (30 - 22) * ((c - 10)  / (25 - 10));
  if (c <= 100) return 30 + (44 - 30) * ((c - 25)  / (100 - 25));
  if (c <= 200) return 44 + (52 - 44) * ((c - 100) / (200 - 100));
  return 52;
}

// ---------------------------------------------------------------------------
// Layer implementation
// ---------------------------------------------------------------------------

export class ClusterDonutLayer implements mapboxgl.CustomLayerInterface {
  readonly id = "clusters-donuts";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: mapboxgl.Map | null = null;
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
  private vertexCount = 0;
  /**
   * When true, the next render() call will re-query features and rebuild
   * the vertex buffer BEFORE drawing. Rebuilding inside render() guarantees
   * queryRenderedFeatures sees the latest tile state — sourcedata / moveend
   * can fire BEFORE tiles have actually re-rendered, causing rebuild-at-
   * event-time to capture stale features.
   */
  private dirty = true;

  private onMoveend: (() => void) | null = null;
  private onIdle: (() => void) | null = null;
  private onSourceData: ((e: mapboxgl.MapSourceDataEvent) => void) | null = null;
  private moveendTimer: ReturnType<typeof setTimeout> | null = null;

  onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
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

    this.buffer = gl.createBuffer();

    // Mark dirty (rebuild-on-next-render) whenever the view or data changes.
    // Actual rebuild happens in render() where tile state is guaranteed current.
    const markDirty = () => {
      this.dirty = true;
      map.triggerRepaint();
    };
    // `moveend` can fire several times during zoom+pan sequences, each one
    // triggering a `queryRenderedFeatures` + vertex rebuild. `idle` fires
    // shortly after the map settles and catches the same state, so trailing-
    // debouncing `moveend` skips the interim rebuilds without losing
    // correctness. `idle` and `sourcedata` stay immediate — `idle` is the
    // cheap settled-state rebuild, and `sourcedata` hides stale donuts
    // while cluster tiles re-render.
    this.onMoveend = () => {
      if (this.moveendTimer != null) clearTimeout(this.moveendTimer);
      this.moveendTimer = setTimeout(() => {
        this.moveendTimer = null;
        markDirty();
      }, 120);
    };
    this.onIdle = markDirty;
    this.onSourceData = (e) => {
      if (e.sourceId !== "nodes_clustered") return;
      // Hide any stale donuts immediately so phantoms don't linger while
      // tiles re-render after setData().  The next render() will rebuild.
      this.vertexCount = 0;
      this.dirty = true;
      map.triggerRepaint();
    };
    map.on("moveend", this.onMoveend);
    map.on("idle", this.onIdle);
    map.on("sourcedata", this.onSourceData);
  }

  onRemove(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
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
  }

  private rebuild(): void {
    const map = this.map;
    const gl = this.gl;
    if (!map || !gl || !this.buffer) return;
    if (!map.getLayer("clusters")) { this.vertexCount = 0; return; }

    const features = map.queryRenderedFeatures({ layers: ["clusters"] });

    // Terrain-aware elevation. queryTerrainElevation returns null when terrain
    // is disabled — fall back to 0 (sea level) in that case, matching non-3D
    // rendering exactly.
    const terrainEnabled = !!(map as any).getTerrain?.();
    const elevationAt = (lng: number, lat: number): number => {
      if (!terrainEnabled) return 0;
      const e = map.queryTerrainElevation?.({ lng, lat } as any);
      return Number.isFinite(e) ? (e as number) : 0;
    };

    // Dedupe by position — cluster_ids can flip between setData calls
    const seen = new Set<string>();
    type Cluster = { x: number; y: number; z: number; r: number; ratio: number };
    const clusters: Cluster[] = [];

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

      const mc = mapboxgl.MercatorCoordinate.fromLngLat({ lng, lat }, elevationAt(lng, lat));
      clusters.push({
        x: mc.x,
        y: mc.y,
        z: mc.z,
        r: pixelRadiusForCount(count),
        ratio,
      });
    }

    if (clusters.length === 0) { this.vertexCount = 0; return; }

    // 6 vertices per cluster (two triangles), 7 floats per vertex (x, y, z, ux, uy, r, ratio)
    const floatsPerVertex = 7;
    const vertsPerCluster = 6;
    const verts = new Float32Array(clusters.length * vertsPerCluster * floatsPerVertex);

    // Screen-space corner offsets (+y = up / 12 o'clock)
    const corners: [number, number][] = [
      [-1,  1], [-1, -1], [ 1, -1],  // triangle 1: UL, LL, LR
      [-1,  1], [ 1, -1], [ 1,  1],  // triangle 2: UL, LR, UR
    ];

    let i = 0;
    for (const c of clusters) {
      for (const [ux, uy] of corners) {
        verts[i++] = c.x;
        verts[i++] = c.y;
        verts[i++] = c.z;
        verts[i++] = ux;
        verts[i++] = uy;
        verts[i++] = c.r;
        verts[i++] = c.ratio;
      }
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    this.vertexCount = clusters.length * vertsPerCluster;
  }

  render(gl: WebGLRenderingContext, matrix: number[]): void {
    if (!this.program || !this.buffer) return;

    // Rebuild INSIDE render when dirty — guarantees queryRenderedFeatures
    // sees the latest tile state. Rebuilding from event handlers can capture
    // stale features because sourcedata/moveend can fire BEFORE tiles have
    // actually re-rendered.
    if (this.dirty) {
      this.rebuild();
      this.dirty = false;
    }

    if (this.vertexCount === 0) return;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMatrix, false, matrix);
    gl.uniform2f(this.uViewport, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.uniform1f(this.uDpr, window.devicePixelRatio || 1);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    // Layout per vertex: pos.xyz (12) | uv (8) | pixelRadius (4) | ratio (4) = 28 bytes
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
  }
}
