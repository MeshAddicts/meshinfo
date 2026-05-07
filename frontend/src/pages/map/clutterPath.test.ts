/** @vitest-environment node */
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
  it("returns a ClutterScratch with zeroed distance + touched buffers of CLUTTER_SCRATCH_LEN", () => {
    const s = makeClutterScratch();
    expect(s.distances.length).toBe(CLUTTER_SCRATCH_LEN);
    expect(s.touched.length).toBe(CLUTTER_SCRATCH_LEN);
    expect(s.distances.every((v) => v === 0)).toBe(true);
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
    const { profileM, profileClasses } = flatProfile(50, 11);
    const loss = computePathClutterLoss(
      profileM, profileClasses, 50, 200, 5, 5, F_915, 1.0, scratch,
    );
    expect(loss).toBe(0);
  });
});

describe("computePathClutterLoss — endpoint clutter dominates", () => {
  it("matches sum of endpoint terms when both antennas are above evergreen canopy", () => {
    const scratch = makeClutterScratch();
    const { profileM, profileClasses } = flatProfile(80, 42);
    const txAGL = 25;
    const rxAGL = 25;
    const loss = computePathClutterLoss(
      profileM, profileClasses, 80, 100, txAGL, rxAGL, F_915, 1.0, scratch,
    );
    const expected =
      endpointClutterDb(NLCD_CLASSES[42], txAGL, F_915) +
      endpointClutterDb(NLCD_CLASSES[42], rxAGL, F_915);
    expect(loss).toBeCloseTo(expected, 3);
    expect(loss).toBeCloseTo(0, 3);
  });

  it("evergreen handhelds at both ends ≈ 2 × 19.1 dB endpoint, no MED for short paths", () => {
    const scratch = makeClutterScratch();
    // 50 m path with handhelds: endpoint exclusion (d_k=50 m each end) covers
    // nearly the whole profile, so MED contribution is ~0.
    const { profileM, profileClasses } = flatProfile(15, 42);
    const pointSpacingM = 50 / 14;
    const loss = computePathClutterLoss(
      profileM, profileClasses, 15, pointSpacingM, 2, 2, F_915, 1.0, scratch,
    );
    const a = endpointClutterDb(NLCD_CLASSES[42], 2, F_915);
    expect(loss).toBeCloseTo(2 * a, 0);
    expect(loss).toBeGreaterThan(35);
    expect(loss).toBeLessThan(42);
  });
});

describe("computePathClutterLoss — path-integrated MED", () => {
  it("long evergreen path adds ~saturation A on top of endpoint terms", () => {
    const scratch = makeClutterScratch();
    const { profileM, profileClasses } = flatProfile(100, 42);
    const pointSpacingM = 5000 / 99;
    const loss = computePathClutterLoss(
      profileM, profileClasses, 100, pointSpacingM, 2, 2, F_915, 1.0, scratch,
    );
    const aH = endpointClutterDb(NLCD_CLASSES[42], 2, F_915);
    expect(loss).toBeGreaterThan(60);
    expect(loss).toBeLessThan(72);
    expect(loss).toBeCloseTo(2 * aH + 27, 0);
  });

  it("monotonically non-decreasing in path length through forest", () => {
    const scratch = makeClutterScratch();
    let prev = -Infinity;
    for (const n of [10, 20, 50, 100, 200, 500]) {
      const { profileM, profileClasses } = flatProfile(n, 42);
      const loss = computePathClutterLoss(
        profileM, profileClasses, n, 50, 2, 2, F_915, 1.0, scratch,
      );
      expect(loss).toBeGreaterThanOrEqual(prev - 1e-6);
      prev = loss;
    }
  });

  it("mixed-class path: deciduous half + evergreen half, MED summed per class", () => {
    const scratch = makeClutterScratch();
    const N = 100;
    const profileM = new Float64Array(N);
    const profileClasses = new Uint8Array(N);
    for (let i = 0; i < N / 2; i++) profileClasses[i] = 41;
    for (let i = N / 2; i < N; i++) profileClasses[i] = 42;
    const pointSpacingM = 5000 / 99;

    const loss = computePathClutterLoss(
      profileM, profileClasses, N, pointSpacingM, 2, 2, F_915, 1.0, scratch,
    );

    // Each half saturates near A: deciduous A=24 + evergreen A=27 = 51.
    // Endpoints: 2 × ~19.1 ≈ 38. Total ≈ 89 dB.
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
  it("leaves the distances buffer back at zero after each call", () => {
    const scratch = makeClutterScratch();
    const { profileM, profileClasses } = flatProfile(80, 42);
    computePathClutterLoss(profileM, profileClasses, 80, 100, 2, 2, F_915, 1.0, scratch);
    expect(scratch.distances.every((v) => v === 0)).toBe(true);
  });

  it("two back-to-back calls with different classes don't leak distance", () => {
    const scratch = makeClutterScratch();
    const a = flatProfile(80, 42);
    const lossA = computePathClutterLoss(a.profileM, a.profileClasses, 80, 100, 2, 2, F_915, 1.0, scratch);
    const b = flatProfile(80, 41);
    const lossB = computePathClutterLoss(b.profileM, b.profileClasses, 80, 100, 2, 2, F_915, 1.0, scratch);

    const fresh = makeClutterScratch();
    const lossBFresh = computePathClutterLoss(b.profileM, b.profileClasses, 80, 100, 2, 2, F_915, 1.0, fresh);
    expect(lossB).toBeCloseTo(lossBFresh, 6);
    expect(lossA).not.toBe(lossB);
  });
});

describe("computePathClutterLoss — asymmetric endpoint exclusion", () => {
  it("uses each endpoint's own d_k, not max(tx, rx)", () => {
    // TX evergreen (d_k=50 m), RX dense urban (d_k=20 m), forest interior, 10 m spacing.
    // Symmetric max() would skip 5 samples each end; asymmetric correctly skips 5/2,
    // yielding 4 forest samples (40 m → 17.4 dB MED) instead of 1 (10 m → 6.2 dB).
    const scratch = makeClutterScratch();
    const N = 11;
    const profileM = new Float64Array(N);
    const profileClasses = new Uint8Array(N).fill(42);
    profileClasses[N - 1] = 24;

    const loss = computePathClutterLoss(
      profileM, profileClasses, N, 10, 2, 2, F_915, 1.0, scratch,
    );
    expect(loss).toBeGreaterThan(53);
    expect(loss).toBeLessThan(60);
  });
});

describe("computePathClutterLoss — raw nodata id=0 canonicalizes to default class", () => {
  it("interleaved nodata + literal 43 yields the same result as uniform 43", () => {
    const scratch = makeClutterScratch();
    const N = 50;
    const profileM = new Float64Array(N);
    const profileClasses = new Uint8Array(N);
    for (let i = 0; i < N; i++) profileClasses[i] = i % 2 === 0 ? 0 : 43;

    const lossInterleaved = computePathClutterLoss(
      profileM, profileClasses, N, 100, 2, 2, F_915, 1.0, scratch,
    );
    const allMixed = new Uint8Array(N).fill(43);
    const lossUniform = computePathClutterLoss(
      profileM, allMixed, N, 100, 2, 2, F_915, 1.0, scratch,
    );
    expect(lossInterleaved).toBeCloseTo(lossUniform, 5);
  });
});

describe("computePathClutterLoss — z_path above canopy on tall terrain", () => {
  it("excludes samples where the lerp'd path is above the local canopy", () => {
    const scratch = makeClutterScratch();
    // Two 100 m hilltops with a 0 m forested valley between. Antennas at 2 m AGL
    // on the hills → z_path ~102 m, well above the 20 m valley canopy → no MED.
    const N = 50;
    const profileM = new Float64Array(N);
    profileM[0] = 100;
    profileM[N - 1] = 100;
    for (let i = 1; i < N - 1; i++) profileM[i] = 0;
    const profileClasses = new Uint8Array(N).fill(42);
    const loss = computePathClutterLoss(
      profileM, profileClasses, N, 200, 2, 2, F_915, 1.0, scratch,
    );

    const expected =
      2 * vegetationPathLossDb(NLCD_CLASSES[42], 0) +
      2 * endpointClutterDb(NLCD_CLASSES[42], 2, F_915);
    expect(loss).toBeCloseTo(expected, 0);
  });
});
