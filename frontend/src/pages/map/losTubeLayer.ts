/**
 * 3D LoS "tube" custom layer: GL_LINE_STRIP in Mercator world space,
 * color-coded per vertex (clear/fresnel/blocked). Sits in the depth buffer.
 */
import maplibregl, { type CustomRenderMethodInput } from "maplibre-gl";

import { normalizeLng, shortestLngDelta } from "./geo";

export type LosSegmentColor = "clear" | "fresnel" | "blocked" | "gap";

export interface LosTubePoint {
  lng: number;
  lat: number;
  /** MSL chord altitude (m). */
  altitude: number;
  color: LosSegmentColor;
}

export interface LosTubeData {
  points: LosTubePoint[];
}

const COLOR_CLEAR: [number, number, number] = [0.024, 0.714, 0.831]; // #06b6d4 cyan
const COLOR_FRESNEL: [number, number, number] = [0.976, 0.451, 0.086]; // #f97316 orange
const COLOR_BLOCKED: [number, number, number] = [0.94, 0.27, 0.27]; // #ef4444 red
const COLOR_GAP: [number, number, number] = [0.42, 0.45, 0.5]; // #6b7280 gray — unanalyzed (ghost-hop) leg

function colorFor(cls: LosSegmentColor): [number, number, number] {
  switch (cls) {
    case "clear": return COLOR_CLEAR;
    case "fresnel": return COLOR_FRESNEL;
    case "blocked": return COLOR_BLOCKED;
    case "gap": return COLOR_GAP;
  }
}

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`LoS tube shader compile error: ${log ?? "(no log)"}`);
  }
  return shader;
}

export class LosTubeLayer implements maplibregl.CustomLayerInterface {
  readonly id: string;
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  constructor(id = "los-tube") {
    this.id = id;
  }

  private map: maplibregl.Map | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private aPos = -1;
  private aColor = -1;
  private uMatrix: WebGLUniformLocation | null = null;
  private vertexCount = 0;
  /** Cached raw input (unscaled); re-uploaded with current terrain exaggeration. */
  private lastData: LosTubeData | null = null;

  onAdd(map: maplibregl.Map, gl: WebGLRenderingContext): void {
    this.map = map;
    this.gl = gl;

    const vs = compile(gl, gl.VERTEX_SHADER, `
      attribute vec3 a_pos;
      attribute vec3 a_color;
      uniform mat4 u_matrix;
      varying vec3 v_color;
      void main() {
        gl_Position = u_matrix * vec4(a_pos, 1.0);
        v_color = a_color;
      }
    `);
    const fs = compile(gl, gl.FRAGMENT_SHADER, `
      precision highp float;
      varying vec3 v_color;
      void main() {
        gl_FragColor = vec4(v_color, 0.92);
      }
    `);

    const program = gl.createProgram();
    if (!program) throw new Error("Failed to create WebGL program");
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`LoS tube program link error: ${gl.getProgramInfoLog(program) ?? "(no log)"}`);
    }
    this.program = program;
    this.aPos = gl.getAttribLocation(program, "a_pos");
    this.aColor = gl.getAttribLocation(program, "a_color");
    this.uMatrix = gl.getUniformLocation(program, "u_matrix");

    this.buffer = gl.createBuffer();

    // Re-adding after setStyle: restore the cached geometry, otherwise the tube
    // silently vanishes until the next result push (onRemove keeps lastData).
    this.upload();
  }

  onRemove(_map: maplibregl.Map, gl: WebGLRenderingContext): void {
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
    this.buffer = null;
    this.program = null;
    this.gl = null;
    this.map = null;
    this.vertexCount = 0;
  }

  /** Upload polyline (MSL altitudes, auto-scaled by terrain exaggeration). null clears. */
  setData(data: LosTubeData | null): void {
    this.lastData = data;
    this.upload();
  }

  /** Re-upload cached data against current terrain exaggeration. */
  refresh(): void {
    this.upload();
  }

  private upload(): void {
    const gl = this.gl;
    if (!gl || !this.buffer) return;

    const data = this.lastData;
    if (!data || data.points.length < 2) {
      this.vertexCount = 0;
      this.map?.triggerRepaint();
      return;
    }

    // Lift altitudes into the same exaggerated space as the rendered terrain mesh.
    const exagRaw = this.map?.getTerrain()?.exaggeration;
    const exaggeration = typeof exagRaw === "number" ? exagRaw : 1;

    // [x, y, z, r, g, b] per vertex (Mercator)
    const verts = new Float32Array(data.points.length * 6);
    let i = 0;
    for (const p of data.points) {
      const mc = maplibregl.MercatorCoordinate.fromLngLat(
        { lng: p.lng, lat: p.lat },
        p.altitude * exaggeration,
      );
      const [r, g, b] = colorFor(p.color);
      verts[i++] = mc.x;
      verts[i++] = mc.y;
      verts[i++] = mc.z ?? 0;
      verts[i++] = r;
      verts[i++] = g;
      verts[i++] = b;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    this.vertexCount = data.points.length;
    this.map?.triggerRepaint();
  }

  render(gl: WebGLRenderingContext | WebGL2RenderingContext, options: CustomRenderMethodInput): void {
    if (!this.program || !this.buffer || this.vertexCount < 2) return;

    // See clusterDonutLayer.ts for the mercatorMatrix vs modelViewProjectionMatrix story.
    const tr = this.map ? (this.map as unknown as { transform?: { mercatorMatrix?: Float32List | number[] } }).transform : undefined;
    const matrix = (tr?.mercatorMatrix ?? options.modelViewProjectionMatrix) as Float32List;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMatrix, false, matrix);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    const stride = 6 * 4; // 6 floats × 4 bytes
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(this.aColor);
    gl.vertexAttribPointer(this.aColor, 3, gl.FLOAT, false, stride, 3 * 4);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    // Most browsers clamp to 1, but some drivers honor it
    gl.lineWidth(4);
    gl.drawArrays(gl.LINE_STRIP, 0, this.vertexCount);

    gl.disableVertexAttribArray(this.aPos);
    gl.disableVertexAttribArray(this.aColor);
  }
}

/** Single obstruction hotspot; rendered as a red pylon in 3D. */
export interface ObstructionFeature {
  lng: number;
  lat: number;
  /** Chord MSL (m) = pylon base. */
  baseHeightM: number;
  /** Terrain+bulge MSL (m) = pylon top. */
  topHeightM: number;
  /** top − base (m). */
  violationM: number;
  /** 0-1, normalized to worst obstruction on path. */
  severity: number;
}

/** Pick up to `max` most-severe obstructions, deduped by index gap. */
export function pickObstructions(
  from: [number, number],
  to: [number, number],
  points: Array<{
    distanceKm: number;
    chord: number;
    effectiveGround: number;
    blocked: boolean;
  }>,
  totalDistanceKm: number,
  max = 3,
): ObstructionFeature[] {
  const blocked: Array<{ idx: number; violation: number }> = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (p.blocked) {
      blocked.push({ idx: i, violation: p.effectiveGround - p.chord });
    }
  }
  if (blocked.length === 0) return [];

  // Sort by severity, then greedy-pick with a min gap to avoid clustering on one ridge
  blocked.sort((a, b) => b.violation - a.violation);
  const picked: typeof blocked = [];
  const minGap = Math.max(3, Math.floor(points.length / 20));
  for (const c of blocked) {
    if (picked.every((p) => Math.abs(p.idx - c.idx) > minGap)) {
      picked.push(c);
      if (picked.length >= max) break;
    }
  }
  const worst = blocked[0].violation || 1;

  return picked.map(({ idx, violation }) => {
    const p = points[idx];
    const t = totalDistanceKm > 0 ? p.distanceKm / totalDistanceKm : 0;
    return {
      lng: normalizeLng(from[0] + shortestLngDelta(from[0], to[0]) * t),
      lat: from[1] + (to[1] - from[1]) * t,
      baseHeightM: p.chord,
      topHeightM: p.effectiveGround,
      violationM: violation,
      severity: Math.min(1, violation / worst),
    };
  });
}

/** Obstructions → small-square FeatureCollection for a fill-extrusion layer (baseM/topM). */
export function obstructionsToGeoJSON(
  features: ObstructionFeature[],
  footprintSideM = 60,
): GeoJSON.FeatureCollection<GeoJSON.Polygon, {
  baseM: number;
  topM: number;
  violationM: number;
  severity: number;
}> {
  const feats = features.map((f) => {
    const halfLatDeg = footprintSideM / 2 / 111_000;
    const halfLngDeg =
      footprintSideM / 2 / (111_000 * Math.max(0.05, Math.cos((f.lat * Math.PI) / 180)));
    const coords: GeoJSON.Position[] = [
      [f.lng - halfLngDeg, f.lat - halfLatDeg],
      [f.lng + halfLngDeg, f.lat - halfLatDeg],
      [f.lng + halfLngDeg, f.lat + halfLatDeg],
      [f.lng - halfLngDeg, f.lat + halfLatDeg],
      [f.lng - halfLngDeg, f.lat - halfLatDeg],
    ];
    return {
      type: "Feature" as const,
      geometry: { type: "Polygon" as const, coordinates: [coords] },
      properties: {
        baseM: f.baseHeightM,
        topM: f.topHeightM,
        violationM: f.violationM,
        severity: f.severity,
      },
    };
  });
  return { type: "FeatureCollection", features: feats };
}

/** Tube data from LoSResult points; classifies blocked→red, fresnelIntruded→orange, else→cyan. */
export function losPointsToTubeData(
  from: [number, number],
  to: [number, number],
  points: Array<{
    distanceKm: number;
    chord: number;
    blocked: boolean;
    fresnelIntruded: boolean;
  }>,
  totalDistanceKm: number,
): LosTubeData {
  const tubePoints: LosTubePoint[] = points.map((p) => {
    const t = totalDistanceKm > 0 ? p.distanceKm / totalDistanceKm : 0;
    const lng = normalizeLng(from[0] + shortestLngDelta(from[0], to[0]) * t);
    const lat = from[1] + (to[1] - from[1]) * t;
    const color: LosSegmentColor = p.blocked
      ? "blocked"
      : p.fresnelIntruded
      ? "fresnel"
      : "clear";
    return { lng, lat, altitude: p.chord, color };
  });
  return { points: tubePoints };
}
