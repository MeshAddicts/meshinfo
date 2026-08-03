import { describe, expect, it } from "vitest";

import { buildNeighborEdges, buildTracerouteEdges, mergeEdges } from "./graphEdges";

const VALID = new Set(["0000000a", "0000000d", "000000b1", "000000b2"]);

function keysOf(traceroutes: any[]): string[] {
  return buildTracerouteEdges(traceroutes, VALID)
    .map((e) => `${e.a}~${e.b}`)
    .sort();
}

describe("buildTracerouteEdges", () => {
  it("emits true reply-row legs, not the phantom endpoint edges", () => {
    // Reply for trace O→R1→R2→D: header from=D, to=O, request-ordered route
    const reply = {
      from: "0000000d",
      to: "0000000a",
      route_ids: ["000000b1", "000000b2"],
      payload: { snr_towards: [4, 8, 12] },
      timestamp: 100,
    };
    const keys = keysOf([reply]);
    expect(keys).toEqual(["0000000a~000000b1", "0000000d~000000b2", "000000b1~000000b2"]);
    expect(keys).not.toContain("0000000d~000000b1");
    expect(keys).not.toContain("0000000a~000000b2");
  });

  it("halves edge weight for request+reply captures of one exchange", () => {
    const request = {
      from: "0000000a",
      to: "0000000d",
      route_ids: ["000000b1"],
      payload: { snr_towards: [4] },
      timestamp: 100,
    };
    const reply = {
      from: "0000000d",
      to: "0000000a",
      route_ids: ["000000b1", "000000b2"],
      payload: { snr_towards: [4, 8, 12] },
      timestamp: 110,
    };
    const edges = buildTracerouteEdges([request, reply], VALID);
    for (const e of edges) expect(e.w).toBe(1);
  });

  it("skips the speculative final leg of requests and unresolved/sentinel hops", () => {
    const request = {
      from: "0000000a",
      to: "0000000d",
      route_ids: ["000000b1"],
      payload: { snr_towards: [4] },
      timestamp: 100,
    };
    expect(keysOf([request])).toEqual(["0000000a~000000b1"]);

    const sentinelReply = {
      from: "0000000d",
      to: "0000000a",
      route_ids: ["ffffffff"],
      payload: { snr_towards: [4, 8] },
      timestamp: 100,
    };
    expect(keysOf([sentinelReply])).toEqual([]);
  });

  it("emits the direct edge for a zero-hop reply", () => {
    const zeroHopReply = {
      from: "0000000d",
      to: "0000000a",
      route_ids: [],
      payload: { snr_towards: [5] },
      timestamp: 100,
    };
    expect(keysOf([zeroHopReply])).toEqual(["0000000a~0000000d"]);
  });
});

describe("buildNeighborEdges", () => {
  const mk = (neighbors: any[]) => ({
    "0000000a": { neighborinfo: { neighbors } },
  });

  it("keeps missing SNR undefined instead of coercing to 0 dB", () => {
    const edges = buildNeighborEdges(mk([{ node_id: "0000000b" }]));
    expect(edges[0].snr).toBeUndefined();
  });

  it("max-aggregates over defined readings only", () => {
    const edges = buildNeighborEdges({
      "0000000a": { neighborinfo: { neighbors: [{ node_id: "0000000b", snr: -12.5 }] } },
      "0000000b": { neighborinfo: { neighbors: [{ node_id: "0000000a" }] } },
    });
    // A reading-less report must not override the real -12.5 dB
    expect(edges[0].snr).toBe(-12.5);
  });

  it("preserves a genuine 0 dB reading", () => {
    const edges = buildNeighborEdges(mk([{ node_id: "0000000b", snr: 0 }]));
    expect(edges[0].snr).toBe(0);
  });
});

describe("mergeEdges", () => {
  it("flags dual-evidence links with both kinds", () => {
    const neighbor = [{ a: "0000000a", b: "0000000b", w: 2, kind: "neighbor" as const, snr: -5 }];
    const trace = [{ a: "0000000a", b: "0000000b", w: 3, kind: "traceroute" as const }];
    const merged = mergeEdges(neighbor, trace);
    expect(merged).toHaveLength(1);
    expect(merged[0].hasNeighbor).toBe(true);
    expect(merged[0].hasTraceroute).toBe(true);
    expect(merged[0].w).toBe(5);
  });

  it("single-source edges carry only their own flag", () => {
    const merged = mergeEdges(
      [{ a: "0000000a", b: "0000000b", w: 1, kind: "neighbor" as const }],
      [{ a: "0000000c", b: "0000000d", w: 1, kind: "traceroute" as const }],
    );
    const nb = merged.find((e) => e.a === "0000000a")!;
    const tr = merged.find((e) => e.a === "0000000c")!;
    expect(nb.hasNeighbor).toBe(true);
    expect(nb.hasTraceroute).toBeUndefined();
    expect(tr.hasTraceroute).toBe(true);
    expect(tr.hasNeighbor).toBeUndefined();
  });
});
