/**
 * ITM (Longley-Rice) WASM correctness suite. Skips all tests if WASM isn't built.
 * See wasm/itm/README.md for build instructions.
 *
 * @vitest-environment node
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  Climate,
  computeP2PLoss,
  isItmAvailable,
  ITM_SUCCESS,
  ITM_SUCCESS_WITH_WARNINGS,
  type P2PInput,
  Polarization,
} from "./itm";

/**
 * Default-ish set of inputs for a "typical" Meshtastic link. Individual
 * tests override just the fields they care about so each case stays
 * small and the reader sees what the test is actually perturbing.
 *
 * Note on antenna heights: when antennas are low (say 10m/2m) over flat
 * terrain, ITM correctly enters plane-earth / two-ray propagation mode
 * rather than free-space mode — ground reflection dominates and the
 * frequency/distance scaling relationships change (e.g. plane-earth loss
 * is frequency-independent, and scales as 40·log(d) not 20·log(d)).
 * We use higher antennas (100m) to keep the scaling tests in the
 * free-space regime where their assertions are meaningful.
 */
const baseInput: P2PInput = {
  txHeightM: 100,
  rxHeightM: 100,
  profileM: flatProfile(50), // 50 samples (see helper below)
  pointSpacingM: 200, // 50 × 200m = 10 km
  climate: Climate.ContinentalTemperate,
  surfaceRefractivityN: 301,
  freqMhz: 915,
  polarization: Polarization.Vertical,
  groundDielectric: 15,
  groundConductivity: 0.005,
  time: 50,
  location: 50,
  situation: 50,
};

/** Flat-earth terrain profile with `n` samples, all at sea level. */
function flatProfile(n: number): Float64Array {
  return new Float64Array(n); // all zeros
}

/**
 * Free-space path loss for a quick analytical comparison.
 * FSPL (dB) = 20·log10(d_km) + 20·log10(f_mhz) + 32.45
 */
function freeSpaceLossDb(distanceKm: number, freqMhz: number): number {
  return 20 * Math.log10(distanceKm) + 20 * Math.log10(freqMhz) + 32.45;
}

// ---------------------------------------------------------------------------
// Availability gate — skip the whole suite if the WASM wasn't built
// ---------------------------------------------------------------------------

let wasmBuilt = false;
beforeAll(async () => {
  wasmBuilt = await isItmAvailable();
  if (!wasmBuilt) {
     
    console.warn(
      "[itm.test] WASM not built — skipping correctness suite. " +
        "Run `yarn build:wasm` to enable.",
    );
  }
});

afterAll(() => {
  // Nothing to clean up — the module is a process-wide singleton and
  // Vitest tears the worker down at exit.
});

describe("itm WASM module", () => {
  // Helper: wrap `it` so each case is automatically skipped when WASM
  // isn't built. Keeps the suite green in fresh checkouts.
  const itWhenBuilt = (name: string, fn: () => Promise<void> | void) => {
    it(name, async () => {
      if (!wasmBuilt) return;
      await fn();
    });
  };

  itWhenBuilt("loads and runs without throwing", async () => {
    const result = await computeP2PLoss(baseInput);
    expect([ITM_SUCCESS, ITM_SUCCESS_WITH_WARNINGS]).toContain(result.returnCode);
    expect(Number.isFinite(result.lossDb)).toBe(true);
  });

  itWhenBuilt("reports free-space-ish loss for elevated antennas over 10km", async () => {
    const result = await computeP2PLoss(baseInput);
    const fspl = freeSpaceLossDb(10, 915); // ~111.7 dB
    // With 100m antennas and a 10km path, ITM stays in the LoS regime
    // where total ≈ FSPL + small corrections. Tolerance ±10 dB handles
    // earth-curvature and small variability adjustments.
    expect(result.lossDb).toBeGreaterThan(fspl - 5);
    expect(result.lossDb).toBeLessThan(fspl + 15);
  });

  itWhenBuilt("distance doubling adds ~6 dB in free-space regime", async () => {
    // Two paths: 10 km and 20 km, both flat with high antennas → LoS
    // regime where 20·log(d) applies and doubling d adds ~6 dB.
    const p10 = await computeP2PLoss({
      ...baseInput,
      pointSpacingM: 200, // 10 km
    });
    const p20 = await computeP2PLoss({
      ...baseInput,
      pointSpacingM: 400, // 20 km
    });
    const delta = p20.lossDb - p10.lossDb;
    // Band allows for earth-bulge corrections at 20km; free-space is 6 dB.
    expect(delta).toBeGreaterThan(4);
    expect(delta).toBeLessThan(12);
  });

  itWhenBuilt("frequency doubling adds ~6 dB in free-space regime", async () => {
    const p915 = await computeP2PLoss({ ...baseInput, freqMhz: 915 });
    const p1830 = await computeP2PLoss({ ...baseInput, freqMhz: 1830 });
    const delta = p1830.lossDb - p915.lossDb;
    // In LoS regime with elevated antennas, FSPL dominates → +6 dB.
    expect(delta).toBeGreaterThan(3);
    expect(delta).toBeLessThan(9);
  });

  itWhenBuilt("adding a 500m ridge increases loss substantially", async () => {
    // 10km path, flat except a ridge bump at the midpoint. Use LOW
    // antennas here (2m/2m) so the chord is near ground level and the
    // ridge really does obstruct it.
    const n = 50;
    const flat = flatProfile(n);
    const withRidge = new Float64Array(flat);
    withRidge[Math.floor(n / 2)] = 500; // 500m peak mid-path

    const lowAntInput: P2PInput = { ...baseInput, txHeightM: 2, rxHeightM: 2 };
    const flatResult = await computeP2PLoss({
      ...lowAntInput,
      profileM: flat,
      pointSpacingM: 200,
    });
    const ridgeResult = await computeP2PLoss({
      ...lowAntInput,
      profileM: withRidge,
      pointSpacingM: 200,
    });
    // A 500m ridge looming over a chord at 2m altitude is a huge
    // obstruction at 915 MHz. Diffraction loss should be tens of dB.
    expect(ridgeResult.lossDb).toBeGreaterThan(flatResult.lossDb + 10);
  });

  itWhenBuilt("intermediate values populate plausibly", async () => {
    const result = await computeP2PLoss(baseInput);
    const fspl = freeSpaceLossDb(10, 915);
    // Distance should round to 10 km (within PFL quantization).
    expect(result.intermediate.distanceKm).toBeCloseTo(10, 0);
    // aFreeSpaceDb is the true free-space portion; should match the
    // analytical formula tightly (<0.5 dB tolerance).
    expect(result.intermediate.aFreeSpaceDb).toBeCloseTo(fspl, 0);
    // aRefDb is the EXCESS attenuation above free space — the
    // deterministic part of the model before variability corrections.
    // Must be non-negative.
    expect(result.intermediate.aRefDb).toBeGreaterThanOrEqual(0);
    // Total loss ≈ aFreeSpace + aRef ± small variability adjustment.
    // TLS 50/50/50 means the median — adjustment should be within a
    // few dB either direction.
    const reconstructed =
      result.intermediate.aFreeSpaceDb + result.intermediate.aRefDb;
    expect(Math.abs(result.lossDb - reconstructed)).toBeLessThan(5);
    // Surface refractivity echoed back as we set it (301 N-units).
    expect(result.intermediate.surfaceRefractivityN).toBeCloseTo(301, 0);
    // Effective heights should be within an order of magnitude of
    // physical antenna heights — if the struct layout is off this would
    // catch it.
    expect(result.intermediate.effectiveHeightM[0]).toBeGreaterThan(0);
    expect(result.intermediate.effectiveHeightM[0]).toBeLessThan(1000);
    expect(result.intermediate.effectiveHeightM[1]).toBeGreaterThan(0);
    expect(result.intermediate.effectiveHeightM[1]).toBeLessThan(1000);
  });
});

/**
 * `cmd_examples/*` regression — present only when the NTIA/itm upstream
 * has been cloned via `fetch-vendor.sh`. The upstream fixtures are
 * authoritative input/output pairs: running identical inputs through our
 * WASM should produce identical loss values to within floating-point
 * tolerance (~1e-4 dB).
 *
 * The exact file format isn't parsed here yet — that's a follow-up once
 * we have a working WASM build and can eyeball the output format. For
 * now this describe block just acts as a placeholder to document intent.
 */
describe.todo("itm cmd_examples bit-exact regression (follow-up)");
