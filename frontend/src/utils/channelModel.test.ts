import { describe, expect, it } from "vitest";

import { buildChannelModel } from "./channelModel";

const WIRE = {
  "8": "LongFast",
  "31": "MediumFast",
  "120": "Test",
  "2": "Test",
  "43": "SVComm",
};
const COUNTS: Record<string, number> = {
  "31": 500,
  "8": 300,
  "120": 60,
  "43": 10,
  "2": 1,
  "0": 7,
};
const IDS = Object.keys(COUNTS);

describe("buildChannelModel", () => {
  it("orders presets first, busiest first, stable id tiebreak", () => {
    const m = buildChannelModel({
      ids: IDS, mode: "all", meta: undefined, wireNames: WIRE, counts: COUNTS,
    });
    expect(m.entries.map((e) => e.id)).toEqual(["31", "8", "120", "43", "0", "2"]);
    expect(m.entries[0].group).toBe("presets");
    expect(m.defaultId).toBe("31");
  });

  it("presets mode hides custom buckets except the selected one", () => {
    const m = buildChannelModel({
      ids: IDS, mode: "presets", meta: undefined, wireNames: WIRE,
      counts: COUNTS, selectedId: "120",
    });
    expect(m.entries.map((e) => e.id)).toEqual(["31", "8", "120"]);
    expect(m.byId.get("120")!.group).toBe("custom");
  });

  it("classifies on wire name; meta label is display-only", () => {
    const m = buildChannelModel({
      ids: ["120"], mode: "all",
      meta: { "120": { label: "MediumFast" } }, // cosmetic rename
      wireNames: WIRE, counts: COUNTS,
    });
    expect(m.entries[0].group).toBe("custom");
    expect(m.entries[0].label).toBe("MediumFast");
  });

  it("first-wins aliases: the busier of two same-named channels owns the slug", () => {
    const m = buildChannelModel({
      ids: IDS, mode: "all", meta: undefined, wireNames: WIRE, counts: COUNTS,
    });
    expect(m.resolveKey("test")).toBe("120");
    expect(m.resolveKey("Test")).toBe("120");
    // The loser still resolves by id.
    expect(m.resolveKey("2")).toBe("2");
  });

  it("ids are pre-claimed: a channel wire-named '8' cannot steal ?ch=8", () => {
    const m = buildChannelModel({
      ids: ["8", "99"], mode: "all", meta: undefined,
      wireNames: { "8": "LongFast", "99": "8" },
      counts: { "8": 1, "99": 500 },
    });
    expect(m.resolveKey("8")).toBe("8");
  });

  it("reserves 'all' and its prefix foldings", () => {
    const m = buildChannelModel({
      ids: ["7"], mode: "all", meta: undefined,
      wireNames: { "7": "AllStars" }, counts: { "7": 5 },
    });
    expect(m.resolveKey("allstars")).toBeUndefined();
    expect(m.resolveKey("all")).toBeUndefined();
  });

  it("labels fall back meta > wire > Channel N", () => {
    const m = buildChannelModel({
      ids: ["8", "50"], mode: "all",
      meta: { "8": { label: "Primary", short: "P1" } },
      wireNames: { "8": "LongFast" }, counts: { "8": 2, "50": 1 },
    });
    expect(m.byId.get("8")!.label).toBe("Primary");
    expect(m.byId.get("8")!.short).toBe("P1");
    expect(m.byId.get("50")!.label).toBe("Channel 50");
  });

  it("breaks exact count ties by numeric-aware id order", () => {
    // Pill order and tied-label alias winners must be deterministic.
    const m = buildChannelModel({
      ids: ["31", "9", "110"], mode: "all", meta: undefined,
      wireNames: { "31": "MediumFast", "9": "LongFast", "110": "LongMod" },
      counts: { "31": 5, "9": 5, "110": 5 },
    });
    expect(m.entries.map((e) => e.id)).toEqual(["9", "31", "110"]);
  });

  it("keeps the preset/custom boundary on a cross-group count tie", () => {
    const m = buildChannelModel({
      ids: ["8", "120"], mode: "all", meta: undefined,
      wireNames: { "8": "LongFast", "120": "Test" },
      counts: { "8": 5, "120": 5 },
    });
    expect(m.entries.map((e) => e.id)).toEqual(["8", "120"]);
    expect(m.entries.map((e) => e.group)).toEqual(["presets", "custom"]);
  });

  it("resolves via meta.short and supports function-form counts", () => {
    const m = buildChannelModel({
      ids: ["8", "31"], mode: "all",
      meta: { "8": { label: "Primary", short: "PRI" } },
      wireNames: { "8": "LongFast", "31": "MediumFast" },
      counts: (id) => (id === "31" ? 10 : 2),
    });
    expect(m.resolveKey("pri")).toBe("8");
    expect(m.defaultId).toBe("31");
  });

  it("arbitrates duplicate labels by count even for zero-count union members", () => {
    // An out-of-window twin (count 0) must not steal the slug from the
    // in-window channel, but must still resolve by its id.
    const m = buildChannelModel({
      ids: ["120", "2"], mode: "all", meta: undefined,
      wireNames: { "120": "Test", "2": "Test" },
      counts: { "120": 40 }, // "2" absent -> 0
    });
    expect(m.resolveKey("test")).toBe("120");
    expect(m.resolveKey("2")).toBe("2");
  });

  it("presets-mode defaultId is the busiest VISIBLE entry, not the global busiest", () => {
    const m = buildChannelModel({
      ids: ["8", "120"], mode: "presets", meta: undefined,
      wireNames: { "8": "LongFast", "120": "Test" },
      counts: { "8": 10, "120": 900 }, // custom out-busies every preset
    });
    expect(m.entries.map((e) => e.id)).toEqual(["8"]);
    expect(m.defaultId).toBe("8");
  });

  it("empty input yields an empty model", () => {
    const m = buildChannelModel({
      ids: [], mode: "presets", meta: undefined, wireNames: {}, counts: {},
    });
    expect(m.entries).toEqual([]);
    expect(m.defaultId).toBeUndefined();
    expect(m.resolveKey("8")).toBeUndefined();
  });
});
