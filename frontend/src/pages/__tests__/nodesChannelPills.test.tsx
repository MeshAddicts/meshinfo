/** Nodes page: channel pills derived from node last_channel data. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The repo .env's relative VITE_API_BASE_URL breaks node's Request; apiSlice
// bakes its baseUrl at import, so the override must run before any import.
vi.hoisted(() => {
  (globalThis as { __env__?: object }).__env__ = {
    VITE_API_BASE_URL: "http://localhost",
  };
});
vi.mock("react-virtuoso", () => ({ Virtuoso: () => null }));

import { Nodes } from "../Nodes";
import {
  cleanup,
  isActivePill,
  mountAt,
  pillButton,
  pillTexts,
  stubApi,
  stubMatchMedia,
} from "./channelPillsHarness";

const PILL_LABELS = ["All", "MediumFast", "LongFast", "SacValley", "Backbone"];

const node = (id: string, last_channel: string) => ({
  id,
  active: true,
  shortname: id.slice(-4),
  longname: `Node ${id}`,
  location: "",
  status: "online",
  last_seen: new Date().toISOString(),
  hardware: null,
  last_channel,
});

// 2 nodes on 77 (MediumFast), 1 on 31 (LongFast), 3 on 112 (custom SacValley).
const nodesFix = {
  aa000001: node("aa000001", "77"),
  aa000002: node("aa000002", "77"),
  aa000003: node("aa000003", "31"),
  aa000004: node("aa000004", "112"),
  aa000005: node("aa000005", "112"),
  aa000006: node("aa000006", "112"),
};

const channelsFix = {
  "31": { name: "LongFast", totalMessages: 10, recentMessages: 10 },
  "77": { name: "MediumFast", totalMessages: 5, recentMessages: 5 },
  "112": { name: "SacValley", totalMessages: 8, recentMessages: 8 },
  "205": { name: "Backbone", totalMessages: 1, recentMessages: 0 },
};

const configFix = (mode?: "presets" | "all" | "manual") => ({
  server: { node_id: "ffffff99" },
  broker: { channels: mode ? { mode } : undefined },
});

describe("Nodes channel pills", () => {
  beforeEach(() => stubMatchMedia());
  afterEach(() => cleanup());

  it("mode=all: presets-first busiest order, wire-name labels, node counts", async () => {
    stubApi({ config: configFix("all"), channels: channelsFix, nodes: nodesFix });
    await mountAt("/nodes", <Nodes />);
    expect(pillTexts(PILL_LABELS)).toEqual([
      ["All", "6"],
      ["MediumFast", "2"],
      ["LongFast", "1"],
      ["SacValley", "3"],
    ]);
    expect(isActivePill(pillButton("All"))).toBe(true);
  });

  it("mode=presets (default) hides custom buckets; All still counts them", async () => {
    stubApi({ config: configFix(), channels: channelsFix, nodes: nodesFix });
    await mountAt("/nodes", <Nodes />);
    expect(pillTexts(PILL_LABELS)).toEqual([
      ["All", "6"],
      ["MediumFast", "2"],
      ["LongFast", "1"],
    ]);
    expect(pillButton("SacValley")).toBeUndefined();
  });

  it("?ch= deep link to a class-hidden bucket still renders its pill, active", async () => {
    stubApi({ config: configFix(), channels: channelsFix, nodes: nodesFix });
    await mountAt("/nodes?ch=sacvalley", <Nodes />);
    expect(pillTexts(PILL_LABELS)).toEqual([
      ["All", "6"],
      ["MediumFast", "2"],
      ["LongFast", "1"],
      ["SacValley", "3"],
    ]);
    expect(isActivePill(pillButton("SacValley"))).toBe(true);
    expect(isActivePill(pillButton("All"))).toBe(false);
  });

  it("?ch= deep link to an out-of-window bucket renders a zero-count pill", async () => {
    stubApi({ config: configFix("all"), channels: channelsFix, nodes: nodesFix });
    await mountAt("/nodes?ch=backbone", <Nodes />);
    const backbone = pillButton("Backbone");
    expect(backbone).toBeDefined();
    expect(isActivePill(backbone)).toBe(true);
    expect(pillTexts(["Backbone"])).toEqual([["Backbone", "0"]]);
  });
});
