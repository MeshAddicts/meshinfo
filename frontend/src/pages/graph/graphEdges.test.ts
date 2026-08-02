import { describe, expect, it } from "vitest";

import { buildTracerouteEdges } from "./graphEdges";

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
