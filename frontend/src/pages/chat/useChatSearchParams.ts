import { useCallback, useEffect, useMemo } from "react";
import { normalizeKey } from "../../utils/channelDisplay";
import { useSearchParams } from "react-router";

export type FocusMode = "endpoints" | "any";
export type MsgType = "all" | "bc" | "dm";
export type RangeKey = "1h" | "24h" | "7d" | "all";
export type SortKey = "desc" | "asc";
export type DirKey = "both" | "in" | "out";
export type NavMode = "replace" | "push";

// Default URL param values (we will *remove* these from the URL for canonical links)
// NOTE: ch is dynamic (depends on args/views), so it is handled separately.
const DEFAULT_PARAM: Record<string, string> = {
  r: "all",
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
  // Callers pass a memoized array; this only pins the `?? []` fallback identity.
  const views = useMemo(() => args?.views ?? [], [args?.views]);
  const [searchParams, setSearchParams] = useSearchParams();

  const rawCh = (searchParams.get("ch") ?? "").trim();

  const defaultCh = useMemo(() => {
    const d = (args?.defaultCh ?? "").trim();
    if (d) return d;
    return views[0]?.key ?? "";
  }, [args?.defaultCh, views]);

  const aliasToKey = useMemo(() => {
    // normalizeKey, not toLowerCase — must match the page's ?ch= normalization
    // ("Sac Valley" vs ?ch=sacvalley).
    const m = new Map<string, string>();
    for (const v of views) {
      const k = normalizeKey(v.key ?? "");
      if (!k) continue;
      m.set(k, v.key);
      for (const a of v.aliases ?? []) {
        const aa = normalizeKey(a ?? "");
        if (!aa) continue;
        m.set(aa, v.key);
      }
    }
    return m;
  }, [views]);

  // Resolved channel (always a real key if defaultCh is available)
  const urlCh = useMemo(() => {
    if (!defaultCh) return rawCh; // fallback (shouldn’t happen)
    if (!rawCh) return defaultCh;

    const mapped = aliasToKey.get(normalizeKey(rawCh));
    return mapped ?? defaultCh;
  }, [rawCh, aliasToKey, defaultCh]);

  // Canonicalize ch in the URL WITHOUT forcing defaults into the URL:
  // - If resolved == defaultCh -> delete ch
  // - Else ensure ch is set to canonical key
  useEffect(() => {
    if (!defaultCh) return;

    const resolved = (urlCh || defaultCh).trim();
    const currentRaw = (searchParams.get("ch") ?? "").trim();

    const shouldOmit = resolved === defaultCh;

    // If URL already matches canonical intent, do nothing.
    // - When default: ch should be omitted, so currentRaw must be ""
    // - When non-default: ch should equal resolved
    if (shouldOmit) {
      if (!currentRaw) return;
      const next = new URLSearchParams(searchParams);
      next.delete("ch");
      setSearchParams(next, { replace: true });
      return;
    }

    // Non-default channel must be explicit and canonical
    if (currentRaw === resolved) return;

    const next = new URLSearchParams(searchParams);
    next.set("ch", resolved);
    setSearchParams(next, { replace: true });

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlCh, defaultCh]);

  // ---- URL param-backed state (validated)
  const urlQ = searchParams.get("q") ?? "";

  const urlRange = parseEnum<RangeKey>(
    searchParams.get("r"),
    ["1h", "24h", "7d", "all"] as const,
    // "all" by default: range-scoped pills hiding channels surprised operators.
    "all"
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

  const isDefaultForKey = useCallback(
    (key: string, v: string) => {
      if (key === "ch") {
        const vv = v.trim();
        return !!defaultCh && vv === defaultCh;
      }
      const def = DEFAULT_PARAM[key];
      return !!def && v === def;
    },
    [defaultCh]
  );

  // ---- Param helpers (canonical + history semantics)
  const setParam = useCallback(
    (key: string, value?: string, mode: NavMode = "replace") => {
      const next = new URLSearchParams(searchParams);

      const v = value?.trim() ?? "";
      if (!v) next.delete(key);
      else if (isDefaultForKey(key, v)) next.delete(key);
      else next.set(key, v);

      setSearchParams(next, { replace: mode === "replace" });
    },
    [searchParams, setSearchParams, isDefaultForKey]
  );

  const setParams = useCallback(
    (
      updates: Array<{ key: string; value?: string }>,
      mode: NavMode = "replace"
    ) => {
      const next = new URLSearchParams(searchParams);

      for (const u of updates) {
        const v = u.value?.trim() ?? "";
        if (!v) next.delete(u.key);
        else if (isDefaultForKey(u.key, v)) next.delete(u.key);
        else next.set(u.key, v);
      }

      setSearchParams(next, { replace: mode === "replace" });
    },
    [searchParams, setSearchParams, isDefaultForKey]
  );

  const clearFilters = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    // keep ch (and let canonicalizer omit it if it's default)
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
      urlCh, // resolved key (canonical)
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
