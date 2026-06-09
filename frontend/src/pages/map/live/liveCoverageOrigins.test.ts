import { describe, expect, it } from "vitest";

import { NodeRole } from "../../../types";
import type { IMapNode } from "../types";
import { liveCoverageSignature, selectLiveCoverageNodes } from "./liveCoverageOrigins";
import { LIVE_COVERAGE_MAX_ORIGINS } from "./liveCoverageRoles";

const NOW = Date.parse("2026-06-08T00:00:00Z");
const HOUR = 60 * 60 * 1000;

function mkNode(
  id: string,
  over: Partial<IMapNode> & { map_position?: [number, number]; role?: NodeRole },
): IMapNode {
  return {
    id,
    active: true,
    shortname: id,
    longname: id,
    location: "",
    status: "",
    last_seen: new Date(NOW - HOUR).toISOString(),
    hardware: null,
    online: true,
    ...over,
  } as IMapNode;
}

const INFRA = new Set<NodeRole>([NodeRole.ROUTER, NodeRole.ROUTER_LATE, NodeRole.REPEATER]);

describe("selectLiveCoverageNodes", () => {
  it("keeps only the requested roles", () => {
    const nodes = {
      r: mkNode("r", { role: NodeRole.ROUTER, map_position: [-122, 37] }),
      c: mkNode("c", { role: NodeRole.CLIENT, map_position: [-122.1, 37.1] }),
      rep: mkNode("rep", { role: NodeRole.REPEATER, map_position: [-122.2, 37.2] }),
    };
    const { selected, total } = selectLiveCoverageNodes(nodes, INFRA, NOW);
    expect(selected.map((n) => n.id).sort()).toEqual(["r", "rep"]);
    expect(total).toBe(2);
  });

  it("excludes nodes older than the 4 h recency window", () => {
    const nodes = {
      fresh: mkNode("fresh", {
        role: NodeRole.ROUTER,
        map_position: [-122, 37],
        last_seen: new Date(NOW - 1 * HOUR).toISOString(),
      }),
      stale: mkNode("stale", {
        role: NodeRole.ROUTER,
        map_position: [-122.1, 37],
        last_seen: new Date(NOW - 5 * HOUR).toISOString(),
      }),
    };
    const { selected } = selectLiveCoverageNodes(nodes, INFRA, NOW);
    expect(selected.map((n) => n.id)).toEqual(["fresh"]);
  });

  it("excludes nodes with missing or null-island positions", () => {
    const nodes = {
      ok: mkNode("ok", { role: NodeRole.ROUTER, map_position: [-122, 37] }),
      noPos: mkNode("noPos", { role: NodeRole.ROUTER }),
      nullIsland: mkNode("nullIsland", { role: NodeRole.ROUTER, map_position: [0, 0] }),
    };
    const { selected } = selectLiveCoverageNodes(nodes, INFRA, NOW);
    expect(selected.map((n) => n.id)).toEqual(["ok"]);
  });

  it("caps to the max origin count, keeping the most recent", () => {
    const nodes: Record<string, IMapNode> = {};
    for (let i = 0; i < LIVE_COVERAGE_MAX_ORIGINS + 6; i++) {
      nodes[`n${i}`] = mkNode(`n${i}`, {
        role: NodeRole.ROUTER,
        map_position: [-122 + i * 0.001, 37],
        // higher i = more recent
        last_seen: new Date(NOW - (100 - i) * 1000).toISOString(),
      });
    }
    const { selected, total } = selectLiveCoverageNodes(nodes, INFRA, NOW);
    expect(total).toBe(LIVE_COVERAGE_MAX_ORIGINS + 6);
    expect(selected.length).toBe(LIVE_COVERAGE_MAX_ORIGINS);
    // the oldest (n0) must have been dropped
    expect(selected.some((n) => n.id === "n0")).toBe(false);
  });

  it("drops a geographic outlier beyond the span cap", () => {
    const nodes = {
      a: mkNode("a", { role: NodeRole.ROUTER, map_position: [-122, 37] }),
      b: mkNode("b", { role: NodeRole.ROUTER, map_position: [-122.05, 37.02] }),
      c: mkNode("c", { role: NodeRole.ROUTER, map_position: [-122.02, 37.05] }),
      far: mkNode("far", { role: NodeRole.ROUTER, map_position: [-116, 37] }), // ~530 km east
    };
    const { selected, total } = selectLiveCoverageNodes(nodes, INFRA, NOW);
    expect(total).toBe(4);
    expect(selected.some((n) => n.id === "far")).toBe(false);
    expect(selected.length).toBe(3);
  });
});

describe("liveCoverageSignature", () => {
  const base = {
    a: mkNode("a", { role: NodeRole.ROUTER, map_position: [-122, 37] }),
    b: mkNode("b", { role: NodeRole.REPEATER, map_position: [-122.1, 37.1] }),
  };
  const roles = [NodeRole.ROUTER, NodeRole.REPEATER];

  it("is stable across last_seen churn (no rebuild on re-heard)", () => {
    const s1 = liveCoverageSignature(selectLiveCoverageNodes(base, INFRA, NOW).selected, roles);
    const churned = {
      a: mkNode("a", {
        role: NodeRole.ROUTER,
        map_position: [-122, 37],
        last_seen: new Date(NOW - 2 * HOUR).toISOString(),
      }),
      b: mkNode("b", {
        role: NodeRole.REPEATER,
        map_position: [-122.1, 37.1],
        last_seen: new Date(NOW - 0.5 * HOUR).toISOString(),
      }),
    };
    const s2 = liveCoverageSignature(selectLiveCoverageNodes(churned, INFRA, NOW).selected, roles);
    expect(s2).toBe(s1);
  });

  it("changes when a position moves meaningfully", () => {
    const s1 = liveCoverageSignature(selectLiveCoverageNodes(base, INFRA, NOW).selected, roles);
    const moved = {
      ...base,
      a: mkNode("a", { role: NodeRole.ROUTER, map_position: [-122.5, 37] }),
    };
    const s2 = liveCoverageSignature(selectLiveCoverageNodes(moved, INFRA, NOW).selected, roles);
    expect(s2).not.toBe(s1);
  });

  it("changes when the role set changes", () => {
    const selected = selectLiveCoverageNodes(base, INFRA, NOW).selected;
    const s1 = liveCoverageSignature(selected, [NodeRole.ROUTER, NodeRole.REPEATER]);
    const s2 = liveCoverageSignature(selected, [NodeRole.ROUTER]);
    expect(s2).not.toBe(s1);
  });
});
