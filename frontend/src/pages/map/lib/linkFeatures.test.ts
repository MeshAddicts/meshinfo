import { describe, expect, it } from "vitest";

import type { ITraceroutesResponse } from "../../../types";
import { buildTracerouteLinkFeatureCollection, normalizedTraceroutePath } from "./linkFeatures";

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

const liveNodes: Record<string, any> = Object.fromEntries(
  ["0000000a", "0000000d", "000000b1", "000000b2"].map((id, i) => [
    id,
    { id, map_position: [i, i], last_seen: undefined },
  ]),
);

function edgeKeys(traceroutes: ITraceroutesResponse[]): string[] {
  const fc = buildTracerouteLinkFeatureCollection(traceroutes, liveNodes);
  return fc.features.map((f) => `${f.properties?.aId}|${f.properties?.bId}`).sort();
}

describe("normalizedTraceroutePath", () => {
  it("travel-orders reply rows (header swap, not reversal)", () => {
    const reply = row({
      from: "0000000d",
      to: "0000000a",
      route_ids: ["000000b1", "000000b2"],
      payload: { route: [], snr_towards: [4, 8, 12] },
    });
    expect(normalizedTraceroutePath(reply)).toEqual([
      "0000000a",
      "000000b1",
      "000000b2",
      "0000000d",
    ]);
  });

  it("keeps unresolvable hops as placeholders", () => {
    const reply = row({
      route_ids: ["000000b1", "Some Longname"],
      payload: { route: [], snr_towards: [4, 8, 12] },
    });
    const path = normalizedTraceroutePath(row({ ...reply }));
    expect(path).toHaveLength(4);
  });
});

describe("buildTracerouteLinkFeatureCollection", () => {
  it("draws real reply-row legs, never the phantom endpoint edges", () => {
    // Reply for trace O→R1→R2→D: header from=D, to=O, request-ordered route
    const reply = row({
      from: "0000000d",
      to: "0000000a",
      route_ids: ["000000b1", "000000b2"],
      payload: { route: [], snr_towards: [4, 8, 12] },
    });
    const keys = edgeKeys([reply]);
    expect(keys).toEqual(["0000000a|000000b1", "0000000d|000000b2", "000000b1|000000b2"]);
    // Phantom endpoint edges D–R1 and R2–O must not exist
    expect(keys).not.toContain("0000000d|000000b1");
    expect(keys).not.toContain("0000000a|000000b2");
  });

  it("skips legs touching an unpositionable placeholder instead of splicing across it", () => {
    const reply = row({
      from: "0000000d",
      to: "0000000a",
      route_ids: ["000000b1", "Some Longname"],
      payload: { route: [], snr_towards: [4, 8, 12] },
    });
    // Only O–R1 is drawable; no O–D shortcut, no R1–D splice across the unknown hop.
    expect(edgeKeys([reply])).toEqual(["0000000a|000000b1"]);
  });

  it("excludes the speculative final leg of a mid-flight request", () => {
    const request = row({
      route_ids: ["000000b1"],
      payload: { route: [], snr_towards: [4] },
    });
    expect(edgeKeys([request])).toEqual(["0000000a|000000b1"]);
  });

  it("draws the direct leg of a zero-hop reply but not of a zero-hop request", () => {
    const zeroHopReply = row({
      from: "0000000d",
      to: "0000000a",
      route_ids: [],
      payload: { route: [], snr_towards: [5] },
    });
    const zeroHopRequest = row({ route_ids: [], payload: { route: [] } });
    expect(edgeKeys([zeroHopReply])).toEqual(["0000000a|0000000d"]);
    expect(edgeKeys([zeroHopRequest])).toEqual([]);
  });
});
