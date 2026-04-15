/**
 * Mapbox custom layer that renders a 3D line-of-sight "tube" between two
 * nodes, color-coded by clearance (green=clear, yellow=Fresnel intrusion,
 * red=blocked). Renders in world space so altitudes match terrain.
 *
 * This uses a minimal WebGL pipeline: one GL_LINE_STRIP of vertices in
 * Mercator world coordinates with a per-vertex color attribute. Sits on top
 * of Mapbox's 3D scene and respects the depth buffer.
 *
 * Usage:
 *   const layer = new LosTubeLayer();
 *   map.addLayer(layer);
 *   layer.setData({ points: [...] });
 */
import mapboxgl from "mapbox-gl";

export type LosSegmentColor = "clear" | "fresnel" | "blocked";

export interface LosTubePoint {
  lng: number;
  lat: number;
  /** MSL altitude in meters — the LoS chord at this point. */
  altitude: number;
  color: LosSegmentColor;
}

export interface LosTubeData {
  points: LosTubePoint[];
}

// RGB 0-1 for each classification — mirrors the old LoS panel palette.
const COLOR_CLEAR: [number, number, number] = [0.13, 0.77, 0.37]; // #22c55e
const COLOR_FRESNEL: [number, number, number] = [0.92, 0.70, 0.03]; // #eab308
const COLOR_BLOCKED: [number, number, number] = [0.94, 0.27, 0.27]; // #ef4444

function colorFor(cls: LosSegmentColor): [number, number, number] {
  switch (cls) {
    case "clear": return COLOR_CLEAR;
    case "fresnel": return COLOR_FRESNEL;
    case "blocked": return COLOR_BLOCKED;
  }
}

/** Compile a shader; throw on failure. */
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

export class LosTubeLayer implements mapboxgl.CustomLayerInterface {
  readonly id = "los-tube";
  readonly type = "custom" as const;
  readonly renderingMode = "3d" as const;

  private map: mapboxgl.Map | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private aPos = -1;
  private aColor = -1;
  private uMatrix: WebGLUniformLocation | null = null;
  private vertexCount = 0;
  /**
   * Cached raw input (unscaled altitudes). Kept so we can re-upload with
   * a different terrain exaggeration without the caller having to rebuild
   * the `LosTubeData`. Mapbox renders terrain elevations multiplied by
   * the active exaggeration; a custom 3D layer using raw MSL altitudes
   * would sit *below* the exaggerated terrain surface. Multiplying
   * altitudes by the same exaggeration factor keeps the tube pinned to
   * the visual terrain.
   */
  private lastData: LosTubeData | null = null;

  onAdd(map: mapboxgl.Map, gl: WebGLRenderingContext): void {
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
  }

  onRemove(_map: mapboxgl.Map, gl: WebGLRenderingContext): void {
    if (this.buffer) gl.deleteBuffer(this.buffer);
    if (this.program) gl.deleteProgram(this.program);
    this.buffer = null;
    this.program = null;
    this.gl = null;
    this.map = null;
    this.vertexCount = 0;
  }

  /**
   * Upload a new polyline. `null` or empty list clears the layer.
   * Altitudes are expected in real MSL meters — the layer internally
   * scales them by the map's current terrain exaggeration so the tube
   * lines up with the visually-rendered terrain surface.
   */
  setData(data: LosTubeData | null): void {
    this.lastData = data;
    this.upload();
  }

  /**
   * Re-upload from cached data using the map's current terrain
   * exaggeration. Called externally (Map.tsx effect) when the user
   * changes terrain exaggeration while a LoS result is on screen.
   */
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

    // Mapbox types `exaggeration` as DataDrivenPropertyValueSpecification;
    // coerce to number since we only ever set it to a plain number in
    // Map.tsx's applyTerrainState.
    const exagRaw = this.map?.getTerrain()?.exaggeration;
    const exaggeration = typeof exagRaw === "number" ? exagRaw : 1;

    // Pack interleaved: [x, y, z, r, g, b] per vertex, in Mercator world units.
    const verts = new Float32Array(data.points.length * 6);
    let i = 0;
    for (const p of data.points) {
      const mc = mapboxgl.MercatorCoordinate.fromLngLat(
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

  render(gl: WebGLRenderingContext, matrix: number[]): void {
    if (!this.program || !this.buffer || this.vertexCount < 2) return;

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
    // gl.lineWidth is spec'd to clamp to 1 in most browsers, but it costs
    // nothing to try for drivers that honor it.
    gl.lineWidth(4);
    gl.drawArrays(gl.LINE_STRIP, 0, this.vertexCount);

    gl.disableVertexAttribArray(this.aPos);
    gl.disableVertexAttribArray(this.aColor);
  }
}

/**
 * A single obstruction hotspot — where terrain is above the LoS chord.
 * Rendered as a thin vertical red "pylon" in the 3D map.
 */
export interface ObstructionFeature {
  lng: number;
  lat: number;
  /** Chord altitude (m, MSL) at this point — base of the pylon. */
  baseHeightM: number;
  /** Terrain+bulge altitude (m, MSL) at this point — top of the pylon. */
  topHeightM: number;
  /** Obstruction violation in meters (top − base). */
  violationM: number;
  /** 0–1, normalized against the worst obstruction on this path. */
  severity: number;
}

/**
 * Pick up to `max` obstruction hotspots from an LoS path.
 * Strategy: all "blocked" points, sorted by violation; dedupe nearby picks.
 */
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

  // Sort by severity, then greedily pick items that are at least 5 samples apart
  // so we don't cluster three "peaks" all on the same ridge.
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
      lng: from[0] + (to[0] - from[0]) * t,
      lat: from[1] + (to[1] - from[1]) * t,
      baseHeightM: p.chord,
      topHeightM: p.effectiveGround,
      violationM: violation,
      severity: Math.min(1, violation / worst),
    };
  });
}

/**
 * Convert obstruction features to a GeoJSON FeatureCollection of small square
 * footprints suitable for a `fill-extrusion` layer with base/height pulled
 * from `baseM`/`topM` properties.
 */
export function obstructionsToGeoJSON(
  features: ObstructionFeature[],
  footprintSideM = 40,
): GeoJSON.FeatureCollection<GeoJSON.Polygon, {
  baseM: number;
  topM: number;
  violationM: number;
  severity: number;
}> {
  const feats = features.map((f) => {
    // Offset in degrees — approximate for small footprint sizes.
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

/**
 * Build tube data from an `LoSResult`. Classifies each point by:
 *   - blocked (terrain above chord)      → red
 *   - fresnelIntruded                    → yellow
 *   - otherwise                          → green
 */
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
    const lng = from[0] + (to[0] - from[0]) * t;
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
