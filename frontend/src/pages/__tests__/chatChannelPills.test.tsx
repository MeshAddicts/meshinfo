/** Chat page: auto tabs grouped presets/custom with range-scoped counts; manual mode renders configured views only. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The repo .env's relative VITE_API_BASE_URL breaks node's Request; apiSlice
// bakes its baseUrl at import, so the override must run before any import.
vi.hoisted(() => {
  (globalThis as { __env__?: object }).__env__ = {
    VITE_API_BASE_URL: "http://localhost",
  };
});
vi.mock("react-virtuoso", () => ({ Virtuoso: () => null }));

import { Chat } from "../Chat";
import {
  cleanup,
  isActivePill,
  lastRequestTo,
  mountAt,
  pillButton,
  pillTexts,
  requestsTo,
  stubApi,
  stubMatchMedia,
} from "./channelPillsHarness";

const chatFix = {
  "31": { name: "LongFast", messages: [], totalMessages: 100, recentMessages: 7 },
  "77": { name: "MediumFast", messages: [], totalMessages: 50, recentMessages: 2 },
  "112": { name: "SacValley", messages: [], totalMessages: 90, recentMessages: 5 },
};

const PILL_LABELS = ["LongFast", "MediumFast", "SacValley", "Main"];

describe("Chat channel tabs", () => {
  beforeEach(() => stubMatchMedia());
  afterEach(() => cleanup());

  it("auto mode: grouped presets/custom tabs with range-scoped counts", async () => {
    stubApi({
      config: { broker: { channels: { mode: "all" } } },
      chat: chatFix,
      nodes: {},
    });
    await mountAt("/chat?r=24h", <Chat />);

    expect(document.body.textContent).toContain("Modem presets");
    expect(document.body.textContent).toContain("Custom channels");
    // Badges show the 24h recentMessages, not all-time totals.
    expect(pillTexts(PILL_LABELS)).toEqual([
      ["LongFast", "7"],
      ["MediumFast", "2"],
      ["SacValley", "5"],
    ]);
    // Busiest channel is the default tab.
    expect(isActivePill(pillButton("LongFast"))).toBe(true);

    for (const req of requestsTo("/v1/chat")) {
      expect(req.searchParams.get("range")).toBe("24h");
      expect(req.searchParams.get("channel")).toBeNull();
    }
  });

  it("manual mode: configured views only, ungrouped, query scoped to the view's channel", async () => {
    stubApi({
      config: {
        broker: {
          channels: {
            mode: "manual",
            views: [{ id: "main", label: "Main", channels: ["31"], default: true }],
          },
        },
      },
      chat: chatFix,
      nodes: {},
    });
    await mountAt("/chat", <Chat />);

    expect(pillTexts(PILL_LABELS)).toEqual([["Main", "7"]]);
    expect(pillButton("SacValley")).toBeUndefined();
    expect(document.body.textContent).not.toContain("Modem presets");
    expect(document.body.textContent).not.toContain("Custom channels");
    expect(isActivePill(pillButton("Main"))).toBe(true);

    expect(lastRequestTo("/v1/chat").searchParams.get("channel")).toBe("31");
  });
});
