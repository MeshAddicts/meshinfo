import { useCallback, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

export type FocusMode = "endpoints" | "any";
export type MsgType = "all" | "bc" | "dm";
export type RangeKey = "1h" | "24h" | "7d" | "all";
export type SortKey = "desc" | "asc";
export type DirKey = "both" | "in" | "out";
export type NavMode = "replace" | "push";

// Default URL param values (we will *remove* these from the URL for canonical links)
const DEFAULT_PARAM: Record<string, string> = {
  r: "24h",
  t: "all",
  s: "desc",
  focus: "endpoints",
  dir: "both",
};

const clampInt = (v: string | null, min: number, max: number) => {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return undefined;
  return Math.max(min, Math.min(max, n));
};

const parseEnum = <T extends string>(
  v: string | null,
  allowed: readonly T[],
  fallback: T
): T => {
  if (!v) return fallback;
  return (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
};

export type ChatViewParam = { key: string; aliases?: string[] };

export function useChatSearchParams(args?: {
  views?: ChatViewParam[];
  defaultCh?: string;
}) {
  const views = args?.views ?? [];
  const [searchParams, setSearchParams] = useSearchParams();

  const rawCh = (searchParams.get("ch") ?? "").trim();

  const defaultCh = useMemo(() => {
    const d = (args?.defaultCh ?? "").trim();
    if (d) return d;
    return views[0]?.key ?? "";
  }, [args?.defaultCh, views]);

  const aliasToKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of views) {
      const k = (v.key ?? "").trim();
      if (!k) continue;
      m.set(k.toLowerCase(), k);
      for (const a of v.aliases ?? []) {
        const aa = (a ?? "").trim();
        if (!aa) continue;
        m.set(aa.toLowerCase(), k);
      }
    }
    return m;
  }, [views]);

  const urlCh = useMemo(() => {
    if (!defaultCh) return rawCh; // fallback (shouldn’t happen)
    if (!rawCh) return defaultCh;

    const mapped = aliasToKey.get(rawCh.toLowerCase());
    return mapped ?? defaultCh;
  }, [rawCh, aliasToKey, defaultCh]);

  // Canonicalize ch in the URL (also fixes invalid ch to default)
  useEffect(() => {
    if (!defaultCh) return;

    const desired = urlCh || defaultCh;
    const current = (searchParams.get("ch") ?? "").trim();

    if (current !== desired) {
      const next = new URLSearchParams(searchParams);
      next.set("ch", desired);
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlCh, defaultCh]);

  // ---- URL param-backed state (validated)
  const urlQ = searchParams.get("q") ?? "";

  const urlRange = parseEnum<RangeKey>(
    searchParams.get("r"),
    ["1h", "24h", "7d", "all"] as const,
    "24h"
  );

  const urlType = parseEnum<MsgType>(
    searchParams.get("t"),
    ["all", "bc", "dm"] as const,
    "all"
  );

  const urlSort = parseEnum<SortKey>(
    searchParams.get("s"),
    ["desc", "asc"] as const,
    "desc"
  );

  const urlNode = searchParams.get("node") ?? "";

  const urlFocus = parseEnum<FocusMode>(
    searchParams.get("focus"),
    ["endpoints", "any"] as const,
    "endpoints"
  );

  const urlDir = parseEnum<DirKey>(
    searchParams.get("dir"),
    ["both", "in", "out"] as const,
    "both"
  );

  const urlMsg = searchParams.get("msg") ?? "";

  // Advanced filters
  const urlFrom = searchParams.get("from") ?? "";
  const urlTo = searchParams.get("to") ?? "";
  const urlVia = searchParams.get("via") ?? "";
  const urlHopsMin = clampInt(searchParams.get("hmin"), 0, 10);
  const urlHopsMax = clampInt(searchParams.get("hmax"), 0, 10);
  const onlyUnknownEndpoints = searchParams.get("unk") === "1";
  const requireVia = searchParams.get("hv") === "1";

  // ---- Param helpers (canonical + history semantics)
  const setParam = useCallback(
    (key: string, value?: string, mode: NavMode = "replace") => {
      const next = new URLSearchParams(searchParams);

      const v = value?.trim();
      const defaultForKey = DEFAULT_PARAM[key];

      if (!v) next.delete(key);
      else if (defaultForKey && v === defaultForKey) next.delete(key);
      else next.set(key, v);

      setSearchParams(next, { replace: mode === "replace" });
    },
    [searchParams, setSearchParams]
  );

  const setParams = useCallback(
    (
      updates: Array<{ key: string; value?: string }>,
      mode: NavMode = "replace"
    ) => {
      const next = new URLSearchParams(searchParams);

      for (const u of updates) {
        const v = u.value?.trim();
        const defaultForKey = DEFAULT_PARAM[u.key];

        if (!v) next.delete(u.key);
        else if (defaultForKey && v === defaultForKey) next.delete(u.key);
        else next.set(u.key, v);
      }

      setSearchParams(next, { replace: mode === "replace" });
    },
    [searchParams, setSearchParams]
  );

  const clearFilters = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    // keep ch
    next.delete("q");
    next.delete("node");
    next.delete("focus");
    next.delete("dir");
    next.delete("t");
    next.delete("r");
    next.delete("s");
    next.delete("msg");

    // advanced filters
    next.delete("from");
    next.delete("to");
    next.delete("via");
    next.delete("hmin");
    next.delete("hmax");
    next.delete("unk");
    next.delete("hv");

    setSearchParams(next, { replace: false });
  }, [searchParams, setSearchParams]);

  // If node is not set, don’t keep focus/dir around in URL
  useEffect(() => {
    if (urlNode?.trim()) return;

    const hasFocus = searchParams.has("focus");
    const hasDir = searchParams.has("dir");

    if (hasFocus || hasDir) {
      setParams(
        [
          { key: "focus", value: undefined },
          { key: "dir", value: undefined },
        ],
        "replace"
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlNode]);

  return useMemo(
    () => ({
      searchParams,

      // parsed
      urlCh, // now canonical key (e.g., "mediumfast")
      urlQ,
      urlRange,
      urlType,
      urlSort,
      urlNode,
      urlFocus,
      urlDir,
      urlMsg,

      // advanced
      urlFrom,
      urlTo,
      urlVia,
      urlHopsMin,
      urlHopsMax,
      onlyUnknownEndpoints,
      requireVia,

      // helpers
      setParam,
      setParams,
      clearFilters,
    }),
    [
      searchParams,
      urlCh,
      urlQ,
      urlRange,
      urlType,
      urlSort,
      urlNode,
      urlFocus,
      urlDir,
      urlMsg,
      urlFrom,
      urlTo,
      urlVia,
      urlHopsMin,
      urlHopsMax,
      onlyUnknownEndpoints,
      requireVia,
      setParam,
      setParams,
      clearFilters,
    ]
  );
}
