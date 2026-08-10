import { describe, expect, it } from "vitest";

import type { ITraceroutesResponse } from "../../../types";
import { computeTraceEdgeStats, decodeSnr, findPathsBetween, findRunsBetween } from "./pathAnalysis";

/** Minimal traceroute row; O=0000000a requester, D=0000000d destination. */
function row(overrides: Partial<ITraceroutesResponse>): ITraceroutesResponse {
  return {
    channel: 0,
    from: "0000000a",
    to: "0000000d",
    id: 1,
    payload: { route: [] },
    route: [],
    route_ids: [],
    rssi: -80,
    snr: -5,
    timestamp: 1000,
    type: "traceroute",
    ...overrides,
  } as ITraceroutesResponse;
}

describe("decodeSnr", () => {
  it("decodes ×4 scaling and the -128 sentinel", () => {
    expect(decodeSnr(-29)).toBe(-7.25);
    expect(decodeSnr(0)).toBe(0);
    expect(decodeSnr(-128)).toBeNull();
    expect(decodeSnr(undefined)).toBeNull();
  });
});

describe("findPathsBetween", () => {
  it("orients request rows as from → route → to", () => {
    const paths = findPathsBetween("0000000a", "0000000d", [
      row({ route_ids: ["000000b1", "000000b2"] }),
    ]);
    expect(paths).toHaveLength(1);
    expect(paths[0].hops).toEqual(["0000000a", "000000b1", "000000b2", "0000000d"]);
    expect(paths[0].legSnrDb).toBeUndefined();
  });

  it("orients reply rows (full snr_towards) as to → route → from", () => {
    // Reply for trace O→R1→R2→D: header from=D, to=O; route stays request-order.
    const reply = row({
      from: "0000000d",
      to: "0000000a",
      route_ids: ["000000b1", "000000b2"],
      payload: { route: [], snr_towards: [-29, 8, -128] },
    });
    const paths = findPathsBetween("0000000a", "0000000d", [reply]);
    expect(paths).toHaveLength(1);
    // True travel order O→R1→R2→D, not the scrambled D-header order
    expect(paths[0].hops).toEqual(["0000000a", "000000b1", "000000b2", "0000000d"]);
    expect(paths[0].legSnrDb).toEqual([-7.25, 2, null]);
    expect(paths[0].legSnrReversed).toBe(false);
  });

  it("reverses hops and legs when picked opposite to travel order", () => {
    const reply = row({
      from: "0000000d",
      to: "0000000a",
      route_ids: ["000000b1"],
      payload: { route: [], snr_towards: [-29, 8] },
    });
    const paths = findPathsBetween("0000000d", "0000000a", [reply]);
    expect(paths[0].hops).toEqual(["0000000d", "000000b1", "0000000a"]);
    expect(paths[0].legSnrDb).toEqual([2, -7.25]);
    expect(paths[0].legSnrReversed).toBe(true);
  });

  it("keeps unresolvable hops as placeholders so alignment holds", () => {
    const reply = row({
      from: "0000000d",
      to: "0000000a",
      route_ids: ["Some Longname", "000000b2"] as string[],
      payload: { route: [], snr_towards: [4, 8, 12] },
    });
    const paths = findPathsBetween("0000000a", "0000000d", [reply]);
    expect(paths[0].hops).toHaveLength(4);
    expect(paths[0].legSnrDb).toEqual([1, 2, 3]);
  });

  it("suppresses the truncated request when its reply is present", () => {
    const request = row({
      id: 1,
      route_ids: ["000000b1"],
      payload: { route: [], snr_towards: [4] },
      timestamp: 100,
    });
    const reply = row({
      id: 2,
      from: "0000000d",
      to: "0000000a",
      route_ids: ["000000b1", "000000b2"],
      payload: { route: [], snr_towards: [4, 8, 12] },
      timestamp: 110,
    });
    const paths = findPathsBetween("0000000a", "0000000d", [request, reply]);
    // One path, the full one — no phantom shorter sig from the mid-flight capture
    expect(paths).toHaveLength(1);
    expect(paths[0].hops).toHaveLength(4);
    expect(paths[0].provisional).toBe(false);
  });

  it("ranks newest first with hop count as tiebreak, counting repeats", () => {
    const stale1hop = row({ id: 1, route_ids: [], timestamp: 100 });
    const fresh2hopA = row({ id: 2, route_ids: ["000000b1"], timestamp: 900 });
    const fresh2hopB = row({ id: 3, route_ids: ["000000b1"], timestamp: 950 });
    const paths = findPathsBetween("0000000a", "0000000d", [stale1hop, fresh2hopA, fresh2hopB]);
    expect(paths[0].hops).toEqual(["0000000a", "000000b1", "0000000d"]);
    expect(paths[0].count).toBe(2);
    expect(paths[0].timestamp).toBe(950);
    expect(paths[1].hopCount).toBe(1);
  });
});

describe("computeTraceEdgeStats", () => {
  it("counts undirected edge traversals once per run", () => {
    // Reply rows (full snr_towards) so every leg is observed, not speculative.
    const runs = [
      // O-initiated trace via R1, captured as the reply (header swapped)
      row({
        id: 1,
        from: "0000000d",
        to: "0000000a",
        route_ids: ["000000b1"],
        payload: { route: [], snr_towards: [4, 8] },
        timestamp: 100,
      }),
      // D-initiated trace via R1 — same undirected edges
      row({
        id: 2,
        route_ids: ["000000b1"],
        payload: { route: [], snr_towards: [4, 8] },
        timestamp: 200,
      }),
      // Zero-hop reply: the direct O–D link was genuinely observed
      row({
        id: 3,
        from: "0000000d",
        to: "0000000a",
        route_ids: [],
        payload: { route: [], snr_towards: [5] },
        timestamp: 300,
      }),
    ];
    const stats = computeTraceEdgeStats(runs);
    const byKey = new Map(stats.map((e) => [`${e.aId}|${e.bId}`, e]));
    expect(byKey.get("0000000a|000000b1")?.count).toBe(2);
    expect(byKey.get("0000000d|000000b1")?.count).toBe(2);
    expect(byKey.get("0000000a|0000000d")?.count).toBe(1);
    expect(byKey.get("0000000a|000000b1")?.lastTimestamp).toBe(200);
  });

  it("excludes the speculative final leg of mid-flight request rows", () => {
    // Request heard near the initiator: only O→R1 was actually observed;
    // R1→D is implied by the header. Zero-hop requests contribute nothing.
    const stats = computeTraceEdgeStats([
      row({ id: 1, route_ids: ["000000b1"], payload: { route: [], snr_towards: [4] }, timestamp: 100 }),
      row({ id: 2, route_ids: [], payload: { route: [] }, timestamp: 200 }),
    ]);
    const keys = stats.map((e) => `${e.aId}|${e.bId}`);
    expect(keys).toEqual(["0000000a|000000b1"]);
  });

  it("collapses a request+reply exchange to a single run", () => {
    const request = row({
      id: 1,
      route_ids: ["000000b1"],
      payload: { route: [], snr_towards: [4] },
      timestamp: 100,
    });
    const reply = row({
      id: 2,
      from: "0000000d",
      to: "0000000a",
      route_ids: ["000000b1", "000000b2"],
      payload: { route: [], snr_towards: [4, 8, 12] },
      timestamp: 110,
    });
    const stats = computeTraceEdgeStats([request, reply]);
    const byKey = new Map(stats.map((e) => [`${e.aId}|${e.bId}`, e]));
    expect(byKey.get("0000000a|000000b1")?.count).toBe(1);
    expect(byKey.get("000000b1|000000b2")?.count).toBe(1);
    expect(byKey.get("0000000d|000000b2")?.count).toBe(1);
  });

  it("emits no edges touching the 0xffffffff unknown-hop sentinel", () => {
    const reply = row({
      from: "0000000d",
      to: "0000000a",
      route_ids: ["ffffffff"],
      payload: { route: [], snr_towards: [4, 8] },
    });
    expect(computeTraceEdgeStats([reply])).toEqual([]);
  });

  it("orients reply rows before counting edges (header swap ≠ reversal)", () => {
    // Reply for O→R1→R2→D: header from=D, to=O, request-ordered route
    const reply = row({
      from: "0000000d",
      to: "0000000a",
      route_ids: ["000000b1", "000000b2"],
      payload: { route: [], snr_towards: [4, 8, 12] },
    });
    const stats = computeTraceEdgeStats([reply]);
    const keys = stats.map((e) => `${e.aId}|${e.bId}`).sort();
    // Real legs O–R1, R1–R2, R2–D — not the phantom D–R1 / R2–O
    expect(keys).toEqual(["0000000a|000000b1", "0000000d|000000b2", "000000b1|000000b2"]);
  });

  it("skips edges touching unresolved hops", () => {
    const stats = computeTraceEdgeStats([
      row({ id: 9, route_ids: ["Some Longname"] as string[], timestamp: 50 }),
    ]);
    expect(stats).toEqual([]);
  });
});

describe("findRunsBetween", () => {
  it("collapses request+reply of one exchange and flags request-only runs", () => {
    const request = row({
      id: 1,
      route_ids: ["000000b1"],
      payload: { route: [], snr_towards: [4] },
      timestamp: 100,
    });
    const reply = row({
      id: 2,
      from: "0000000d",
      to: "0000000a",
      route_ids: ["000000b1", "000000b2"],
      payload: { route: [], snr_towards: [4, 8, 12] },
      timestamp: 110,
    });
    const runs = findRunsBetween("0000000a", "0000000d", [request, reply]);
    expect(runs).toHaveLength(1);
    expect(runs[0].provisional).toBe(false);
    expect(runs[0].hops).toEqual(["0000000a", "000000b1", "000000b2", "0000000d"]);

    const requestOnly = findRunsBetween("0000000a", "0000000d", [request]);
    expect(requestOnly).toHaveLength(1);
    expect(requestOnly[0].provisional).toBe(true);
  });

  it("keeps repeated same-role runs (two requests are two attempts)", () => {
    const req1 = row({ id: 1, route_ids: ["000000b1"], timestamp: 100 });
    const req2 = row({ id: 2, route_ids: ["000000b1"], timestamp: 150 });
    expect(findRunsBetween("0000000a", "0000000d", [req1, req2])).toHaveLength(2);
  });

  it("places the unobserved leg by display orientation, not always last", () => {
    // Request A→D via R1: observed leg A–R1, speculative leg R1–D
    const request = row({
      route_ids: ["000000b1"],
      payload: { route: [], snr_towards: [4] },
    });
    // Displayed forward (a=A): speculative leg is the LAST leg
    const fwd = findRunsBetween("0000000a", "0000000d", [request])[0];
    expect(fwd.hops).toEqual(["0000000a", "000000b1", "0000000d"]);
    expect(fwd.provisionalLegIndex).toBe(1);
    // Displayed reversed (a=D): the same speculative leg is now leg 0
    const rev = findRunsBetween("0000000d", "0000000a", [request])[0];
    expect(rev.hops).toEqual(["0000000d", "000000b1", "0000000a"]);
    expect(rev.provisionalLegIndex).toBe(0);
    // Sub-path that stops short of the target contains no speculative leg
    const sub = findRunsBetween("0000000a", "000000b1", [request])[0];
    expect(sub.hops).toEqual(["0000000a", "000000b1"]);
    expect(sub.provisionalLegIndex).toBeNull();
    expect(sub.provisional).toBe(true); // exchange status still request-only
  });
});
