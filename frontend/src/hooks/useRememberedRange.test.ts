/**
 * Tests for useRememberedRange — the remember-last-time-range hook.
 * Rendered with a bare react-dom root (no router: the hook is prop-driven),
 * mirroring useRememberedChannel.test.ts.
 */
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRememberedRange } from "./useRememberedRange";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const KEY = "meshinfo.test.lastRange";

type Props = {
  value: string;
  urlHasR: boolean;
  suppressRestore: boolean;
  apply: (stored: string) => void;
};

const defaults = (overrides: Partial<Props> & Pick<Props, "apply">): Props => ({
  value: "all",
  urlHasR: false,
  suppressRestore: false,
  ...overrides,
});

function Harness(props: Props) {
  useRememberedRange({ storageKey: KEY, ...props });
  return null;
}

describe("useRememberedRange", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (props: Props) =>
    act(() =>
      root.render(createElement(StrictMode, null, createElement(Harness, props)))
    );

  it("restores a stored range on a bare visit", () => {
    localStorage.setItem(KEY, "24h");
    const apply = vi.fn();
    render(defaults({ apply }));
    expect(apply).toHaveBeenCalledWith("24h");
  });

  it("does nothing on a bare visit with no stored range (default stays)", () => {
    const apply = vi.fn();
    render(defaults({ apply }));
    expect(apply).not.toHaveBeenCalled();
  });

  it("adopts an explicit URL range instead of restoring", () => {
    localStorage.setItem(KEY, "7d");
    const apply = vi.fn();
    render(defaults({ apply, value: "1h", urlHasR: true }));
    expect(apply).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe("1h");
  });

  it("suppresses the restore when the URL carries other state", () => {
    // Restoring a range under a shared ?msg= deeplink could hide its target.
    localStorage.setItem(KEY, "1h");
    const apply = vi.fn();
    render(defaults({ apply, suppressRestore: true }));
    expect(apply).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe("1h"); // untouched, not cleared
  });

  it("records later changes of the selection", () => {
    const apply = vi.fn();
    render(defaults({ apply }));
    render(defaults({ apply, value: "7d" }));
    expect(localStorage.getItem(KEY)).toBe("7d");
  });

  it("ignores values outside the vocabulary in both directions", () => {
    localStorage.setItem(KEY, "3w");
    const apply = vi.fn();
    render(defaults({ apply }));
    expect(apply).not.toHaveBeenCalled(); // invalid stored -> no restore

    render(defaults({ apply, value: "junk" }));
    expect(localStorage.getItem(KEY)).toBe("3w"); // invalid change -> not recorded
  });
});
