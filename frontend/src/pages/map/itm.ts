/**
 * TypeScript wrapper around the ITM (Longley-Rice) WebAssembly module.
 *
 * The WASM module is produced by `frontend/wasm/itm/build.sh` (see that
 * directory's README for build details). This file provides a typed,
 * ergonomic interface on top of Emscripten's raw C-function bindings.
 *
 * Algorithm reference: NTIA Report 82-100 (Hufford, Longley, Kissick 1982)
 * and the 1985 Hufford algorithm memo. Source: https://github.com/NTIA/itm
 * pinned at tag v1.4 (2021-04-26).
 *
 * The module is lazy-loaded on first use — it's ~150–300 KB (SINGLE_FILE
 * embedded) and we don't want to pay that cost for users who never open
 * the coverage tool.
 */

// Typed import of the Emscripten factory. The actual JS+WASM are produced
// at build time; if they're missing, the build fails with a clear error
// pointing the user at `yarn build:wasm`.
//
// Using a dynamic import (not a top-level `import`) keeps the WASM out of
// the initial bundle; Vite code-splits it into its own chunk.
type ItmFactory = typeof import("../../generated/itm/itm.js").default;

// ---------------------------------------------------------------------------
// Enums (mirror the ITM C API constants from include/itm.h)
// ---------------------------------------------------------------------------

export enum Climate {
  Equatorial = 1,
  ContinentalSubtropical = 2,
  MaritimeTropical = 3,
  Desert = 4,
  ContinentalTemperate = 5,
  MaritimeTemperateOverLand = 6,
  MaritimeTemperateOverSea = 7,
}

export enum Polarization {
  Horizontal = 0,
  Vertical = 1,
}

/**
 * `mdvar` modifier: base mode + optional output-format bits. The NTIA C
 * API packs these together; most callers just want the base mode.
 */
export enum ModeOfVariability {
  SingleMessage = 0,
  IndividualOrAccidental = 1,
  Mobile = 2,
  Broadcast = 3,
}

/**
 * High-level propagation mode reported by ITM's intermediate-values struct.
 * The underlying C enum includes a few more internal states; we collapse
 * them into three user-meaningful buckets.
 */
export enum PropagationMode {
  LineOfSight = "line_of_sight",
  Diffraction = "diffraction",
  Troposcatter = "troposcatter",
}

// ITM return codes. Success = 0; success-with-warnings = 1; errors are
// 1000–1022 per `ERRORS_AND_WARNINGS.md` upstream.
export const ITM_SUCCESS = 0;
export const ITM_SUCCESS_WITH_WARNINGS = 1;

/**
 * Warning bit-field decoded from the `warnings` out-parameter. Matches
 * the bit values defined in NTIA/itm's ERRORS_AND_WARNINGS.md (v1.4).
 */
export enum ItmWarningFlag {
  TxTerminalHeightLow = 0x0001,
  TxTerminalHeightHigh = 0x0002,
  RxTerminalHeightLow = 0x0004,
  RxTerminalHeightHigh = 0x0008,
  FrequencyLow = 0x0010,
  FrequencyHigh = 0x0020,
  SurfaceRefractivityLow = 0x0040,
  SurfaceRefractivityHigh = 0x0080,
  GroundConductivityLow = 0x0100,
  DielectricLow = 0x0200,
  EffectiveHeightLow = 0x0400,
  PathDistanceLow = 0x0800,
  PathDistanceHigh = 0x1000,
  PathDistanceHigher = 0x2000,
  TransHorizonLow = 0x4000,
}

// ---------------------------------------------------------------------------
// Public input/output shapes
// ---------------------------------------------------------------------------

export interface P2PInput {
  /** Transmitter antenna height above ground in meters. Valid 0.5–3000. */
  txHeightM: number;
  /** Receiver antenna height above ground in meters. Valid 0.5–3000. */
  rxHeightM: number;
  /**
   * Terrain profile — elevations in meters at evenly-spaced points along
   * the great-circle path from tx to rx. Index 0 is the tx location,
   * last element is the rx location. Must have at least 2 samples.
   */
  profileM: ArrayLike<number>;
  /** Horizontal spacing between consecutive profile samples, in meters. */
  pointSpacingM: number;
  /** Radio climate region (NTIA classification). */
  climate: Climate;
  /**
   * Surface refractivity at sea level in N-units. Typical values:
   *   300–315 for continental temperate; 360 for maritime tropical.
   * Range 250–400.
   */
  surfaceRefractivityN: number;
  /** Center frequency in MHz. Range 20–20 000. */
  freqMhz: number;
  /** Antenna polarization. ITM only supports H or V (no circular). */
  polarization: Polarization;
  /** Ground dielectric constant (ε_r). Typical ~15 for average ground. */
  groundDielectric: number;
  /** Ground conductivity σ in siemens per meter. Typical ~0.005 S/m. */
  groundConductivity: number;
  /** Variability mode. Default `SingleMessage`. */
  mdvar?: ModeOfVariability;
  /** Percent of time (0–100) — TLS only. Typically 50 for median. */
  time?: number;
  /** Percent of locations (0–100) — TLS only. Typically 50 for median. */
  location?: number;
  /** Percent of situations (0–100) — TLS only. Typically 50. */
  situation?: number;
}

export interface IntermediateValues {
  /** Horizon take-off angles in radians (tx, rx). */
  thetaHorizonRad: [number, number];
  /** Horizon distances in meters (tx, rx). */
  horizonDistanceM: [number, number];
  /** Effective antenna heights in meters (tx, rx). */
  effectiveHeightM: [number, number];
  /** Surface refractivity used (N-units). */
  surfaceRefractivityN: number;
  /** Terrain irregularity Δh in meters. */
  deltaHM: number;
  /** Reference attenuation in dB (propagation loss without variability). */
  aRefDb: number;
  /** Free-space loss in dB at the same distance. */
  aFreeSpaceDb: number;
  /** Great-circle distance in km. */
  distanceKm: number;
  /** Internal ITM mode code — mapped to PropagationMode. */
  mode: PropagationMode;
}

export interface P2PResult {
  /** Basic transmission loss in dB. */
  lossDb: number;
  /** Return code: 0 = success, 1 = success with warnings, ≥1000 = error. */
  returnCode: number;
  /** Decoded warning flags (empty if none). */
  warnings: ItmWarningFlag[];
  /** Intermediate values used internally — good for debug UI + attribution. */
  intermediate: IntermediateValues;
}

// ---------------------------------------------------------------------------
// Lazy module init
// ---------------------------------------------------------------------------

let modulePromise: Promise<ItmModuleLoaded> | null = null;

interface ItmModuleLoaded {
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  /** Fast variant — just returns loss; used by the hot per-pixel loop. */
  _ITM_P2P_TLS: (
    h_tx_m: number, h_rx_m: number, pfl_ptr: number,
    climate: number, n0: number, f_mhz: number, pol: number,
    epsilon: number, sigma: number, mdvar: number,
    time_pct: number, location_pct: number, situation_pct: number,
    a_db_ptr: number, warnings_ptr: number,
  ) => number;
  /** With intermediate struct; used by the diagnostic `computeP2PLoss`. */
  _ITM_P2P_TLS_Ex: (
    h_tx_m: number, h_rx_m: number, pfl_ptr: number,
    climate: number, n0: number, f_mhz: number, pol: number,
    epsilon: number, sigma: number, mdvar: number,
    time_pct: number, location_pct: number, situation_pct: number,
    a_db_ptr: number, warnings_ptr: number, inter_ptr: number,
  ) => number;
  HEAPF64: Float64Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
}

/**
 * Load and cache the ITM WebAssembly module. Safe to call concurrently —
 * all callers await the same promise.
 */
async function loadItm(): Promise<ItmModuleLoaded> {
  if (!modulePromise) {
    modulePromise = (async () => {
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — generated at build time; may not exist in dev until
      // `yarn build:wasm` has been run. See wasm/itm/README.md.
      const { default: createItm } = (await import(
        /* @vite-ignore */ "../../generated/itm/itm.js"
      )) as { default: ItmFactory };
      const mod = await createItm();
      return mod as unknown as ItmModuleLoaded;
    })();
  }
  return modulePromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the PFL (terrain profile) array in the format ITM expects:
 *   pfl[0] = n_points − 1
 *   pfl[1] = point spacing in meters
 *   pfl[2..2+n] = elevations in meters
 *
 * Returns a malloc'd pointer; caller must `_free()` it.
 */
function allocPfl(mod: ItmModuleLoaded, profileM: ArrayLike<number>, spacingM: number): number {
  const n = profileM.length;
  if (n < 2) throw new Error("profile must have ≥2 samples");
  const totalDoubles = 2 + n;
  const ptr = mod._malloc(totalDoubles * 8);
  const idx = ptr / 8; // HEAPF64 is double-indexed
  mod.HEAPF64[idx] = n - 1;
  mod.HEAPF64[idx + 1] = spacingM;
  for (let i = 0; i < n; i++) {
    mod.HEAPF64[idx + 2 + i] = profileM[i];
  }
  return ptr;
}

/** Decode the warnings bitfield to an array of named flags. */
function decodeWarnings(bits: number): ItmWarningFlag[] {
  const out: ItmWarningFlag[] = [];
  for (const value of Object.values(ItmWarningFlag)) {
    if (typeof value !== "number") continue;
    if ((bits & value) !== 0) out.push(value);
  }
  return out;
}

/**
 * NTIA ITM's internal mode codes (from the IntermediateValues struct).
 * These are not publicly documented as enum values in the header, but are
 * well-known from the upstream FORTRAN comments:
 *   0 = single-message/no-mode, 1 = LoS, 2 = diffraction, 3 = troposcatter.
 * We fall back to `LineOfSight` for unknown values rather than throwing.
 */
function decodeMode(code: number): PropagationMode {
  switch (code) {
    case 1: return PropagationMode.LineOfSight;
    case 2: return PropagationMode.Diffraction;
    case 3: return PropagationMode.Troposcatter;
    default: return PropagationMode.LineOfSight;
  }
}

// Layout of the IntermediateValues C struct (from include/itm.h):
//   double theta_hzn[2];         //  0, 8
//   double d_hzn__meter[2];      // 16, 24
//   double h_e__meter[2];        // 32, 40
//   double N_s;                  // 48
//   double delta_h__meter;       // 56
//   double A_ref__db;            // 64
//   double A_fs__db;             // 72
//   double d__km;                // 80
//   int    mode;                 // 88 (padded)
// Total: 96 bytes (with 4-byte int + 4-byte pad = 8 bytes for alignment).
const INTERMEDIATE_STRUCT_SIZE = 96;

function readIntermediate(
  mod: ItmModuleLoaded,
  ptr: number,
): IntermediateValues {
  const f = (offsetBytes: number) => mod.HEAPF64[(ptr + offsetBytes) / 8];
  const i = (offsetBytes: number) => mod.HEAP32[(ptr + offsetBytes) / 4];
  return {
    thetaHorizonRad: [f(0), f(8)],
    horizonDistanceM: [f(16), f(24)],
    effectiveHeightM: [f(32), f(40)],
    surfaceRefractivityN: f(48),
    deltaHM: f(56),
    aRefDb: f(64),
    aFreeSpaceDb: f(72),
    distanceKm: f(80),
    mode: decodeMode(i(88)),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Point-to-point propagation loss via time/location/situation (TLS)
 * variability. This is the "normal" ITM call — it gives you the median
 * expected loss at typical 50/50/50 variability.
 */
export async function computeP2PLoss(input: P2PInput): Promise<P2PResult> {
  const mod = await loadItm();
  const {
    txHeightM, rxHeightM, profileM, pointSpacingM,
    climate, surfaceRefractivityN, freqMhz, polarization,
    groundDielectric, groundConductivity,
    mdvar = ModeOfVariability.SingleMessage,
    time = 50, location = 50, situation = 50,
  } = input;

  const pflPtr = allocPfl(mod, profileM, pointSpacingM);
  const aDbPtr = mod._malloc(8); // double
  const warnPtr = mod._malloc(4); // long (32-bit on WASM)
  const interPtr = mod._malloc(INTERMEDIATE_STRUCT_SIZE);
  // Zero-init the intermediate struct so stale memory doesn't leak in.
  for (let o = 0; o < INTERMEDIATE_STRUCT_SIZE; o += 8) {
    mod.HEAPF64[(interPtr + o) / 8] = 0;
  }

  try {
    const rc = mod._ITM_P2P_TLS_Ex(
      txHeightM, rxHeightM, pflPtr,
      climate, surfaceRefractivityN, freqMhz, polarization,
      groundDielectric, groundConductivity, mdvar,
      time, location, situation,
      aDbPtr, warnPtr, interPtr,
    );
    const lossDb = mod.HEAPF64[aDbPtr / 8];
    const warnBits = mod.HEAP32[warnPtr / 4];
    const intermediate = readIntermediate(mod, interPtr);
    return {
      lossDb,
      returnCode: rc,
      warnings: decodeWarnings(warnBits),
      intermediate,
    };
  } finally {
    mod._free(pflPtr);
    mod._free(aDbPtr);
    mod._free(warnPtr);
    mod._free(interPtr);
  }
}

/**
 * Check whether the WASM module has been built / is loadable. Useful for
 * UI guards — coverage tool can show "model unavailable — run yarn
 * build:wasm" rather than crashing.
 */
export async function isItmAvailable(): Promise<boolean> {
  try {
    await loadItm();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Fast-path context for tight loops (65k+ calls during a coverage render)
// ---------------------------------------------------------------------------

/**
 * Holds the loaded WASM module plus pre-allocated scratch buffers for
 * repeated ITM calls. Allocating + freeing the PFL / output pointers on
 * every pixel is the dominant overhead in a coverage pass; an
 * `ItmContext` amortizes that away.
 *
 * Build with `loadItmContext()`, tear down with `disposeItmContext()`.
 */
export interface ItmContext {
  readonly mod: ItmModuleLoaded;
  /** `_malloc`'d buffer for the PFL array. */
  readonly pflPtr: number;
  /** Maximum PFL payload (elevations) that fits in `pflPtr`. */
  readonly pflCapacity: number;
  /** Output pointer: single double (loss in dB). */
  readonly aDbPtr: number;
  /** Output pointer: long (warning bit-field). */
  readonly warnPtr: number;
}

/**
 * Load the WASM and pre-allocate scratch buffers big enough for
 * `maxProfileSamples` elevations per call. Typical coverage work uses
 * 20–80 samples; 128 gives headroom.
 */
export async function loadItmContext(
  maxProfileSamples = 128,
): Promise<ItmContext> {
  const mod = await loadItm();
  const pflDoubles = 2 + maxProfileSamples;
  const pflPtr = mod._malloc(pflDoubles * 8);
  const aDbPtr = mod._malloc(8);
  const warnPtr = mod._malloc(4);
  return { mod, pflPtr, pflCapacity: maxProfileSamples, aDbPtr, warnPtr };
}

/** Free the scratch buffers. Call when the context is no longer needed. */
export function disposeItmContext(ctx: ItmContext): void {
  ctx.mod._free(ctx.pflPtr);
  ctx.mod._free(ctx.aDbPtr);
  ctx.mod._free(ctx.warnPtr);
}

/**
 * Per-pixel input for `computeP2PLossFast`. Same fields as `P2PInput`
 * but treated as positional for speed; the wrapper rebuilds the PFL
 * in-place each call without reallocation.
 */
export interface FastP2PInput {
  txHeightM: number;
  rxHeightM: number;
  profileM: ArrayLike<number>;
  pointSpacingM: number;
  climate: Climate;
  surfaceRefractivityN: number;
  freqMhz: number;
  polarization: Polarization;
  groundDielectric: number;
  groundConductivity: number;
  mdvar: number;
  time: number;
  location: number;
  situation: number;
}

/**
 * Compute point-to-point loss using a shared context — no async, no
 * allocation. Returns just the loss in dB. Designed for hot loops.
 *
 * The upstream `ITM_P2P_TLS` variant is used (no `_Ex`) because the
 * intermediate values we'd otherwise decode per pixel aren't needed
 * inside a coverage raster loop. If you want them, use the async
 * `computeP2PLoss` instead.
 */
export function computeP2PLossFast(ctx: ItmContext, input: FastP2PInput): number {
  const { mod, pflPtr, aDbPtr, warnPtr, pflCapacity } = ctx;
  const n = input.profileM.length;
  if (n > pflCapacity) {
    throw new Error(
      `profile length ${n} exceeds ItmContext capacity ${pflCapacity}`,
    );
  }
  const idx = pflPtr / 8;
  mod.HEAPF64[idx] = n - 1;
  mod.HEAPF64[idx + 1] = input.pointSpacingM;
  for (let i = 0; i < n; i++) {
    mod.HEAPF64[idx + 2 + i] = input.profileM[i];
  }
  mod._ITM_P2P_TLS(
    input.txHeightM, input.rxHeightM, pflPtr,
    input.climate, input.surfaceRefractivityN,
    input.freqMhz, input.polarization,
    input.groundDielectric, input.groundConductivity,
    input.mdvar,
    input.time, input.location, input.situation,
    aDbPtr, warnPtr,
  );
  return mod.HEAPF64[aDbPtr / 8];
}
