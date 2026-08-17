// jsdom tests for the contextual legend (#564): it never auto-closes on map
// interaction, and it only lists the encodings the viewport is showing.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { EMPTY_LEGEND_CONTEXT, type LegendContext } from "../hooks/useLegendContext";
import { MapLegend } from "./MapLegend";
import { MapSettingsPanel } from "./MapSettingsPanel";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { root: Root; el: HTMLElement } | null = null;
function mount(node: React.ReactElement) {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => root.render(node));
  mounted = { root, el };
  return el;
}
afterEach(() => {
  if (mounted) act(() => mounted!.root.unmount());
  document.body.innerHTML = "";
  mounted = null;
});

const text = () => document.getElementById("legend")?.textContent ?? "";

describe("MapLegend (contextual rows)", () => {
  it("shows every row when no context is known yet", () => {
    mount(<MapLegend context={null} livePackets />);
    const t = text();
    for (const row of [
      "Online node", "Online router", "Offline node", "Cluster (ring", "Brightness = recency",
      "Link quality", "SNR unknown", "This node heard neighbor", "Neighbor heard this node", "Mutual link",
      "Traceroute path", "Live packets", "Online = seen in last 6 hours",
    ]) expect(t, row).toContain(row);
  });

  it("lists only what is on screen", () => {
    const ctx: LegendContext = { ...EMPTY_LEGEND_CONTEXT, onlineNode: true, cluster: true, linkHeardBy: true, linkSnr: true };
    mount(<MapLegend context={ctx} livePackets={false} linkMode="all" />);
    const t = text();
    expect(t).toContain("Online node");
    expect(t).toContain("Cluster (ring");
    expect(t).toContain("Neighbor heard this node");
    expect(t).toContain("Link quality");
    expect(t).toContain("Brightness = recency");
    expect(t).not.toContain("Online router");
    expect(t).not.toContain("Offline node");
    expect(t).not.toContain("SNR unknown");
    expect(t).not.toContain("This node heard neighbor");
    expect(t).not.toContain("Mutual link");
    expect(t).not.toContain("Traceroute path");
    expect(t).not.toContain("Live packets");
    expect(t).toContain("Showing links for all nodes.");
  });

  it("explains an empty viewport instead of listing nothing", () => {
    mount(<MapLegend context={EMPTY_LEGEND_CONTEXT} livePackets={false} />);
    const t = text();
    expect(t).toContain("Nothing in view");
    expect(t).not.toContain("Online node");
    expect(t).not.toContain("Brightness = recency");
    expect(t).toContain("Online = seen in last 6 hours");
  });

  it("keeps the recency row in a links-only view (endpoints off screen)", () => {
    const ctx: LegendContext = { ...EMPTY_LEGEND_CONTEXT, linkSnr: true, linkHeard: true };
    mount(<MapLegend context={ctx} livePackets={false} />);
    const t = text();
    expect(t).toContain("Brightness = recency");
    expect(t).toContain("Link quality");
    expect(t).not.toContain("Online node");
  });

  it("keeps the live-packets section while the toggle is on, even with an empty view", () => {
    mount(<MapLegend context={EMPTY_LEGEND_CONTEXT} livePackets />);
    expect(text()).toContain("Live packets");
  });

  it("empty-state copy explains hidden nodes / active filters", () => {
    mount(<MapLegend context={EMPTY_LEGEND_CONTEXT} livePackets={false} nodesHidden />);
    expect(text()).toContain("Nodes are hidden");
    act(() => mounted!.root.unmount());
    document.body.innerHTML = "";
    mount(<MapLegend context={EMPTY_LEGEND_CONTEXT} livePackets={false} filtersActive />);
    expect(text()).toContain("widen the filters");
  });

  it("wording follows the link mode", () => {
    const ctx: LegendContext = { ...EMPTY_LEGEND_CONTEXT, linkHeard: true, linkHeardBy: true, linkTrace: true };
    mount(<MapLegend context={ctx} livePackets={false} linkMode="all" />);
    expect(text()).toContain("One-way link");
    expect(text()).toContain("Traceroute path");
    expect(text()).not.toContain("(on select)");
    act(() => mounted!.root.unmount());
    document.body.innerHTML = "";
    mount(<MapLegend context={ctx} livePackets={false} linkMode="mynode" myNodeLabel="BASE" />);
    expect(text()).toContain("BASE heard neighbor");
    expect(text()).toContain("Neighbor heard BASE");
    act(() => mounted!.root.unmount());
    document.body.innerHTML = "";
    mount(<MapLegend context={ctx} livePackets={false} linkMode="selected" />);
    expect(text()).toContain("This node heard neighbor");
    expect(text()).toContain("Traceroute path (on select)");
  });
});

function panel(overrides: Partial<React.ComponentProps<typeof MapSettingsPanel>> = {}) {
  const props: React.ComponentProps<typeof MapSettingsPanel> = {
    settingsPanelRef: { current: null },
    settingsToggleRef: { current: null },
    settingsPanelOpen: false,
    setSettingsPanelOpen: vi.fn(),
    legendOpen: true,
    setLegendOpen: vi.fn(),
    legendContext: null,
    openSections: new Set(),
    setOpenSections: vi.fn(),
    setProvider: vi.fn(),
    mapboxStyle: "",
    setMapboxStyle: vi.fn(),
    osmBasemap: "dark" as never,
    setOsmBasemap: vi.fn(),
    linkMode: "selected",
    setLinkMode: vi.fn(),
    myNodeId: "",
    setMyNodeId: vi.fn(),
    nodeList: [],
    canUseMapbox: false,
    usingMapbox: false,
    terrain3D: false,
    setTerrain3D: vi.fn(),
    buildings3D: false,
    setBuildings3D: vi.fn(),
    livePackets: true,
    setLivePackets: vi.fn(),
    recentDays: 30,
    setRecentDays: vi.fn(),
    clusterEnabled: true,
    setClusterEnabled: vi.fn(),
    roleFilter: null,
    setRoleFilter: vi.fn(),
    channelFilter: null,
    setChannelFilter: vi.fn(),
    resolveChannelLabel: (id) => id,
    ...overrides,
  };
  return props;
}

describe("MapSettingsPanel legend (#564: stays open on map interaction)", () => {
  it("does not close on outside pointerdown or Escape", () => {
    const setLegendOpen = vi.fn();
    mount(<MapSettingsPanel {...panel({ setLegendOpen })} />);
    expect(document.getElementById("legend")).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(setLegendOpen).not.toHaveBeenCalled();
    expect(document.getElementById("legend")).not.toBeNull();
  });

  it("toggle button closes it, and reports its state via aria-expanded", () => {
    const setLegendOpen = vi.fn();
    mount(<MapSettingsPanel {...panel({ setLegendOpen })} />);
    const btn = document.querySelector('button[aria-label="Toggle legend"]')!;
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.getAttribute("aria-controls")).toBe("legend");
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(setLegendOpen).toHaveBeenCalledWith(false);
  });

  it("is hidden (not forgotten) while the settings panel is open; its button then re-shows it", () => {
    const setLegendOpen = vi.fn();
    const setSettingsPanelOpen = vi.fn();
    mount(<MapSettingsPanel {...panel({ settingsPanelOpen: true, setLegendOpen, setSettingsPanelOpen })} />);
    expect(document.getElementById("legend")).toBeNull();
    const btn = document.querySelector('button[aria-label="Toggle legend"]')!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(setSettingsPanelOpen).toHaveBeenCalledWith(false);
    expect(setLegendOpen).toHaveBeenCalledWith(true);
  });

  it("opening settings leaves the legend preference alone", () => {
    const setLegendOpen = vi.fn();
    mount(<MapSettingsPanel {...panel({ setLegendOpen })} />);
    const btn = document.querySelector('button[aria-label="Toggle Map Settings"]')!;
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(setLegendOpen).not.toHaveBeenCalled();
  });

  it("marks its toggle so Map.tsx's outside-click handler leaves settings open until the click runs", () => {
    // Map.tsx closes the settings panel on mousedown outside it and exempts
    // [data-legend-toggle]; without the marker, mousedown would close settings
    // first and the click would then toggle an already-open legend OFF.
    mount(<MapSettingsPanel {...panel({ settingsPanelOpen: true })} />);
    expect(document.querySelector('button[aria-label="Toggle legend"]')!.hasAttribute("data-legend-toggle")).toBe(true);
  });

  it("is suppressed (preference kept) while a tool is active; clicking is inert", () => {
    const setLegendOpen = vi.fn();
    mount(<MapSettingsPanel {...panel({ legendSuppressed: true, setLegendOpen })} />);
    expect(document.getElementById("legend")).toBeNull();
    const btn = document.querySelector('button[aria-label="Toggle legend"]')!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-disabled")).toBe("true");
    act(() => btn.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(setLegendOpen).not.toHaveBeenCalled();
  });

  it("shifts the stack left of the desktop details column when it is open", () => {
    mount(<MapSettingsPanel {...panel({ dodgeDetails: true })} />);
    const root = document.querySelector('button[aria-label="Toggle legend"]')!.closest("div.fixed")!;
    expect(root.className).toContain("sm:right-[calc(21.25rem+1rem)]");
  });
});
