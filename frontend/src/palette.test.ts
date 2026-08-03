import { describe, expect, it } from "vitest";

import { DEFAULT_NODE_COLOR, MAP_ROUTER_COLORS, mbNodeColorExpr, nodeColor, OFFLINE_NODE_COLOR } from "./palette";
import { NodeRole } from "./types";

describe("nodeColor", () => {
  it("colors offline nodes gray regardless of role", () => {
    for (const role of Object.values(NodeRole).filter((v) => typeof v === "number")) {
      expect(nodeColor(role as number, false)).toBe(OFFLINE_NODE_COLOR);
    }
  });

  it("colors online router-family roles blue", () => {
    expect(nodeColor(NodeRole.ROUTER, true)).toBe(MAP_ROUTER_COLORS[NodeRole.ROUTER]);
    expect(nodeColor(NodeRole.ROUTER_CLIENT, true)).toBe(MAP_ROUTER_COLORS[NodeRole.ROUTER_CLIENT]);
    expect(nodeColor(NodeRole.ROUTER_LATE, true)).toBe(MAP_ROUTER_COLORS[NodeRole.ROUTER_LATE]);
  });

  // Issue #559: these roles used to render a gray indistinguishable from offline.
  it("colors every other online role the default green", () => {
    expect(nodeColor(NodeRole.CLIENT_MUTE, true)).toBe(DEFAULT_NODE_COLOR);
    expect(nodeColor(NodeRole.CLIENT_HIDDEN, true)).toBe(DEFAULT_NODE_COLOR);
    expect(nodeColor(NodeRole.REPEATER, true)).toBe(DEFAULT_NODE_COLOR);
    expect(nodeColor(null, true)).toBe(DEFAULT_NODE_COLOR);
    expect(nodeColor(undefined, true)).toBe(DEFAULT_NODE_COLOR);
    expect(nodeColor(999, true)).toBe(DEFAULT_NODE_COLOR);
  });
});

describe("mbNodeColorExpr", () => {
  // The rule is encoded twice — here in the MapLibre DSL and in nodeColor().
  // Nothing but this test keeps the two from drifting apart.
  it("mirrors nodeColor", () => {
    const [op, offlineTest, offlineColor, roleMatch] = mbNodeColorExpr as unknown as [
      string,
      unknown,
      string,
      [string, unknown, ...unknown[]],
    ];

    expect(op).toBe("case");
    expect(offlineTest).toEqual(["!", ["boolean", ["get", "online"], false]]);
    expect(offlineColor).toBe(OFFLINE_NODE_COLOR);

    const [matchOp, matchInput, ...arms] = roleMatch;
    expect(matchOp).toBe("match");
    expect(matchInput).toEqual(["get", "role"]);

    const fallback = arms.pop();
    expect(fallback).toBe(DEFAULT_NODE_COLOR);

    const pairs = Object.fromEntries(
      Array.from({ length: arms.length / 2 }, (_, i) => [arms[i * 2], arms[i * 2 + 1]]),
    );
    expect(pairs).toEqual(
      Object.fromEntries(Object.entries(MAP_ROUTER_COLORS).map(([k, v]) => [Number(k), v])),
    );
  });
});
