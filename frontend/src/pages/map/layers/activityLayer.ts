/** Live packet arcs (comets), origin pulses, and gateway ripples.
 *
 *  Drawn on a dedicated transparent WebGL canvas overlaid on the map — NOT into
 *  the map's own context. A custom layer forcing scene repaints made the whole
 *  basemap (terrain, rasters, every vector layer) re-render at animation rate
 *  for as long as packets flowed; the overlay animates alone at ~30fps for the
 *  cost of one small draw call. The class stays a CustomLayerInterface only so
 *  the map's lifecycle drives it: onAdd/onRemove manage the overlay, and
 *  render() — called exactly when the map itself repaints, i.e. whenever the
 *  camera/terrain actually changed — captures a fresh projection matrix and
 *  redraws the overlay in lockstep. Between map repaints the camera is static,
 *  so the last captured matrix stays valid for the overlay's own rAF loop.
 *
 *  Time-in-shader over a persistent ring buffer; the loop self-stops when idle
 *  or when every live primitive is off screen (spawns and camera moves re-arm
 *  it). Note the overlay composites above ALL map layers (labels, spiderfy
 *  fans included) — acceptable for ephemeral translucent effects; DOM markers
 *  and panels still paint above it. */
import * as maplibregl from "maplibre-gl";
import { type CustomRenderMethodInput } from "maplibre-gl";

type RGB = [number, number, number];
type LngLat = [number, number];

const FLOATS = 11; // pos.xyz | s | t0 | dur | color.rgb | kind | weight
const STRIDE = FLOATS * 4;
const MAX_POINTS = 16_384;
const ARC_SAMPLES = 36;
const SPEED_PX_PER_MS = 0.5; // constant comet speed (~500 css-px/s) at any zoom
const MIN_ARC_MS = 450; // floor so short hops aren't a blink
const MAX_ARC_MS = 3000; // ceiling so cross-screen arcs aren't tedious
const PULSE_MS = 750;
const RIPPLE_MS = 750;
const FRAME_MS = 1000 / 30; // overlay animation cap; cheap, so no idle downshift
const CULL_MARGIN = 0.25; // viewport fraction; generous so nothing pops in at the edge
const MAX_BATCH_POINTS = 2048; // staging capacity for one coalesced flush

const VS = `
attribute vec3 a_pos;
attribute float a_s;
attribute float a_t0;
attribute float a_dur;
attribute vec3 a_color;
attribute float a_kind;    // 0 = arc dot, 1 = ring
attribute float a_weight;

uniform mat4 u_matrix;
uniform float u_now;
uniform float u_dpr;
uniform float u_alpha;

varying float v_alpha;
varying vec3 v_color;
varying float v_kind;

void main() {
  float phase = (u_now - a_t0) / a_dur;
  if (phase < 0.0 || phase > 1.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // offscreen → culled
    gl_PointSize = 0.0;
    v_alpha = 0.0;
    return;
  }

  gl_Position = u_matrix * vec4(a_pos, 1.0);

  float size;
  float alpha;
  if (a_kind < 0.5) {
    // comet: bright head at phase, medium fading trail behind
    float w = mix(0.6, 1.0, a_weight);
    float globalFade = 1.0 - smoothstep(0.85, 1.0, phase);
    float d = phase - a_s;
    float vis = (d >= 0.0 && d <= 0.30) ? (1.0 - d / 0.30) : 0.0;
    size = (2.5 + 5.0 * vis) * w * u_dpr;
    alpha = vis * globalFade * mix(0.5, 1.0, a_weight);
  } else {
    float e = 1.0 - pow(1.0 - phase, 2.0);
    size = mix(6.0, 34.0, e) * u_dpr;
    alpha = (1.0 - phase) * 0.9;
  }

  gl_PointSize = size;
  v_alpha = alpha * u_alpha;
  v_color = a_color;
  v_kind = a_kind;
}
`;

const FS = `
precision mediump float;
varying float v_alpha;
varying vec3 v_color;
varying float v_kind;
void main() {
  if (v_alpha <= 0.01) discard;
  float r = length(gl_PointCoord - vec2(0.5)) * 2.0;
  float a;
  if (v_kind < 0.5) {
    a = 1.0 - smoothstep(0.4, 1.0, r);         // soft dot
  } else {
    a = smoothstep(0.7, 0.85, r) - smoothstep(0.92, 1.0, r); // ring
  }
  // Premultiplied output for the transparent overlay canvas: with straight
  // alpha + (SRC_ALPHA, ONE_MINUS_SRC_ALPHA) the destination alpha lands at
  // alpha^2 and the compositor dims trails to ~alpha^3 of their color.
  float A = a * v_alpha;
  gl_FragColor = vec4(v_color * A, A);
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
    throw new Error(`Activity shader compile error: ${log ?? "(no log)"}`);
  }
  return s;
}

function haversineM(lat0: number, lng0: number, lat1: number, lng1: number): number {
  const R = 6371000;
  const dLat = ((lat1 - lat0) * Math.PI) / 180;
  const dLng = ((lng1 - lng0) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat0 * Math.PI) / 180) * Math.cos((lat1 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Inline Mercator (allocation-free; bit-exact with MercatorCoordinate.fromLngLat).
const PI = Math.PI;
const EARTH_CIRCUMFERENCE = 2 * PI * 6371008.8;
const mercX = (lng: number) => (180 + lng) / 360;
const mercY = (lat: number) => {
  const c = Math.max(-89.9, Math.min(89.9, lat));
  return (180 - (180 / PI) * Math.log(Math.tan(PI / 4 + (c * PI) / 360))) / 360;
};
const mercZ = (alt: number, lat: number) => {
  const c = Math.max(-89.9, Math.min(89.9, lat));
  return alt / (EARTH_CIRCUMFERENCE * Math.cos((c * PI) / 180));
};

export class ActivityLayer implements maplibregl.CustomLayerInterface {
  readonly id = "activity";
  readonly type = "custom" as const;
  readonly renderingMode = "2d" as const;

  private map: maplibregl.Map | null = null;
  /** The overlay's own context — every GL resource below lives here, never in
   *  the map's context. */
  private gl: WebGLRenderingContext | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private cpu = new Float32Array(MAX_POINTS * FLOATS);
  private writeHead = 0;
  private maxExpiry = 0; // performance.now() ms of the last live primitive
  private alpha = 1;
  private repaintHandle: number | null = null;
  private lastDrawTs = 0; // performance.now() of the last overlay draw (fps cap)
  private overlayDirty = false; // overlay canvas holds drawn pixels (needs a clear)
  private liveHigh = 0; // highest written slot + 1; bounds the draw range
  private cameraMoving = false; // movestart..moveend; gates the viewport cull
  /** Last projection matrix captured from a map render. Only changes when the
   *  map repaints (camera/terrain), so it's always current between repaints. */
  private matrix: Float32Array | null = null;
  private onMoveStart: (() => void) | null = null;
  private onMoveEnd: (() => void) | null = null;
  private onResize: (() => void) | null = null;
  /** Live primitives' anchor points (lng/lat) + expiry for the scheduling-time
   *  viewport cull: arc = endpoints + bezier apex, ring = center. */
  private culls: { pts: LngLat[]; expiry: number }[] = [];

  private scratchArc = new Float32Array(ARC_SAMPLES * FLOATS);
  private scratchRing = new Float32Array(FLOATS);
  private stage = new Float32Array(MAX_BATCH_POINTS * FLOATS); // accumulates one flush
  private stageCount = 0;
  private batching = false;

  private aPos = -1;
  private aS = -1;
  private aT0 = -1;
  private aDur = -1;
  private aColor = -1;
  private aKind = -1;
  private aWeight = -1;
  private uMatrix: WebGLUniformLocation | null = null;
  private uNow: WebGLUniformLocation | null = null;
  private uDpr: WebGLUniformLocation | null = null;
  private uAlpha: WebGLUniformLocation | null = null;

  onAdd(map: maplibregl.Map): void {
    this.map = map;

    // Overlay canvas: inserted right after the map's canvas so DOM markers and
    // popups (later siblings in the canvas container) stay above the arcs.
    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.top = "0";
    canvas.style.left = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.pointerEvents = "none";
    const container = map.getCanvasContainer();
    const mapCanvas = map.getCanvas();
    container.insertBefore(canvas, mapCanvas.nextSibling);
    this.canvas = canvas;

    // Premultiplied alpha (the default): the shader emits premultiplied color
    // and the draw blends with (ONE, ONE_MINUS_SRC_ALPHA).
    const gl = canvas.getContext("webgl", {
      alpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "low-power",
    }) as WebGLRenderingContext | null;
    if (!gl) {
      // No overlay context (ancient GPU/blocklist) — arcs are silently absent;
      // the spawn methods all no-op on a null gl.
      console.warn("[Map] Activity overlay context unavailable; live arcs disabled.");
      return;
    }
    this.gl = gl;

    const program = gl.createProgram();
    if (!program) throw new Error("Failed to create activity program");
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Activity program link error: ${gl.getProgramInfoLog(program) ?? "(no log)"}`);
    }
    this.program = program;
    this.aPos = gl.getAttribLocation(program, "a_pos");
    this.aS = gl.getAttribLocation(program, "a_s");
    this.aT0 = gl.getAttribLocation(program, "a_t0");
    this.aDur = gl.getAttribLocation(program, "a_dur");
    this.aColor = gl.getAttribLocation(program, "a_color");
    this.aKind = gl.getAttribLocation(program, "a_kind");
    this.aWeight = gl.getAttribLocation(program, "a_weight");
    this.uMatrix = gl.getUniformLocation(program, "u_matrix");
    this.uNow = gl.getUniformLocation(program, "u_now");
    this.uDpr = gl.getUniformLocation(program, "u_dpr");
    this.uAlpha = gl.getUniformLocation(program, "u_alpha");

    // init all slots dead (culled by the shader)
    for (let i = 0; i < MAX_POINTS; i++) {
      this.cpu[i * FLOATS + 4] = -1e12;
      this.cpu[i * FLOATS + 5] = 1;
    }
    this.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, this.cpu, gl.DYNAMIC_DRAW);

    this.onResize = () => this.resizeCanvas();
    map.on("resize", this.onResize);
    this.resizeCanvas();

    // Camera-motion edges re-arm a loop parked by the viewport cull (jumpTo
    // fires movestart+moveend back to back, so a teleport toward off-screen
    // primitives resumes too). While the camera moves, render() also redraws
    // the overlay per map frame, keeping arcs glued to the basemap.
    this.onMoveStart = () => {
      this.cameraMoving = true;
      if (performance.now() <= this.maxExpiry) this.scheduleNextFrame();
    };
    this.onMoveEnd = () => {
      this.cameraMoving = false;
      if (performance.now() <= this.maxExpiry) this.scheduleNextFrame();
    };
    map.on("movestart", this.onMoveStart);
    map.on("moveend", this.onMoveEnd);
  }

  onRemove(map: maplibregl.Map): void {
    if (this.repaintHandle != null) cancelAnimationFrame(this.repaintHandle);
    this.repaintHandle = null;
    if (this.onMoveStart) map.off("movestart", this.onMoveStart);
    if (this.onMoveEnd) map.off("moveend", this.onMoveEnd);
    if (this.onResize) map.off("resize", this.onResize);
    this.onMoveStart = null;
    this.onMoveEnd = null;
    this.onResize = null;
    this.cameraMoving = false;
    this.culls = [];
    const gl = this.gl;
    if (gl) {
      if (this.buffer) gl.deleteBuffer(this.buffer);
      if (this.program) gl.deleteProgram(this.program);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
    this.canvas?.remove();
    this.canvas = null;
    this.buffer = null;
    this.program = null;
    this.gl = null;
    this.matrix = null;
    this.map = null;
  }

  /** Layer-wide opacity (0..1) — dim while an RF tool is active, like the donut. */
  setAlpha(a: number): void {
    this.alpha = Math.max(0, Math.min(1, a));
    if (performance.now() <= this.maxExpiry) this.scheduleNextFrame();
  }

  private resizeCanvas(): void {
    const map = this.map;
    const canvas = this.canvas;
    const gl = this.gl;
    if (!map || !canvas || !gl) return;
    const mapCanvas = map.getCanvas();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(mapCanvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(mapCanvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  /** The overlay's own animation loop, vsync-aligned via rAF and capped by
   *  frame-skip. Each tick redraws ONLY the overlay canvas — the basemap never
   *  repaints for animation. Parks (no reschedule) while every live primitive
   *  is off screen; spawns and the movestart/moveend handlers re-arm it. */
  private scheduleNextFrame(): void {
    if (this.repaintHandle != null || !this.map || !this.gl) return;
    this.repaintHandle = requestAnimationFrame((ts) => {
      this.repaintHandle = null;
      const now = performance.now();
      if (now > this.maxExpiry) {
        this.clearOverlay(); // last primitive died — leave a clean canvas
        return;
      }
      // render() may have just drawn in lockstep with a map frame.
      if (ts - this.lastDrawTs < FRAME_MS - 1) {
        this.scheduleNextFrame(); // too soon — wait for the next vsync
        return;
      }
      if (!this.cameraMoving && this.allOffscreen(now)) {
        // Park with a clean canvas — the last frame may still show a just-
        // expired on-screen primitive that nothing would otherwise erase.
        this.clearOverlay();
        return;
      }
      this.drawOverlay(now);
      this.scheduleNextFrame();
    });
  }

  /** True when every live primitive's screen bbox misses the viewport plus a
   *  CULL_MARGIN apron (absorbs ring/comet point sizes and arc altitude lift).
   *  Prunes expired entries; early-exits on the first visible primitive. */
  private allOffscreen(now: number): boolean {
    const map = this.map;
    if (!map) return false;
    const culls = this.culls;
    let n = 0;
    for (const c of culls) if (c.expiry > now) culls[n++] = c;
    culls.length = n;
    if (n === 0) return false; // nothing live — the loop's maxExpiry check owns shutdown
    const canvas = map.getCanvas();
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const mx = w * CULL_MARGIN;
    const my = h * CULL_MARGIN;
    for (const c of culls) {
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      for (const pt of c.pts) {
        const p = map.project(pt);
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      if (maxX >= -mx && minX <= w + mx && maxY >= -my && minY <= h + my) return false;
    }
    return true;
  }

  /** Record a primitive for the viewport cull; prunes opportunistically so the
   *  list stays bounded even if the cull never runs (camera moving nonstop). */
  private pushCull(pts: LngLat[], expiry: number): void {
    const culls = this.culls;
    if (culls.length >= 512) {
      const now = performance.now();
      let n = 0;
      for (const c of culls) if (c.expiry > now) culls[n++] = c;
      culls.length = n;
    }
    culls.push({ pts, expiry });
  }

  private elevAt(lng: number, lat: number): number {
    const map = this.map;
    if (!map || !map.getTerrain?.()) return 0;
    const e = map.queryTerrainElevation?.({ lng, lat });
    return Number.isFinite(e) ? (e as number) : 0;
  }

  private writePoints(data: Float32Array, count: number): void {
    const gl = this.gl;
    if (!gl || !this.buffer) return;
    let start = this.writeHead;
    if (start + count > MAX_POINTS) {
      start = 0; // wrap, overwriting oldest
      this.liveHigh = MAX_POINTS; // wrapped: live primitives may occupy any slot
    }
    this.cpu.set(data.subarray(0, count * FLOATS), start * FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, start * STRIDE, data.subarray(0, count * FLOATS));
    this.writeHead = start + count;
    if (this.liveHigh < this.writeHead) this.liveHigh = this.writeHead;
  }

  /** Stage points during a batch (one upload at endBatch); write through otherwise. */
  private emit(data: Float32Array, count: number): void {
    if (!this.batching) {
      this.writePoints(data, count);
      return;
    }
    if ((this.stageCount + count) * FLOATS > this.stage.length) {
      if (this.stageCount > 0) {
        this.writePoints(this.stage, this.stageCount); // stage full → flush, keep batching
        this.stageCount = 0;
      }
      if (count * FLOATS > this.stage.length) {
        this.writePoints(data, count); // single item bigger than stage (shouldn't happen)
        return;
      }
    }
    this.stage.set(data.subarray(0, count * FLOATS), this.stageCount * FLOATS);
    this.stageCount += count;
  }

  /** Coalesce a burst of spawns into one GPU upload (beginBatch … endBatch). */
  beginBatch(): void {
    this.batching = true;
    this.stageCount = 0;
  }

  endBatch(): void {
    if (this.stageCount > 0) {
      this.writePoints(this.stage, this.stageCount);
      this.stageCount = 0;
    }
    this.batching = false;
    this.scheduleNextFrame();
  }

  /** Write one comet segment into the ring at [t0, t0+dur). */
  private writeArc(from: LngLat, to: LngLat, color: RGB, weight: number, t0: number, dur: number): void {
    const [lng0, lat0] = from;
    const [lng1, lat1] = to;
    const e0 = this.elevAt(lng0, lat0);
    const e1 = this.elevAt(lng1, lat1);
    const lift = Math.min(Math.max(haversineM(lat0, lng0, lat1, lng1) * 0.12, 250), 35000);

    const dxl = lng1 - lng0;
    const dyl = lat1 - lat0;
    const len = Math.hypot(dxl, dyl) || 1e-6;
    const bow = 0.18 * len; // horizontal bow so it arcs even top-down
    const lngC = (lng0 + lng1) / 2 + (-dyl / len) * bow;
    const latC = (lat0 + lat1) / 2 + (dxl / len) * bow;
    const altC = (e0 + e1) / 2 + lift;

    const d = this.scratchArc;
    let o = 0;
    for (let i = 0; i < ARC_SAMPLES; i++) {
      const s = i / (ARC_SAMPLES - 1);
      const om = 1 - s;
      const lng = om * om * lng0 + 2 * om * s * lngC + s * s * lng1;
      const lat = om * om * lat0 + 2 * om * s * latC + s * s * lat1;
      const alt = om * om * e0 + 2 * om * s * altC + s * s * e1;
      d[o++] = mercX(lng);
      d[o++] = mercY(lat);
      d[o++] = mercZ(alt, lat);
      d[o++] = s;
      d[o++] = t0;
      d[o++] = dur;
      d[o++] = color[0];
      d[o++] = color[1];
      d[o++] = color[2];
      d[o++] = 0;
      d[o++] = weight;
    }
    this.emit(d, ARC_SAMPLES);
    this.maxExpiry = Math.max(this.maxExpiry, t0 + dur);
    this.pushCull([from, [lngC, latC], to], t0 + dur);
  }

  /** Comet duration from on-screen distance → constant travel speed at any zoom. */
  private arcDur(from: LngLat, to: LngLat): number {
    const map = this.map;
    if (!map) return MIN_ARC_MS;
    const p0 = map.project(from);
    const p1 = map.project(to);
    const px = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    return Math.min(MAX_ARC_MS, Math.max(MIN_ARC_MS, px / SPEED_PX_PER_MS));
  }

  /** from→sender comet + a gateway ripple on arrival. */
  spawnArc(from: LngLat, to: LngLat, color: RGB, weight: number, now: number): void {
    if (!this.gl || !this.buffer) return;
    const dur = this.arcDur(from, to);
    this.writeArc(from, to, color, weight, now, dur);
    this.spawnRing(to, color, now + dur * 0.82, RIPPLE_MS, weight);
    this.scheduleNextFrame();
  }

  /** One comet leg + landing ripple; returns its duration (ms) for camera
   *  choreography. speedScale slows below ambient (0.5 = half speed). */
  spawnLeg(
    from: LngLat,
    to: LngLat,
    color: RGB,
    weight: number,
    now: number,
    opts?: { speedScale?: number; minMs?: number; maxMs?: number; landingRing?: boolean },
  ): number {
    if (!this.gl || !this.buffer) return 0;
    const base = this.arcDur(from, to) / (opts?.speedScale ?? 1);
    const dur = Math.min(opts?.maxMs ?? MAX_ARC_MS, Math.max(opts?.minMs ?? MIN_ARC_MS, base));
    this.writeArc(from, to, color, weight, now, dur);
    // landingRing:false — caller fires its own arrival pulse (two rings read doubled)
    if (opts?.landingRing !== false) this.spawnRing(to, color, now + dur * 0.9, RIPPLE_MS, 0.8);
    this.scheduleNextFrame();
    return dur;
  }

  /** Sequential comet through a resolved multi-hop path (traceroute), hop by hop. */
  spawnPath(points: LngLat[], color: RGB, weight: number, now: number): void {
    if (!this.gl || !this.buffer || points.length === 0) return;
    if (points.length === 1) {
      this.spawnRing(points[0], color, now, PULSE_MS, 1);
      return;
    }
    this.spawnRing(points[0], color, now, PULSE_MS, 1); // origin pulse
    let t0 = now;
    for (let i = 0; i < points.length - 1; i++) {
      const dur = this.arcDur(points[i], points[i + 1]);
      this.writeArc(points[i], points[i + 1], color, weight, t0, dur);
      this.spawnRing(points[i + 1], color, t0 + dur * 0.9, RIPPLE_MS, 0.8); // ping as it lands
      t0 += dur;
    }
    this.scheduleNextFrame();
  }

  spawnPulse(at: LngLat, color: RGB, now: number): void {
    this.spawnRing(at, color, now, PULSE_MS, 1);
  }

  spawnRipple(at: LngLat, color: RGB, now: number): void {
    this.spawnRing(at, color, now, RIPPLE_MS, 1);
  }

  private spawnRing(at: LngLat, color: RGB, t0: number, dur: number, weight: number): void {
    if (!this.gl || !this.buffer) return;
    const alt = this.elevAt(at[0], at[1]);
    const d = this.scratchRing;
    d[0] = mercX(at[0]);
    d[1] = mercY(at[1]);
    d[2] = mercZ(alt, at[1]);
    d[3] = 0;
    d[4] = t0;
    d[5] = dur;
    d[6] = color[0];
    d[7] = color[1];
    d[8] = color[2];
    d[9] = 1;
    d[10] = weight;
    this.emit(d, 1);
    this.maxExpiry = Math.max(this.maxExpiry, t0 + dur);
    this.pushCull([at], t0 + dur);
    this.scheduleNextFrame();
  }

  private clearOverlay(): void {
    const gl = this.gl;
    if (!gl || !this.overlayDirty) return;
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.overlayDirty = false;
  }

  /** One overlay frame: clear + a single POINTS draw over the live range. */
  private drawOverlay(now: number): void {
    const gl = this.gl;
    if (!gl || !this.program || !this.buffer || !this.matrix) return;
    if (gl.isContextLost()) return;
    this.lastDrawTs = now;

    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.overlayDirty = false;
    if (now > this.maxExpiry) return;
    this.overlayDirty = true;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMatrix, false, this.matrix);
    gl.uniform1f(this.uNow, now);
    gl.uniform1f(this.uDpr, window.devicePixelRatio || 1);
    gl.uniform1f(this.uAlpha, this.alpha);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const set = (loc: number, size: number, offset: number) => {
      if (loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, STRIDE, offset);
    };
    set(this.aPos, 3, 0);
    set(this.aS, 1, 12);
    set(this.aT0, 1, 16);
    set(this.aDur, 1, 20);
    set(this.aColor, 3, 24);
    set(this.aKind, 1, 36);
    set(this.aWeight, 1, 40);

    gl.enable(gl.BLEND);
    // Premultiplied source (see FS) — classic "over" operator.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.POINTS, 0, this.liveHigh);

    for (const loc of [this.aPos, this.aS, this.aT0, this.aDur, this.aColor, this.aKind, this.aWeight]) {
      if (loc >= 0) gl.disableVertexAttribArray(loc);
    }
  }

  /** Called by the map only when IT repaints (camera/terrain change). Captures
   *  the fresh projection matrix and redraws the overlay in the same frame so
   *  arcs stay glued to the basemap during pans; draws NOTHING into the map's
   *  own context, and never asks the map to repaint. */
  render(_gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    // 0..1 Mercator → clip (see clusterDonutLayer.ts for the matrix story).
    const src = options.defaultProjectionData.mainMatrix as ArrayLike<number>;
    // Copy — maplibre mutates its matrices between frames.
    if (this.matrix?.length !== 16) this.matrix = new Float32Array(16);
    for (let i = 0; i < 16; i++) this.matrix[i] = src[i];

    const now = performance.now();
    if (now > this.maxExpiry) {
      // Everything died while the loop was parked — a ghost frame could
      // otherwise slide detached over the basemap on the next camera move.
      this.clearOverlay();
      return;
    }
    this.drawOverlay(now);
    this.scheduleNextFrame(); // keep the overlay animating after this map frame
  }
}
