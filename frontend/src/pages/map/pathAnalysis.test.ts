import { describe, expect, it } from "vitest";

import type { ITraceroutesResponse } from "../../types";
import { decodeSnr, findPathsBetween } from "./pathAnalysis";

/** Minimal traceroute row; O=requester, D=destination. */
function row(overrides: Partial<ITraceroutesResponse>): ITraceroutesResponse {
  return {
    channel: 0,
    from: "0000000o",
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
    const paths = findPathsBetween("0000000o", "0000000d", [
      row({ route_ids: ["000000r1", "000000r2"] }),
    ]);
    expect(paths).toHaveLength(1);
    expect(paths[0].hops).toEqual(["0000000o", "000000r1", "000000r2", "0000000d"]);
    expect(paths[0].legSnrDb).toBeUndefined();
  });

  it("orients reply rows (full snr_towards) as to → route → from", () => {
    // Reply for trace O→R1→R2→D: header from=D, to=O; route stays request-order.
    const reply = row({
      from: "0000000d",
      to: "0000000o",
      route_ids: ["000000r1", "000000r2"],
      payload: { route: [], snr_towards: [-29, 8, -128] },
    });
    const paths = findPathsBetween("0000000o", "0000000d", [reply]);
    expect(paths).toHaveLength(1);
    // True travel order O→R1→R2→D, not the scrambled D-header order
    expect(paths[0].hops).toEqual(["0000000o", "000000r1", "000000r2", "0000000d"]);
    expect(paths[0].legSnrDb).toEqual([-7.25, 2, null]);
    expect(paths[0].legSnrReversed).toBe(false);
  });

  it("reverses hops and legs when picked opposite to travel order", () => {
    const reply = row({
      from: "0000000d",
      to: "0000000o",
      route_ids: ["000000r1"],
      payload: { route: [], snr_towards: [-29, 8] },
    });
    const paths = findPathsBetween("0000000d", "0000000o", [reply]);
    expect(paths[0].hops).toEqual(["0000000d", "000000r1", "0000000o"]);
    expect(paths[0].legSnrDb).toEqual([2, -7.25]);
    expect(paths[0].legSnrReversed).toBe(true);
  });

  it("keeps unresolvable hops as placeholders so alignment holds", () => {
    const reply = row({
      from: "0000000d",
      to: "0000000o",
      route_ids: ["Some Longname", "000000r2"] as string[],
      payload: { route: [], snr_towards: [4, 8, 12] },
    });
    const paths = findPathsBetween("0000000o", "0000000d", [reply]);
    expect(paths[0].hops).toHaveLength(4);
    expect(paths[0].legSnrDb).toEqual([1, 2, 3]);
  });

  it("ranks newest first with hop count as tiebreak, counting repeats", () => {
    const stale1hop = row({ id: 1, route_ids: [], timestamp: 100 });
    const fresh2hopA = row({ id: 2, route_ids: ["000000r1"], timestamp: 900 });
    const fresh2hopB = row({ id: 3, route_ids: ["000000r1"], timestamp: 950 });
    const paths = findPathsBetween("0000000o", "0000000d", [stale1hop, fresh2hopA, fresh2hopB]);
    expect(paths[0].hops).toEqual(["0000000o", "000000r1", "0000000d"]);
    expect(paths[0].count).toBe(2);
    expect(paths[0].timestamp).toBe(950);
    expect(paths[1].hopCount).toBe(1);
  });
});
