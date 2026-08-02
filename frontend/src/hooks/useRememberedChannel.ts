import { useEffect, useRef } from "react";

/** localStorage keys for the last-selected channel pill, per page. */
export const REMEMBERED_CH_KEYS = {
  chat: "meshinfo.chat.lastCh",
  nodes: "meshinfo.nodes.lastCh",
  logs: "meshinfo.logs.lastCh",
} as const;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private browsing / full quota: the pill still works, we just can't remember it.
  }
}

function removeStored(key: string) {
  try {
    localStorage.removeItem(key);
  } catch {
    // Same as above.
  }
}

/**
 * Remember a page's channel-pill selection (the `ch` URL param) and restore
 * it on the next bare visit, so users land where they left off.
 *
 * URL state always wins over memory:
 * - An explicit `?ch=` is never overridden — it is adopted as the new
 *   remembered selection (you "left off" where the link took you).
 * - Any other query params (a shared `?msg=`/`?q=`/`?node=` link) suppress
 *   the restore entirely: applying a remembered channel filter could hide
 *   the very content the link points at. Nothing is recorded either, until
 *   the user actually changes the selection.
 *
 * Nothing happens until `ready` (channel views resolved from config), so
 * only canonical, currently-valid keys are ever applied or written; a stored
 * key that no longer resolves (channel removed/renamed) is deleted instead
 * of being replayed into the URL forever.
 *
 * An empty value means the page default ("All"); changes to it are recorded
 * too, so explicitly returning to All is also remembered.
 */
export function useRememberedChannel(opts: {
  storageKey: string;
  /** Current selection, resolved: canonical key, or "" for the page default. */
  value: string;
  /** Whether the URL has an explicit, non-empty `ch` param this render. */
  urlHasCh: boolean;
  /** Whether the URL carries any other state that must not be disturbed. */
  suppressRestore: boolean;
  /** False until channel views are known (config loaded). */
  ready: boolean;
  /** Whether a stored key still names a real selection. */
  isValid: (stored: string) => boolean;
  /** Apply a stored selection — must use replace-style navigation. */
  apply: (stored: string) => void;
}) {
  const { storageKey, value, urlHasCh, suppressRestore, ready, isValid, apply } =
    opts;

  // null until the readiness-time restore decision has run; afterwards the
  // last selection we have seen (doubles as the "decided" flag).
  const prevRef = useRef<string | null>(null);

  // Once ready: restore the remembered selection, unless the URL brought its
  // own state (see the contract above).
  useEffect(() => {
    if (!ready || prevRef.current !== null) return;
    if (urlHasCh) {
      writeStored(storageKey, value);
    } else if (!suppressRestore) {
      const stored = readStored(storageKey);
      if (stored) {
        if (!isValid(stored)) removeStored(storageKey);
        else if (stored !== value) apply(stored);
      }
    }
    prevRef.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot at readiness
  }, [ready]);

  // Record every later change of the selection (pill clicks, back/forward).
  useEffect(() => {
    if (prevRef.current === null || value === prevRef.current) return;
    prevRef.current = value;
    writeStored(storageKey, value);
  }, [storageKey, value]);
}
