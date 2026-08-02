import { describe, expect, it } from "vitest";

import {
  canonicalPairKey,
  decodeSnr,
  dedupeExchanges,
  hasFullTraceroutePayload,
  isResolvedHop,
  orientTraceroute,
  tracerouteRichness,
  type TracerouteRowLike,
} from "./traceroute";

/** Trace A → R1 → R2 → D captured as the REQUEST packet mid-flight (route
 *  accumulated up to R1; snr_towards has one entry per observed leg). */
const requestRow = (over: Partial<TracerouteRowLike> = {}): TracerouteRowLike => ({
  from: "000000aa",
  to: "000000dd",
  route_ids: ["000000b1"],
  payload: { route: [0xb1], snr_towards: [-29] },
  timestamp: 1000,
  id: 1,
  ...over,
});

/** The matching REPLY packet: header endpoints swapped, route request-ordered
 *  and complete, snr_towards = route + 1 (destination appended its reading). */
const replyRow = (over: Partial<TracerouteRowLike> = {}): TracerouteRowLike => ({
  from: "000000dd",
  to: "000000aa",
  route_ids: ["000000b1", "000000b2"],
  payload: { route: [0xb1, 0xb2], snr_towards: [-29, 8, 12] },
  timestamp: 1010,
  id: 2,
  ...over,
});

describe("orientTraceroute", () => {
  it("walks request rows header from → route → to", () => {
    const o = orientTraceroute(requestRow())!;
    expect(o.orderedPath).toEqual(["000000aa", "000000b1", "000000dd"]);
    expect(o.initiator).toBe("000000aa");
    expect(o.target).toBe("000000dd");
    expect(o.isReply).toBe(false);
    expect(o.provisional).toBe(true);
  });

  it("swaps reply-row headers without reversing the route", () => {
    const o = orientTraceroute(replyRow())!;
    expect(o.orderedPath).toEqual(["000000aa", "000000b1", "000000b2", "000000dd"]);
    expect(o.initiator).toBe("000000aa");
    expect(o.target).toBe("000000dd");
    expect(o.isReply).toBe(true);
    expect(o.provisional).toBe(false);
  });

  it("decodes reply per-leg SNR aligned to orderedPath legs", () => {
    const o = orientTraceroute(replyRow())!;
    expect(o.legSnrDb).toEqual([-7.25, 2, 3]);
  });

  it("keeps request partial SNR for observed legs, null for the final leg", () => {
    const o = orientTraceroute(requestRow())!;
    expect(o.legSnrDb).toEqual([-7.25, null]);
  });

  it("treats an snr_towards length mismatch as an unusable request", () => {
    const o = orientTraceroute(requestRow({ payload: { route: [0xb1], snr_towards: [1, 2, 3, 4] } }))!;
    expect(o.isReply).toBe(false);
    expect(o.legSnrDb).toBeUndefined();
  });

  it("keeps unresolvable hops as ?-placeholders so alignment holds", () => {
    const o = orientTraceroute(replyRow({ route_ids: ["000000b1", "Some Longname"] }))!;
    expect(o.orderedPath).toEqual(["000000aa", "000000b1", "some longname", "000000dd"]);
    expect(o.legSnrDb).toHaveLength(3);
  });

  it("pads raw-int hops to canonical 8-hex", () => {
    const o = orientTraceroute(requestRow({ route_ids: [0x0165ec15] }))!;
    expect(o.orderedPath[1]).toBe("0165ec15");
  });

  it("returns null when an endpoint is missing", () => {
    expect(orientTraceroute({ from: "000000aa", route_ids: [] })).toBeNull();
    expect(orientTraceroute(null)).toBeNull();
  });

  it("handles the skinny SSE shape (no payload) as a request walk", () => {
    const o = orientTraceroute({ from: "000000dd", to: "000000aa", route_ids: ["000000b1"], id: 9 })!;
    expect(o.orderedPath).toEqual(["000000dd", "000000b1", "000000aa"]);
    expect(o.provisional).toBe(true);
  });
});

describe("isResolvedHop", () => {
  it("accepts bare hex ids and rejects sentinels/placeholders/longnames", () => {
    expect(isResolvedHop("67ea9400")).toBe(true);
    expect(isResolvedHop("ffffffff")).toBe(false); // broadcast / unknown-hop sentinel
    expect(isResolvedHop("?2864434397")).toBe(false);
    expect(isResolvedHop("some longname")).toBe(false);
    // Hex-lookalike longname ("Cafe" → "cafe"): resolvable ids are exactly 8 hex
    expect(isResolvedHop("cafe")).toBe(false);
    expect(isResolvedHop("")).toBe(false);
  });
});

describe("canonicalPairKey", () => {
  it("is symmetric and normalizes both endpoints", () => {
    expect(canonicalPairKey("000000dd", "000000aa")).toBe("000000aa|000000dd");
    expect(canonicalPairKey("000000aa", "000000dd")).toBe("000000aa|000000dd");
    expect(canonicalPairKey(0xdd, "!000000aa")).toBe("000000aa|000000dd");
  });
});

describe("decodeSnr", () => {
  it("divides by 4 and nulls the -128 sentinel", () => {
    expect(decodeSnr(-29)).toBe(-7.25);
    expect(decodeSnr(0)).toBe(0);
    expect(decodeSnr(-128)).toBeNull();
    expect(decodeSnr(undefined)).toBeNull();
  });
});

describe("tracerouteRichness", () => {
  it("sums the four RouteDiscovery arrays (mirrors the DB upsert metric)", () => {
    const poor: TracerouteRowLike = {
      payload: { route: [1, 2], snr_towards: [4, 8, 12], route_back: [], snr_back: [] },
    };
    const rich: TracerouteRowLike = {
      payload: { route: [1, 2], snr_towards: [4, 8, 12], route_back: [3], snr_back: [9] },
    };
    expect(tracerouteRichness(poor)).toBe(5);
    expect(tracerouteRichness(rich)).toBe(7);
  });

  it("falls back to route_ids for slim rows so they don't under-count", () => {
    // Slim REST row: payload stripped to snr_towards, route carried as route_ids
    const slim: TracerouteRowLike = {
      route_ids: ["000000b1", "000000b2"],
      payload: { snr_towards: [4, 8, 12] },
    };
    // The identical packet as a full SSE row, no back-leg data yet
    const fullSameData: TracerouteRowLike = {
      route_ids: ["000000b1", "000000b2"],
      payload: { route: [1, 2], snr_towards: [4, 8, 12], route_back: [], snr_back: [] },
    };
    expect(tracerouteRichness(slim)).toBe(5);
    // Equal — a same-data full row must NOT read as richer than its slim twin
    expect(tracerouteRichness(fullSameData)).toBe(tracerouteRichness(slim));
  });

  it("handles missing/malformed payloads as zero", () => {
    expect(tracerouteRichness({})).toBe(0);
    expect(tracerouteRichness({ payload: { route: "bogus" as unknown as [] } })).toBe(0);
  });

  it("hasFullTraceroutePayload separates slim rows from full rows", () => {
    expect(hasFullTraceroutePayload({ payload: { route: [1], snr_towards: [4, 8] } })).toBe(true);
    // Slim REST row: payload stripped to snr_towards only
    expect(hasFullTraceroutePayload({ route_ids: ["000000b1"], payload: { snr_towards: [4, 8] } })).toBe(false);
    expect(hasFullTraceroutePayload({})).toBe(false);
  });
});

describe("dedupeExchanges", () => {
  it("drops the truncated request when its reply is present", () => {
    const req = requestRow();
    const rep = replyRow();
    expect(dedupeExchanges([req, rep])).toEqual([rep]);
  });

  it("keeps an unmatched request (reply lost to RF)", () => {
    const req = requestRow();
    expect(dedupeExchanges([req])).toEqual([req]);
  });

  it("keeps a request outside the 60s window", () => {
    const req = requestRow({ timestamp: 900 }); // 110s before the reply
    const rep = replyRow({ timestamp: 1010 });
    expect(dedupeExchanges([req, rep])).toEqual([req, rep]);
  });

  it("never merges two same-role rows: repeated requests are repeated attempts", () => {
    const req1 = requestRow({ timestamp: 1000, id: 1 });
    const req2 = requestRow({ timestamp: 1050, id: 2 });
    expect(dedupeExchanges([req1, req2])).toEqual([req1, req2]);
  });

  it("a reply consumes only its closest preceding request", () => {
    const req1 = requestRow({ timestamp: 990, id: 1 });
    const req2 = requestRow({ timestamp: 1000, id: 2 });
    const rep = replyRow({ timestamp: 1010 });
    expect(dedupeExchanges([req1, req2, rep])).toEqual([req1, rep]);
  });

  it("requires the request path to prefix the reply path", () => {
    // Same pair but the request went via a different first hop — not this exchange.
    const req = requestRow({ route_ids: ["000000c9"], payload: { route: [0xc9], snr_towards: [4] } });
    const rep = replyRow();
    expect(dedupeExchanges([req, rep])).toEqual([req, rep]);
  });

  it("passes unorientable rows through untouched", () => {
    const bad = { route_ids: ["000000b1"] } as TracerouteRowLike;
    const rep = replyRow();
    expect(dedupeExchanges([bad, rep])).toEqual([bad, rep]);
  });

  it("collapses a zero-hop exchange to the reply", () => {
    const req: TracerouteRowLike = {
      from: "000000aa",
      to: "000000dd",
      route_ids: [],
      payload: { route: [], snr_towards: [] },
      timestamp: 1000,
    };
    const rep: TracerouteRowLike = {
      from: "000000dd",
      to: "000000aa",
      route_ids: [],
      payload: { route: [], snr_towards: [5] },
      timestamp: 1005,
    };
    expect(dedupeExchanges([req, rep])).toEqual([rep]);
  });
});
