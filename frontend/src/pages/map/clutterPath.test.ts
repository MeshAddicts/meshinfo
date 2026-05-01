/**
 * Tests for computePathClutterLoss — the orchestration that combines P.452 endpoint
 * clutter with P.833 path-integrated vegetation.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";

import {
  endpointClutterDb,
  NLCD_CLASSES,
  vegetationPathLossDb,
} from "./clutterClasses";
import {
  CLUTTER_SCRATCH_LEN,
  computePathClutterLoss,
  makeClutterScratch,
} from "./clutterPath";

const F_915 = 915;

/**
 * Build a flat-terrain profile of N samples with one constant class everywhere.
 * Returns (profileM, profileClasses).
 */
function flatProfile(
  n: number,
  classId: number,
  groundM: number = 0,
): { profileM: Float64Array; profileClasses: Uint8Array } {
  const profileM = new Float64Array(n).fill(groundM);
  const profileClasses = new Uint8Array(n).fill(classId);
  return { profileM, profileClasses };
}

describe("makeClutterScratch", () => {
  it("returns a Float32Array of CLUTTER_SCRATCH_LEN zeros", () => {
    const s = makeClutterScratch();
    expect(s.length).toBe(CLUTTER_SCRATCH_LEN);
    expect(s.every((v) => v === 0)).toBe(true);
  });
});

describe("computePathClutterLoss — degenerate cases", () => {
  it("returns 0 for nSamples < 2", () => {
    const scratch = makeClutterScratch();
    const { profileM, profileClasses } = flatProfile(1, 42);
    expect(
      computePathClutterLoss(profileM, profileClasses, 1, 100, 2, 2, F_915, 1.0, scratch),
    ).toBe(0);
  });

  it("returns 0 for pointSpacingM ≤ 0", () => {
    const scratch = makeClutterScratch();
    const { profileM, profileClasses } = flatProfile(50, 42);
    expect(
      computePathClutterLoss(profileM, profileClasses, 50, 0, 2, 2, F_915, 1.0, scratch),
    ).toBe(0);
  });
});

describe("computePathClutterLoss — water path (non-clutter everywhere)", () => {
  it("≈ 0 dB for an open-water path with above-water antennas", () => {
    const scratch = makeClutterScratch();
    const { profileM, profileClasses } = flatProfile(50, 11); // class 11 = Open Water
    const loss = computePathClutterLoss(
      profileM, profileClasses, 50, 200, 5, 5, F_915, 1.0, scratch,
    );
    expect(loss).toBe(0);
  });
});

describe("computePathClutterLoss — endpoint clutter dominates", () => {
  // Path above canopy → no MED; loss should equal endpoint A_h_tx + A_h_rx.
  it("matches sum of endpoint terms when both antennas are above evergreen canopy", () => {
    const scratch = makeClutterScratch();
    const { profileM, profileClasses } = flatProfile(80, 42); // evergreen everywhere
    const txAGL = 25; // above 20 m canopy
    const rxAGL = 25;
    const loss = computePathClutterLoss(
      profileM, profileClasses, 80, 100, txAGL, rxAGL, F_915, 1.0, scratch,
    );
    const expected =
      endpointClutterDb(NLCD_CLASSES[42], txAGL, F_915) +
      endpointClutterDb(NLCD_CLASSES[42], rxAGL, F_915);
    // Tower above canopy → both endpoint terms clamp to 0.
    expect(loss).toBeCloseTo(expected, 3);
    expect(loss).toBeCloseTo(0, 3);
  });

  it("evergreen handhelds at both ends ≈ 2 × 19.1 dB endpoint, no MED for short paths", () => {
    const scratch = makeClutterScratch();
    // Short path (50 m) with handheld antennas — endpoint exclusion (skip d_k=50 m at each end)
    // covers nearly the whole profile, so MED contribution is ~0.
    const { profileM, profileClasses } = flatProfile(15, 42);
    const pointSpacingM = 50 / 14; // 50 m total / 14 spacings
    const loss = computePathClutterLoss(
      profileM, profileClasses, 15, pointSpacingM, 2, 2, F_915, 1.0, scratch,
    );
    const a = endpointClutterDb(NLCD_CLASSES[42], 2, F_915);
    expect(loss).toBeCloseTo(2 * a, 0); // endpoint × 2
    expect(loss).toBeGreaterThan(35); // ~38 dB
    expect(loss).toBeLessThan(42);
  });
});

describe("computePathClutterLoss — path-integrated MED", () => {
  it("long evergreen path adds ~saturation A on top of endpoint terms", () => {
    const scratch = makeClutterScratch();
    // 5 km path, 100 samples, handhelds (2 m). Endpoint clutter ~19.1 each end;
    // path integration through 4900 m of penetrable canopy saturates at A=27 dB.
    const { profileM, profileClasses } = flatProfile(100, 42);
    const pointSpacingM = 5000 / 99;
    const loss = computePathClutterLoss(
      profileM, profileClasses, 100, pointSpacingM, 2, 2, F_915, 1.0, scratch,
    );
    const aH = endpointClutterDb(NLCD_CLASSES[42], 2, F_915);
    // 2 endpoints + saturated MED ≈ 2·19.1 + 27 ≈ 65 dB
    expect(loss).toBeGreaterThan(60);
    expect(loss).toBeLessThan(72);
    // Concretely: endpoint × 2 + saturated A
    expect(loss).toBeCloseTo(2 * aH + 27, 0);
  });

  it("monotonically non-decreasing in path length through forest", () => {
    const scratch = makeClutterScratch();
    let prev = -Infinity;
    for (const n of [10, 20, 50, 100, 200, 500]) {
      const { profileM, profileClasses } = flatProfile(n, 42);
      const pointSpacingM = 50; // 50 m steps
      const loss = computePathClutterLoss(
        profileM, profileClasses, n, pointSpacingM, 2, 2, F_915, 1.0, scratch,
      );
      expect(loss).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = loss;
    }
  });

  it("mixed-class path: deciduous half + evergreen half, MED summed per class", () => {
    const scratch = makeClutterScratch();
    const N = 100;
    const profileM = new Float64Array(N); // flat
    const profileClasses = new Uint8Array(N);
    for (let i = 0; i < N / 2; i++) profileClasses[i] = 41;        // deciduous
    for (let i = N / 2; i < N; i++) profileClasses[i] = 42;        // evergreen
    const pointSpacingM = 5000 / 99; // 5 km

    const loss = computePathClutterLoss(
      profileM, profileClasses, N, pointSpacingM, 2, 2, F_915, 1.0, scratch,
    );

    // Each half ≈ 2.5 km of penetrable canopy — both saturate near their A.
    // Deciduous A=24, evergreen A=27 → MED ≈ 24 + 27 = 51.
    // Endpoint at TX (deciduous, 2m) ~19.1; at RX (evergreen, 2m) ~19.1.
    // Total ≈ 19.1 + 19.1 + 51 ≈ 89 dB.
    expect(loss).toBeGreaterThan(85);
    expect(loss).toBeLessThan(93);
  });
});

describe("computePathClutterLoss — aggression scaler", () => {
  it("0× zeros out the result", () => {
    const scratch = makeClutterScratch();
    const { profileM, profileClasses } = flatProfile(80, 42);
    const loss = computePathClutterLoss(
      profileM, profileClasses, 80, 100, 2, 2, F_915, 0, scratch,
    );
    expect(loss).toBe(0);
  });

  it("scales the total linearly", () => {
    const scratch = makeClutterScratch();
    const { profileM, profileClasses } = flatProfile(80, 42);
    const at1 = computePathClutterLoss(
      profileM, profileClasses, 80, 100, 2, 2, F_915, 1.0, scratch,
    );
    const at07 = computePathClutterLoss(
      profileM, profileClasses, 80, 100, 2, 2, F_915, 0.7, scratch,
    );
    const at13 = computePathClutterLoss(
      profileM, profileClasses, 80, 100, 2, 2, F_915, 1.3, scratch,
    );
    expect(at07).toBeCloseTo(at1 * 0.7, 5);
    expect(at13).toBeCloseTo(at1 * 1.3, 5);
  });
});

describe("computePathClutterLoss — scratch buffer hygiene", () => {
  it("leaves scratch back at zero after each call (O(touched) reset)", () => {
    const scratch = makeClutterScratch();
    const { profileM, profileClasses } = flatProfile(80, 42);
    computePathClutterLoss(profileM, profileClasses, 80, 100, 2, 2, F_915, 1.0, scratch);
    expect(scratch.every((v) => v === 0)).toBe(true);
  });

  it("two back-to-back calls with different classes don't leak distance", () => {
    const scratch = makeClutterScratch();
    // Call 1: evergreen
    const a = flatProfile(80, 42);
    const lossA = computePathClutterLoss(a.profileM, a.profileClasses, 80, 100, 2, 2, F_915, 1.0, scratch);
    // Call 2: deciduous (different class). If scratch leaked, the result would
    // include accumulated evergreen distance.
    const b = flatProfile(80, 41);
    const lossB = computePathClutterLoss(b.profileM, b.profileClasses, 80, 100, 2, 2, F_915, 1.0, scratch);

    // Independent: rerun call 2 with a fresh scratch and compare.
    const fresh = makeClutterScratch();
    const lossBFresh = computePathClutterLoss(b.profileM, b.profileClasses, 80, 100, 2, 2, F_915, 1.0, fresh);
    expect(lossB).toBeCloseTo(lossBFresh, 6);
    expect(lossA).not.toBe(lossB);
  });
});

describe("computePathClutterLoss — z_path above canopy on tall terrain", () => {
  it("excludes samples where the lerp'd path is above the local canopy", () => {
    const scratch = makeClutterScratch();
    // Path between two 100 m hilltops, with a 0 m valley in the middle.
    // Even though the valley is forested, the antennas are at 2 m AGL on hills,
    // so z_path well above the valley canopy for all but the endpoints.
    const N = 50;
    const profileM = new Float64Array(N);
    profileM[0] = 100;
    profileM[N - 1] = 100;
    for (let i = 1; i < N - 1; i++) profileM[i] = 0; // deep valley
    const profileClasses = new Uint8Array(N).fill(42);
    const pointSpacingM = 200;
    const lossWithCanopyMask = computePathClutterLoss(
      profileM, profileClasses, N, pointSpacingM, 2, 2, F_915, 1.0, scratch,
    );

    // Endpoints (at 2m AGL on 100m hills) → 100m+2m=102m antenna MSL each end.
    // Valley canopy top = 0 + 20 = 20 m. Path z(s=middle) ≈ 102 m → above canopy → no MED.
    // So MED contribution should be ~0; total ≈ 2 × endpoint clutter (each end is forest h=2).
    const expected = 2 * vegetationPathLossDb(NLCD_CLASSES[42], 0)
      + 2 * /* hilltop forest endpoint */
        endpointClutterDb(NLCD_CLASSES[42], 2, F_915);
    expect(lossWithCanopyMask).toBeCloseTo(expected, 0);
  });
});
