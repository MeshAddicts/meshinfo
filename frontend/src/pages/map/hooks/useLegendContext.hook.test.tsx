// Hook behaviour against a stub map: disabled → null, idle-driven + debounced
// queries, unknown layer ids filtered before querying, stable identity.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { type LegendContext, useLegendContext } from "./useLegendContext";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Handler = (e?: unknown) => void;
type Feat = { layer: { id: string }; properties: Record<string, unknown> };
/** Stub map: each configured layer id doubles as its source id; features are
 *  served per source by querySourceFeatures (like maplibre, minus the map). */
function stubMap(opts: { layers: string[]; features?: Feat[]; loaded?: boolean; hidden?: string[]; minzoom?: Record<string, number>; zoom?: number }) {
  const handlers = new Map<string, Set<Handler>>();
  const query = vi.fn((source: string, _o?: { filter?: unknown; sourceLayer?: string }) =>
    (opts.features ?? []).filter((f) => f.layer.id === source).map((f) => ({ properties: f.properties })),
  );
  const map = {
    on: vi.fn((ev: string, h: Handler) => { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev)!.add(h); }),
    off: vi.fn((ev: string, h: Handler) => handlers.get(ev)?.delete(h)),
    getLayer: vi.fn((id: string) => (opts.layers.includes(id) ? { id, source: id, minzoom: opts.minzoom?.[id] } : undefined)),
    getSource: vi.fn((id: string) => (opts.layers.includes(id) ? { id } : undefined)),
    getLayoutProperty: vi.fn((id: string, _p: string) => (opts.hidden?.includes(id) ? "none" : "visible")),
    getFilter: vi.fn(() => undefined),
    getZoom: vi.fn(() => opts.zoom ?? 10),
    querySourceFeatures: query,
    loaded: vi.fn(() => opts.loaded ?? true),
    fire: (ev: string) => handlers.get(ev)?.forEach((h) => h()),
    fireWith: (ev: string, e: unknown) => handlers.get(ev)?.forEach((h) => h(e)),
    listenerCount: (ev: string) => handlers.get(ev)?.size ?? 0,
  };
  return { map, query };
}

let latest: LegendContext | null | undefined;
function Probe({ mapRef, enabled, mapLoaded = true, styleEpoch = 0 }: { mapRef: { current: unknown }; enabled: boolean; mapLoaded?: boolean; styleEpoch?: number }) {
  latest = useLegendContext(mapRef as never, { enabled, mapLoaded, styleEpoch });
  return null;
}

let mounted: { root: Root; el: HTMLElement } | null = null;
function mount(node: React.ReactElement) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  mounted = { root, el };
  return root;
}
afterEach(() => {
  if (mounted) act(() => mounted!.root.unmount());
  document.body.innerHTML = "";
  mounted = null;
  latest = undefined;
  vi.useRealTimers();
});

describe("useLegendContext", () => {
  it("returns null and touches nothing while disabled", () => {
    const { map, query } = stubMap({ layers: ["clusters"] });
    mount(<Probe mapRef={{ current: map }} enabled={false} />);
    expect(latest).toBeNull();
    expect(query).not.toHaveBeenCalled();
    expect(map.on).not.toHaveBeenCalled();
  });

  it("queries immediately when the map is already idle, one source query per existing layer", () => {
    const { map, query } = stubMap({
      layers: ["clusters", "links-solid"],
      features: [{ layer: { id: "clusters" }, properties: { point_count: 5 } }],
    });
    mount(<Probe mapRef={{ current: map }} enabled />);
    expect(query.mock.calls.map((c) => c[0]).sort()).toEqual(["clusters", "links-solid"]);
    expect(latest?.cluster).toBe(true);
    expect(latest?.linkHeard).toBe(false);
    expect(map.listenerCount("idle")).toBe(1);
  });

  it("skips hidden layers and layers below their minzoom", () => {
    const { map, query } = stubMap({
      layers: ["clusters", "plain-nodes", "links-solid"],
      hidden: ["clusters"],
      minzoom: { "links-solid": 12 },
      zoom: 10,
      features: [
        { layer: { id: "clusters" }, properties: { point_count: 5 } },
        { layer: { id: "plain-nodes" }, properties: { online: true, role: 0 } },
        { layer: { id: "links-solid" }, properties: { kind: "neighbor", snr: 3 } },
      ],
    });
    mount(<Probe mapRef={{ current: map }} enabled />);
    expect(query.mock.calls.map((c) => c[0])).toEqual(["plain-nodes"]);
    expect(latest?.cluster).toBe(false);
    expect(latest?.onlineNode).toBe(true);
    expect(latest?.linkHeard).toBe(false);
  });

  it("waits for idle when the map is still loading, then debounces idle bursts", () => {
    vi.useFakeTimers();
    const { map, query } = stubMap({ layers: ["clusters"], loaded: false });
    mount(<Probe mapRef={{ current: map }} enabled />);
    expect(query).not.toHaveBeenCalled();
    act(() => { map.fire("idle"); map.fire("idle"); map.fire("idle"); });
    expect(query).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(250); });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("keeps the same context object when nothing changed, and detaches on disable", () => {
    vi.useFakeTimers();
    const { map } = stubMap({ layers: ["clusters"], features: [{ layer: { id: "clusters" }, properties: {} }] });
    const ref = { current: map };
    const root = mount(<Probe mapRef={ref} enabled />);
    const first = latest;
    act(() => { map.fire("idle"); vi.advanceTimersByTime(250); });
    expect(latest).toBe(first);
    act(() => root.render(<Probe mapRef={ref} enabled={false} />));
    expect(latest).toBeNull();
    expect(map.listenerCount("idle")).toBe(0);
  });

  it("does not clobber the context when no layers exist (mid style swap)", () => {
    vi.useFakeTimers();
    const { map, query } = stubMap({ layers: ["clusters"], features: [{ layer: { id: "clusters" }, properties: {} }] });
    mount(<Probe mapRef={{ current: map }} enabled />);
    expect(latest?.cluster).toBe(true);
    map.getLayer.mockImplementation(() => undefined);
    act(() => { map.fire("moveend"); map.fire("idle"); vi.advanceTimersByTime(250); });
    expect(query).toHaveBeenCalledTimes(1); // no layers → query skipped, ctx kept
    expect(latest?.cluster).toBe(true);
  });

  it("attaches once the map instance exists (mapLoaded) and re-attaches on a style swap (styleEpoch)", () => {
    const { map, query } = stubMap({ layers: ["clusters"], features: [{ layer: { id: "clusters" }, properties: {} }] });
    const ref: { current: unknown } = { current: null };
    const root = mount(<Probe mapRef={ref} enabled mapLoaded={false} />);
    expect(query).not.toHaveBeenCalled();
    ref.current = map; // map created after mount…
    act(() => root.render(<Probe mapRef={ref} enabled mapLoaded />)); // …and 'load' flips the flag
    expect(query).toHaveBeenCalledTimes(1);
    expect(map.listenerCount("idle")).toBe(1);
    act(() => root.render(<Probe mapRef={ref} enabled mapLoaded styleEpoch={1} />));
    expect(map.listenerCount("idle")).toBe(1); // old listener detached, new one attached
    expect(query).toHaveBeenCalledTimes(2); // layers back → immediate re-query
    expect(latest?.cluster).toBe(true);
  });

  it("re-queries on idle only after a move or a source reload (hover repaints are ignored)", () => {
    vi.useFakeTimers();
    const { map, query } = stubMap({ layers: ["clusters"], features: [{ layer: { id: "clusters" }, properties: {} }] });
    mount(<Probe mapRef={{ current: map }} enabled />);
    expect(query).toHaveBeenCalledTimes(1);
    // idle from a hover-only repaint: nothing armed → no query
    act(() => { map.fire("idle"); vi.advanceTimersByTime(250); });
    expect(query).toHaveBeenCalledTimes(1);
    act(() => { map.fire("moveend"); map.fire("idle"); vi.advanceTimersByTime(250); });
    expect(query).toHaveBeenCalledTimes(2);
    act(() => { map.fireWith("sourcedata", { isSourceLoaded: false }); map.fire("idle"); vi.advanceTimersByTime(250); });
    expect(query).toHaveBeenCalledTimes(2);
    act(() => { map.fireWith("sourcedata", { isSourceLoaded: true }); map.fire("idle"); vi.advanceTimersByTime(250); });
    expect(query).toHaveBeenCalledTimes(3);
    // paint-only changes (hover dimming) fire styledata + idle: not a reason to re-query
    act(() => { map.fire("styledata"); map.fire("idle"); vi.advanceTimersByTime(250); });
    expect(query).toHaveBeenCalledTimes(3);
  });
});
