import { useEffect, useRef } from "react";

/** localStorage keys for the last-selected time range, per page. */
export const REMEMBERED_RANGE_KEYS = {
  chat: "meshinfo.chat.lastRange",
  nodes: "meshinfo.nodes.lastRange",
  logs: "meshinfo.logs.lastRange",
} as const;

/** The shared range vocabulary. Pages default to "all"; the picker narrows. */
export const RANGE_VALUES = ["1h", "24h", "7d", "all"] as const;
export type RememberedRange = (typeof RANGE_VALUES)[number];

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
    // Private browsing / quota: the picker still works, we just can't remember.
  }
}

/**
 * Remember a page's `?r=` range and restore it on the next bare visit; explicit URL wins.
 * Any other query param suppresses the restore so shared links aren't narrowed away.
 */
export function useRememberedRange(opts: {
  storageKey: string;
  /** Current resolved range (URL value or the page default). */
  value: string;
  /** Whether the URL has an explicit `r` this render. */
  urlHasR: boolean;
  /** Whether the URL carries any other state that must not be disturbed. */
  suppressRestore: boolean;
  /** Apply a stored range — must use replace-style navigation. */
  apply: (stored: RememberedRange) => void;
}) {
  const { storageKey, value, urlHasR, suppressRestore, apply } = opts;

  const isValid = (v: string): v is RememberedRange =>
    (RANGE_VALUES as readonly string[]).includes(v);

  // One-shot restore decision; afterwards the last seen selection.
  const prevRef = useRef<string | null>(null);

  useEffect(() => {
    if (prevRef.current !== null) return;
    if (urlHasR) {
      if (isValid(value)) writeStored(storageKey, value);
    } else if (!suppressRestore) {
      const stored = readStored(storageKey);
      if (stored && isValid(stored) && stored !== value) apply(stored);
    }
    prevRef.current = value;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot at mount
  }, []);

  // Record every later change (picker clicks, back/forward).
  useEffect(() => {
    if (prevRef.current === null || value === prevRef.current) return;
    prevRef.current = value;
    if (isValid(value)) writeStored(storageKey, value);
  }, [storageKey, value]);
}
