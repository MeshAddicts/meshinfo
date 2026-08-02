/**
 * Tests for useRememberedChannel — the remember-last-channel-pill hook.
 * Rendered with a bare react-dom root (no router: the hook is prop-driven).
 */
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useRememberedChannel } from "./useRememberedChannel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const KEY = "meshinfo.test.lastCh";

type Props = {
  value: string;
  urlHasCh: boolean;
  suppressRestore: boolean;
  ready: boolean;
  isValid: (stored: string) => boolean;
  apply: (stored: string) => void;
};

const defaults = (
  overrides: Partial<Props> & Pick<Props, "apply">
): Props => ({
  value: "",
  urlHasCh: false,
  suppressRestore: false,
  ready: true,
  isValid: () => true,
  ...overrides,
});

function Harness(props: Props) {
  useRememberedChannel({ storageKey: KEY, ...props });
  return null;
}

describe("useRememberedChannel", () => {
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
    vi.restoreAllMocks();
  });

  const render = (props: Props) =>
    act(() => {
      root.render(createElement(Harness, props));
    });

  it("bare visit with nothing stored: no restore, nothing recorded", () => {
    const apply = vi.fn();
    render(defaults({ apply }));
    expect(apply).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("bare visit with a stored channel: restores it", () => {
    localStorage.setItem(KEY, "MediumFast");
    const apply = vi.fn();
    render(defaults({ apply }));
    expect(apply).toHaveBeenCalledExactlyOnceWith("MediumFast");
  });

  it("does nothing until ready, then restores exactly once", () => {
    localStorage.setItem(KEY, "MediumFast");
    const apply = vi.fn();
    render(defaults({ apply, ready: false }));
    expect(apply).not.toHaveBeenCalled();
    render(defaults({ apply, ready: true }));
    expect(apply).toHaveBeenCalledExactlyOnceWith("MediumFast");
    // Later renders don't re-restore.
    render(defaults({ apply, ready: true, value: "MediumFast" }));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("drops a stored channel that no longer resolves instead of applying it", () => {
    localStorage.setItem(KEY, "RemovedChannel");
    const apply = vi.fn();
    render(defaults({ apply, isValid: () => false }));
    expect(apply).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("stored empty string (remembered All) is a no-op restore", () => {
    localStorage.setItem(KEY, "");
    const apply = vi.fn();
    render(defaults({ apply }));
    expect(apply).not.toHaveBeenCalled();
  });

  it("stored value equal to the current selection: no redundant apply", () => {
    localStorage.setItem(KEY, "all");
    const apply = vi.fn();
    render(defaults({ apply, value: "all" }));
    expect(apply).not.toHaveBeenCalled();
  });

  it("explicit ?ch= deep link wins and becomes the remembered value", () => {
    localStorage.setItem(KEY, "MediumFast");
    const apply = vi.fn();
    render(defaults({ apply, value: "LongFast", urlHasCh: true }));
    expect(apply).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe("LongFast");
  });

  it("?ch= plus other params: still recorded (ch is explicit)", () => {
    localStorage.setItem(KEY, "MediumFast");
    const apply = vi.fn();
    render(
      defaults({ apply, value: "LongFast", urlHasCh: true, suppressRestore: true })
    );
    expect(apply).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe("LongFast");
  });

  it("deep link with other params: restore suppressed, memory untouched", () => {
    localStorage.setItem(KEY, "MediumFast");
    const apply = vi.fn();
    render(defaults({ apply, suppressRestore: true }));
    expect(apply).not.toHaveBeenCalled();
    expect(localStorage.getItem(KEY)).toBe("MediumFast");
  });

  it("pill changes are recorded, including back to the default", () => {
    const apply = vi.fn();
    render(defaults({ apply }));
    render(defaults({ apply, value: "MediumFast" }));
    expect(localStorage.getItem(KEY)).toBe("MediumFast");
    render(defaults({ apply, value: "" }));
    expect(localStorage.getItem(KEY)).toBe("");
  });

  it("StrictMode double-invoked effects restore only once", () => {
    localStorage.setItem(KEY, "MediumFast");
    const apply = vi.fn();
    act(() => {
      root.render(
        createElement(StrictMode, null, createElement(Harness, defaults({ apply })))
      );
    });
    expect(apply).toHaveBeenCalledExactlyOnceWith("MediumFast");
  });

  it("survives localStorage writes failing (private mode / quota)", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("QuotaExceededError");
    });
    const apply = vi.fn();
    expect(() =>
      render(defaults({ apply, value: "LongFast", urlHasCh: true }))
    ).not.toThrow();
  });
});
