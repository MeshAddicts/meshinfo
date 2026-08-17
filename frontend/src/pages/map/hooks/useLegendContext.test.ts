import { describe, expect, it } from "vitest";

import { NodeRole } from "../../../types";
import { EMPTY_LEGEND_CONTEXT, legendContextFromFeatures, legendContextIsEmpty } from "./useLegendContext";

const feat = (layerId: string, properties: Record<string, unknown>) =>
  ({ layer: { id: layerId } as never, properties }) as never;

describe("legendContextFromFeatures", () => {
  it("is empty for no features", () => {
    const ctx = legendContextFromFeatures([]);
    expect(ctx).toEqual(EMPTY_LEGEND_CONTEXT);
    expect(legendContextIsEmpty(ctx)).toBe(true);
  });

  it("classifies nodes by online + router-family role", () => {
    const ctx = legendContextFromFeatures([
      feat("unclustered-nodes", { online: true, role: NodeRole.CLIENT }),
      feat("plain-nodes", { online: true, role: NodeRole.ROUTER_LATE }),
      feat("spiderfy-node-circles", { online: false, role: NodeRole.ROUTER }),
    ]);
    expect(ctx.onlineNode).toBe(true);
    expect(ctx.onlineRouter).toBe(true);
    expect(ctx.offlineNode).toBe(true); // offline router is gray, not blue
    expect(ctx.cluster).toBe(false);
    expect(legendContextIsEmpty(ctx)).toBe(false);
  });

  it("treats non-router online roles as plain online nodes", () => {
    const ctx = legendContextFromFeatures([feat("unclustered-nodes", { online: true, role: NodeRole.REPEATER })]);
    expect(ctx.onlineNode).toBe(true);
    expect(ctx.onlineRouter).toBe(false);
  });

  it("flags clusters from the hit-test layer", () => {
    const ctx = legendContextFromFeatures([feat("clusters", { point_count: 12, onlineCount: 3 })]);
    expect(ctx.cluster).toBe(true);
    expect(ctx.onlineNode).toBe(false);
  });

  it("splits links by kind and SNR presence; traceroute never counts toward SNR rows", () => {
    const ctx = legendContextFromFeatures([
      feat("links-solid", { kind: "neighbor", snr: 4.5 }),
      feat("links-dashed", { kind: "heard_by", snr: null }),
      feat("links-dotted", { kind: "traceroute", snr: null }),
    ]);
    expect(ctx.linkHeard).toBe(true);
    expect(ctx.linkHeardBy).toBe(true);
    expect(ctx.linkTrace).toBe(true);
    expect(ctx.linkMutual).toBe(false);
    expect(ctx.linkSnr).toBe(true);
    expect(ctx.linkSnrUnknown).toBe(true);
  });

  it("only traceroute links → no SNR rows", () => {
    const ctx = legendContextFromFeatures([feat("links-dotted", { kind: "traceroute", snr: null })]);
    expect(ctx.linkSnrUnknown).toBe(false);
    expect(ctx.linkSnr).toBe(false);
    expect(ctx.linkTrace).toBe(true);
  });

  it("mutual (arc) links", () => {
    const ctx = legendContextFromFeatures([feat("links-solid", { kind: "both", snr: -3 })]);
    expect(ctx.linkMutual).toBe(true);
    expect(ctx.linkHeard).toBe(false);
    expect(ctx.linkSnr).toBe(true);
  });

  it("ignores unrelated layers", () => {
    const ctx = legendContextFromFeatures([feat("coverage-fill", { cls: "good" }), feat("clusters-count", { point_count: 3 })]);
    expect(legendContextIsEmpty(ctx)).toBe(true);
  });
});
