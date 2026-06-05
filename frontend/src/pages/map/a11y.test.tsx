// Renders the map's standalone panels in jsdom (no WebGL / MapLibre needed)
// and asserts the accessibility wiring added in the a11y batch.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClassLegend } from "./ClutterUI";
import { FilterDropup } from "./FilterDropup";
import { FiltersResetPill } from "./FiltersResetPill";
import { MapHealthWidget } from "./MapHealthWidget";
import { MapSearchBar } from "./MapSearchBar";
import { MapToolsDrawer } from "./MapToolsDrawer";
import { Segmented } from "./Segmented";

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
function click(node: Element) {
  act(() => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
function keydown(node: Element, key: string) {
  act(() => node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })));
}
afterEach(() => {
  if (mounted) act(() => mounted!.root.unmount());
  document.body.innerHTML = "";
  mounted = null;
});

describe("Segmented (A2/A30 radiogroup)", () => {
  it("exposes radiogroup/radio semantics with roving tabindex", () => {
    const onChange = vi.fn();
    mount(
      <Segmented
        ariaLabel="Reliability"
        value="b"
        onChange={onChange}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
          { value: "c", label: "C" },
        ]}
      />,
    );
    const group = document.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute("aria-label")).toBe("Reliability");
    const radios = [...group.querySelectorAll('[role="radio"]')];
    expect(radios).toHaveLength(3);
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect(radios[1].getAttribute("tabindex")).toBe("0");
    expect(radios[0].getAttribute("aria-checked")).toBe("false");
    expect(radios[0].getAttribute("tabindex")).toBe("-1");
  });

  it("ArrowRight moves selection to the next option", () => {
    const onChange = vi.fn();
    mount(
      <Segmented
        ariaLabel="Detail"
        value="a"
        onChange={onChange}
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
      />,
    );
    const active = document.querySelector('[role="radio"][aria-checked="true"]')!;
    keydown(active, "ArrowRight");
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("MapToolsDrawer (A4 menu)", () => {
  it("trigger advertises a popup menu and opens role=menu with menuitems", () => {
    mount(<MapToolsDrawer activeTool={null} onSelect={() => {}} terrainEnabled={true} />);
    const trigger = document.querySelector("button")!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    click(trigger);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.querySelectorAll('[role="menuitem"]').length).toBeGreaterThan(0);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("MapHealthWidget (A27 disclosure)", () => {
  it("toggle has aria-expanded + descriptive aria-label", () => {
    mount(<MapHealthWidget nodes={{}} />);
    const btn = document.querySelector("button")!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-label") || "").toMatch(/^Mesh health/);
    expect(btn.getAttribute("aria-controls")).toBe("mesh-health-panel");
  });
});

describe("FilterDropup (A27 listbox)", () => {
  it("trigger has haspopup=listbox; menu exposes option roles + aria-selected", () => {
    mount(
      <FilterDropup
        label="Role"
        value={1}
        isActive={false}
        onChange={() => {}}
        options={[
          { value: 1, label: "One" },
          { value: 2, label: "Two" },
        ]}
      />,
    );
    const trigger = document.querySelector("button")!;
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    click(trigger);
    const listbox = document.querySelector('[role="listbox"]')!;
    expect(listbox).not.toBeNull();
    const opts = [...listbox.querySelectorAll('[role="option"]')];
    expect(opts.length).toBe(2);
    // value=1 is selected
    expect(opts[0].getAttribute("aria-selected")).toBe("true");
    expect(opts[1].getAttribute("aria-selected")).toBe("false");
  });
});

describe("FiltersResetPill (A27 chips)", () => {
  it("chips carry a removal aria-label", () => {
    mount(
      <FiltersResetPill
        recentDays={1}
        setRecentDays={() => {}}
        linkMode="selected"
        setLinkMode={() => {}}
        roleFilter={null}
        setRoleFilter={() => {}}
        channelFilter={null}
        setChannelFilter={() => {}}
      />,
    );
    const pill = document.querySelector("button")!;
    click(pill);
    const chip = document.querySelector('button[aria-label^="Remove filter:"]');
    expect(chip).not.toBeNull();
  });
});

describe("MapSearchBar (A10 combobox)", () => {
  it("input has combobox semantics", () => {
    mount(<MapSearchBar nodes={{}} onSelect={() => {}} />);
    const input = document.querySelector('input[aria-label="Search nodes"]')!;
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-autocomplete")).toBe("list");
    expect(input.getAttribute("aria-controls")).toBe("node-search-listbox");
  });
});

describe("ClassLegend (A27 disclosure)", () => {
  it("toggle has aria-expanded + aria-controls", () => {
    mount(<ClassLegend />);
    const btn = document.querySelector("button")!;
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-controls")).toBe("clutter-class-legend");
    click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
  });
});
