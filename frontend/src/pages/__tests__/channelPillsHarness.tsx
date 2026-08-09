/**
 * Shared jsdom harness for the channel-pill page tests: canned /v1 fetch stub,
 * the real Redux store + MemoryRouter mount, and per-test reset helpers.
 */
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Provider } from "react-redux";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";

import { apiSlice } from "../../slices/apiSlice";
import { store } from "../../store";
import type { IChannel, INode } from "../../types";
import type { IConfigResponse } from "../../types/config";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

export interface ApiFixtures {
  config?: IConfigResponse;
  channels?: Record<string, Partial<Omit<IChannel, "messages">>>;
  chat?: Record<string, Partial<IChannel>>;
  nodes?: Record<string, Partial<INode>>;
  packets?: { messages: unknown[]; next_cursor: string | null };
}

/** URLs of every request the stub answered, in call order. */
export const requests: URL[] = [];

export const requestsTo = (path: string): URL[] =>
  requests.filter((u) => u.pathname === path);

export const lastRequestTo = (path: string): URL => {
  const hits = requestsTo(path);
  return hits[hits.length - 1];
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

export function stubApi(fixtures: ApiFixtures): void {
  requests.length = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const raw = input instanceof Request ? input.url : String(input);
    const url = new URL(raw, "http://localhost");
    requests.push(url);
    const p = url.pathname;
    if (p === "/v1/server/config") return json({ config: fixtures.config ?? {} });
    if (p === "/v1/channels") return json({ channels: fixtures.channels ?? {} });
    if (p === "/v1/chat") return json({ channels: fixtures.chat ?? {} });
    if (p === "/v1/nodes") return json({ nodes: fixtures.nodes ?? {} });
    if (p === "/v1/packets")
      return json(fixtures.packets ?? { messages: [], next_cursor: null });
    if (p.startsWith("/v1/packets/")) return json({ packet: null });
    if (/\/v1\/nodes\/[^/]+\/packets$/.test(p)) return json({ packets: [] });
    return new Response("not found", { status: 404 });
  });
}

export function stubMatchMedia(): void {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("min-width: 1024px"),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }));
}

let mounted: { root: Root; el: HTMLElement } | null = null;

export async function mountAt(path: string, page: ReactElement): Promise<void> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  mounted = { root, el };
  await act(async () => {
    root.render(
      <Provider store={store}>
        <MemoryRouter initialEntries={[path]}>{page}</MemoryRouter>
      </Provider>,
    );
  });
  await flush();
}

/** Settle fetch/effect chains: loop until DOM, requests, and query states stop changing. */
export async function flush(maxRounds = 50): Promise<void> {
  let stable = 0;
  let lastHtml = "";
  let lastReqCount = -1;
  for (let i = 0; i < maxRounds; i++) {
    // >16ms so RTK's rAF-autobatched notifications land inside the round.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const pending = Object.values(store.getState().api.queries).some(
      (q) => (q as { status?: string } | undefined)?.status === "pending",
    );
    const html = document.body.innerHTML;
    if (!pending && html === lastHtml && requests.length === lastReqCount) {
      if (++stable >= 2) return;
    } else {
      stable = 0;
    }
    lastHtml = html;
    lastReqCount = requests.length;
  }
}

export async function click(node: Element): Promise<void> {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flush();
}

export async function cleanup(): Promise<void> {
  if (mounted) {
    const { root, el } = mounted;
    await act(async () => root.unmount());
    el.remove();
    mounted = null;
  }
  act(() => {
    store.dispatch(apiSlice.util.resetApiState());
  });
  localStorage.clear();
  vi.unstubAllGlobals();
}

/** Pill buttons in DOM order as [label, count] (count "" when no badge). */
export function pillTexts(labels: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const btn of document.querySelectorAll("button")) {
    const badge = btn.querySelector("span");
    const label = (btn.childNodes[0]?.textContent ?? "").trim();
    if (labels.includes(label)) out.push([label, badge?.textContent?.trim() ?? ""]);
  }
  return out;
}

export function pillButton(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll("button")].find(
    (b) => (b.childNodes[0]?.textContent ?? "").trim() === label,
  );
}

export const isActivePill = (btn: Element | undefined): boolean =>
  !!btn && btn.className.includes("bg-indigo-600");
