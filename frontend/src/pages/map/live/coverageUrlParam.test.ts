import { describe, expect, it } from "vitest";

import {
  coverageGroupCode,
  nextCoverageSearch,
  parseCoverageParam,
} from "./coverageUrlParam";
import {
  LIVE_PRESET_SENSITIVITY_DBM,
  presetShortLabel,
} from "./liveCoveragePresets";

const ALL_PRESETS = Object.keys(LIVE_PRESET_SENSITIVITY_DBM);

describe("parseCoverageParam", () => {
  it("returns null when the param is absent or empty", () => {
    expect(parseCoverageParam("")).toBeNull();
    expect(parseCoverageParam("?lat=37.1&lng=-118.2&z=6")).toBeNull();
    expect(parseCoverageParam("?cov=")).toBeNull();
  });

  it("reads 1 and true (any case) as on with the viewer's own group", () => {
    expect(parseCoverageParam("?cov=1")).toEqual({ enabled: true, group: null });
    expect(parseCoverageParam("?cov=true")).toEqual({ enabled: true, group: null });
    expect(parseCoverageParam("?cov=TRUE")).toEqual({ enabled: true, group: null });
  });

  it("reads 0 and false as off", () => {
    expect(parseCoverageParam("?cov=0")).toEqual({ enabled: false, group: null });
    expect(parseCoverageParam("?cov=false")).toEqual({ enabled: false, group: null });
  });

  it("reads all (any case) as on with every preset shown", () => {
    expect(parseCoverageParam("?cov=all")).toEqual({ enabled: true, group: "all" });
    expect(parseCoverageParam("?cov=ALL")).toEqual({ enabled: true, group: "all" });
  });

  it("reads the documented short codes to their presets", () => {
    const cases: Array<[string, string]> = [
      ["st", "ShortTurbo"],
      ["sf", "ShortFast"],
      ["ss", "ShortSlow"],
      ["mf", "MediumFast"],
      ["ms", "MediumSlow"],
      ["lf", "LongFast"],
      ["lt", "LongTurbo"],
      ["lm", "LongMod"],
      ["ls", "LongSlow"],
    ];
    for (const [code, preset] of cases) {
      expect(parseCoverageParam(`?cov=${code}`)).toEqual({ enabled: true, group: preset });
      expect(parseCoverageParam(`?cov=${code.toUpperCase()}`)).toEqual({
        enabled: true,
        group: preset,
      });
    }
    // The table above must stay exhaustive as presets are added.
    expect(cases.map(([, p]) => p).sort()).toEqual([...ALL_PRESETS].sort());
  });

  it("reads full preset ids in any case", () => {
    for (const preset of ALL_PRESETS) {
      expect(parseCoverageParam(`?cov=${preset}`)).toEqual({ enabled: true, group: preset });
      expect(parseCoverageParam(`?cov=${preset.toLowerCase()}`)).toEqual({
        enabled: true,
        group: preset,
      });
    }
  });

  it("maps legacy alias tokens to their firmware presets", () => {
    // Old shared links wrote the pre-alias spellings/codes; keep them working.
    expect(parseCoverageParam("?cov=vls")).toEqual({ enabled: true, group: "LongFast" });
    expect(parseCoverageParam("?cov=VeryLongSlow")).toEqual({ enabled: true, group: "LongFast" });
    expect(parseCoverageParam("?cov=longmoderate")).toEqual({ enabled: true, group: "LongMod" });
  });

  it("passes unknown groups through raw for server-side validation", () => {
    expect(parseCoverageParam("?cov=SacValley")).toEqual({
      enabled: true,
      group: "SacValley",
    });
  });
});

describe("nextCoverageSearch", () => {
  it("appends the group code when enabling, preserving other params", () => {
    expect(nextCoverageSearch("?lat=37.1&z=6.04", true, "all")).toBe(
      "lat=37.1&z=6.04&cov=all"
    );
    expect(nextCoverageSearch("", true, "MediumFast")).toBe("cov=mf");
  });

  it("leaves pristine URLs alone while off", () => {
    expect(nextCoverageSearch("?lat=37.1", false, "all")).toBeNull();
    expect(nextCoverageSearch("", false, "LongFast")).toBeNull();
  });

  it("flips an existing cov to 0 in place when disabling", () => {
    expect(nextCoverageSearch("?cov=mf&lat=37.1", false, "MediumFast")).toBe(
      "cov=0&lat=37.1"
    );
  });

  it("no-ops when the URL already matches", () => {
    expect(nextCoverageSearch("?cov=all", true, "all")).toBeNull();
    expect(nextCoverageSearch("?cov=mf", true, "MediumFast")).toBeNull();
    expect(nextCoverageSearch("?cov=0", false, "all")).toBeNull();
  });

  it("rewrites legacy 1/true spellings to the group-bearing form", () => {
    expect(nextCoverageSearch("?cov=1", true, "LongFast")).toBe("cov=lf");
    expect(nextCoverageSearch("?cov=true", true, "all")).toBe("cov=all");
    expect(nextCoverageSearch("?cov=false", false, "all")).toBe("cov=0");
  });

  it("changing group while on updates the URL", () => {
    expect(nextCoverageSearch("?cov=lf", true, "MediumSlow")).toBe("cov=ms");
    expect(nextCoverageSearch("?cov=all", true, "ShortFast")).toBe("cov=sf");
  });

  it("emits unknown groups raw", () => {
    expect(nextCoverageSearch("", true, "SacValley")).toBe("cov=SacValley");
  });

  it("round-trips unknown groups with URL-significant characters", () => {
    for (const group of ["Sac Valley", "100%LoRa"]) {
      const written = nextCoverageSearch("", true, group);
      expect(parseCoverageParam(`?${written}`)).toEqual({ enabled: true, group });
    }
  });

  it("round-trips every generatable preset plus all", () => {
    for (const group of ["all", ...ALL_PRESETS]) {
      const written = nextCoverageSearch("", true, group);
      expect(written).toBe(`cov=${coverageGroupCode(group)}`);
      expect(parseCoverageParam(`?${written}`)).toEqual({ enabled: true, group });
      // Codes are stable and unique per preset.
      if (group !== "all") {
        expect(coverageGroupCode(group)).toBe(presetShortLabel(group).toLowerCase());
      }
    }
    const codes = ALL_PRESETS.map(coverageGroupCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
