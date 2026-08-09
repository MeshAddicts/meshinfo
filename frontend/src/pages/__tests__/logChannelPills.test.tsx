/** Log page: pills filter /v1/packets by channel NAME topics, never the hash id. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The repo .env's relative VITE_API_BASE_URL breaks node's Request; apiSlice
// bakes its baseUrl at import, so the override must run before any import.
vi.hoisted(() => {
  (globalThis as { __env__?: object }).__env__ = {
    VITE_API_BASE_URL: "http://localhost",
  };
});
vi.mock("react-virtuoso", () => ({ Virtuoso: () => null }));

import { Log } from "../Log";
import {
  cleanup,
  click,
  isActivePill,
  lastRequestTo,
  mountAt,
  pillButton,
  stubApi,
  stubMatchMedia,
} from "./channelPillsHarness";

const channelsFix = {
  "31": { name: "LongFast", totalMessages: 10, recentMessages: 10 },
  "77": { name: "MediumFast", totalMessages: 4, recentMessages: 4 },
  // Placeholder wire name: real bucket, but no topic name -> no pill.
  "200": { name: "Channel 200", totalMessages: 3, recentMessages: 3 },
};

const lastPacketsReq = () => lastRequestTo("/v1/packets");

describe("Log channel pills", () => {
  beforeEach(() => stubMatchMedia());
  afterEach(() => cleanup());

  it("clicking a pill queries by wire name, not the bucket hash", async () => {
    stubApi({ config: {}, channels: channelsFix });
    await mountAt("/logs", <Log />);
    await click(pillButton("MediumFast")!);
    const topic = lastPacketsReq().searchParams.get("topic");
    expect(topic).toBe("/2/e/MediumFast/");
    expect(topic).not.toContain("77");
    expect(isActivePill(pillButton("MediumFast"))).toBe(true);
  });

  it("?ch= label slug deep link resolves to the name-based topic filter", async () => {
    stubApi({ config: {}, channels: channelsFix });
    await mountAt("/logs?ch=mediumfast", <Log />);
    expect(lastPacketsReq().searchParams.get("topic")).toBe("/2/e/MediumFast/");
    expect(isActivePill(pillButton("MediumFast"))).toBe(true);
  });

  it("pill-less ?ch falls back to All: no topic filter, zero filter count", async () => {
    stubApi({
      config: { broker: { channels: { mode: "all" } } },
      channels: channelsFix,
    });
    await mountAt("/logs?ch=200", <Log />);
    expect(pillButton("Channel 200")).toBeUndefined();
    expect(isActivePill(pillButton("All"))).toBe(true);
    expect(lastPacketsReq().searchParams.get("topic")).toBeNull();
    expect(document.body.textContent).toContain("no filters");
  });
});
