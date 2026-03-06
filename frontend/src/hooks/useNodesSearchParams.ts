import { useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";

import {
  cleanNodeId,
  parseRangeKey,
  parseSortByKey,
  parseSortDir,
  parseStatusKey,
  RangeKey,
  SortByKey,
  SortDir,
  StatusKey,
} from "../pages/nodes/nodesUtils";

type SetMode = "push" | "replace";

const DEFAULTS = {
  r: "all" as RangeKey,
  st: "all" as StatusKey,
  by: "seen" as SortByKey,
  dir: "desc" as SortDir,
};

function isDefaultParam(key: string, value: string) {
  const v = String(value ?? "").trim();

  if (key === "q") return v === "";
  if (key === "node") return cleanNodeId(v) === "";

  if (key === "r") return (v as RangeKey) === DEFAULTS.r;
  if (key === "st") return (v as StatusKey) === DEFAULTS.st;
  if (key === "by") return (v as SortByKey) === DEFAULTS.by;
  if (key === "dir") return (v as SortDir) === DEFAULTS.dir;

  return false;
}

export function useNodesSearchParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  const urlQ = (searchParams.get("q") ?? "").toString();

  // ✅ IMPORTANT: if 'r' is missing, Nodes default is "all"
  const rawR = searchParams.get("r");
  const urlRange = (rawR ? parseRangeKey(rawR) : "all") as RangeKey;

  const rawSt = searchParams.get("st");
  const urlStatus = parseStatusKey(rawSt) as StatusKey;

  const rawBy = searchParams.get("by");
  const urlBy = parseSortByKey(rawBy) as SortByKey;

  const rawDir = searchParams.get("dir");
  const urlDir = parseSortDir(rawDir) as SortDir;

  const urlNode = cleanNodeId(searchParams.get("node") ?? "");

  // Optional: canonicalize away defaults if someone links ?r=all&st=all&by=seen&dir=desc
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    let changed = false;

    if (next.has("r") && urlRange === DEFAULTS.r) {
      next.delete("r");
      changed = true;
    }
    if (next.has("st") && urlStatus === DEFAULTS.st) {
      next.delete("st");
      changed = true;
    }
    if (next.has("by") && urlBy === DEFAULTS.by) {
      next.delete("by");
      changed = true;
    }
    if (next.has("dir") && urlDir === DEFAULTS.dir) {
      next.delete("dir");
      changed = true;
    }

    // q/node canonicalization: delete if empty
    if (next.has("q") && !urlQ.trim()) {
      next.delete("q");
      changed = true;
    }
    if (next.has("node") && !urlNode) {
      next.delete("node");
      changed = true;
    }

    if (changed) setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlRange, urlStatus, urlBy, urlDir, urlQ, urlNode]);

  const setParam = (key: string, value?: string, mode: SetMode = "push") => {
    const next = new URLSearchParams(searchParams);
    const v = value == null ? "" : String(value);

    if (!v || isDefaultParam(key, v)) next.delete(key);
    else next.set(key, v);

    setSearchParams(next, { replace: mode === "replace" });
  };

  const setParams = (
    entries: Array<{ key: string; value?: string }>,
    mode: SetMode = "push"
  ) => {
    const next = new URLSearchParams(searchParams);

    for (const e of entries) {
      const v = e.value == null ? "" : String(e.value);
      if (!v || isDefaultParam(e.key, v)) next.delete(e.key);
      else next.set(e.key, v);
    }

    setSearchParams(next, { replace: mode === "replace" });
  };

  return useMemo(
    () => ({
      searchParams,
      urlQ,
      urlRange,
      urlStatus,
      urlBy,
      urlDir,
      urlNode,
      setParam,
      setParams,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setParam/setParams are stable
    [searchParams, urlQ, urlRange, urlStatus, urlBy, urlDir, urlNode]
  );
}
