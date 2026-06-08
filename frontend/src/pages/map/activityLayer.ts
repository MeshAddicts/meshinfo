/** WebGL layer for live packet arcs (comets), origin pulses, and gateway ripples.
 *  Time-in-shader over a persistent ring buffer; self-stops when idle. */
import maplibregl, { type CustomRenderMethodInput } from "maplibre-gl";

type RGB = [number, number, number];
type LngLat = [number, number];

const FLOATS = 11; // pos.xyz | s | t0 | dur | color.rgb | kind | weight
const STRIDE = FLOATS * 4;
const MAX_POINTS = 16_384;
const ARC_SAMPLES = 28;
const ARC_MS = 1800;
const SEG_MS = 700; // per-hop comet duration for multi-hop (traceroute) paths
const PULSE_MS = 750;
const RIPPLE_MS = 750;
const FRAME_MS = 1000 / 30; // keep-alive repaint cap (~30fps)

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
    // bright head at phase, fading trail behind
    float trail = 0.32;
    float d = phase - a_s;
    float vis = (d >= 0.0 && d <= trail) ? (1.0 - d / trail) : 0.0;
    float globalFade = 1.0 - smoothstep(0.85, 1.0, phase);
    size = (3.0 + 7.0 * vis) * mix(0.6, 1.0, a_weight) * u_dpr;
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
  gl_FragColor = vec4(v_color, a * v_alpha);
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
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private cpu = new Float32Array(MAX_POINTS * FLOATS);
  private writeHead = 0;
  private maxExpiry = 0; // performance.now() ms of the last live primitive
  private alpha = 1;
  private repaintTimer: ReturnType<typeof setTimeout> | null = null;

  private scratchArc = new Float32Array(ARC_SAMPLES * FLOATS);
  private scratchRing = new Float32Array(FLOATS);

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

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext): void {
    this.map = map;
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
  }

  onRemove(_map: maplibregl.Map, gl: WebGLRenderingContext): void {
    if (this.repaintTimer != null) clearTimeout(this.repaintTimer);
    this.repaintTimer = null;
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
    this.buffer = null;
    this.program = null;
    this.gl = null;
    this.map = null;
  }

  /** Layer-wide opacity (0..1) — dim while an RF tool is active, like the donut. */
  setAlpha(a: number): void {
    this.alpha = Math.max(0, Math.min(1, a));
    this.map?.triggerRepaint();
  }

  /** Request the next animation frame at ~30fps, single timer in flight. */
  private scheduleNextFrame(): void {
    if (this.repaintTimer != null || !this.map) return;
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = null;
      this.map?.triggerRepaint();
    }, FRAME_MS);
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
    if (start + count > MAX_POINTS) start = 0; // wrap, overwriting oldest
    this.cpu.set(data.subarray(0, count * FLOATS), start * FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, start * STRIDE, data.subarray(0, count * FLOATS));
    this.writeHead = start + count;
  }

  /** Write one comet segment (28 samples) into the ring at [t0, t0+dur). */
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
    this.writePoints(d, ARC_SAMPLES);
    this.maxExpiry = Math.max(this.maxExpiry, t0 + dur);
  }

  /** from→sender comet + a gateway ripple on arrival. */
  spawnArc(from: LngLat, to: LngLat, color: RGB, weight: number, now: number): void {
    if (!this.gl || !this.buffer) return;
    this.writeArc(from, to, color, weight, now, ARC_MS);
    this.spawnRing(to, color, now + ARC_MS * 0.82, RIPPLE_MS, weight);
    this.scheduleNextFrame();
  }

  /** Sequential comet through a resolved multi-hop path (traceroute), hop by hop. */
  spawnPath(points: LngLat[], color: RGB, weight: number, now: number): void {
    if (!this.gl || !this.buffer || points.length === 0) return;
    if (points.length === 1) {
      this.spawnRing(points[0], color, now, PULSE_MS, 1);
      return;
    }
    this.spawnRing(points[0], color, now, PULSE_MS, 1); // origin pulse
    for (let i = 0; i < points.length - 1; i++) {
      const t0 = now + i * SEG_MS;
      this.writeArc(points[i], points[i + 1], color, weight, t0, SEG_MS);
      this.spawnRing(points[i + 1], color, t0 + SEG_MS * 0.9, RIPPLE_MS, 0.8); // ping as it lands
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
    this.writePoints(d, 1);
    this.maxExpiry = Math.max(this.maxExpiry, t0 + dur);
    this.scheduleNextFrame();
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.program || !this.buffer) return;
    const now = performance.now();
    if (now > this.maxExpiry) return; // nothing alive → idle (no repaint)

    const tr = (this.map as unknown as { transform?: { mercatorMatrix?: Float32List | number[] } })?.transform;
    const matrix = (tr?.mercatorMatrix ?? options.modelViewProjectionMatrix) as Float32List;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMatrix, false, matrix);
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
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE); // additive glow
    gl.drawArrays(gl.POINTS, 0, MAX_POINTS);

    for (const loc of [this.aPos, this.aS, this.aT0, this.aDur, this.aColor, this.aKind, this.aWeight]) {
      if (loc >= 0) gl.disableVertexAttribArray(loc);
    }

    this.scheduleNextFrame(); // keep animating (~30fps) until maxExpiry
  }
}
