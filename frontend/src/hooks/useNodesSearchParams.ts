import { useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  RangeKey,
  StatusKey,
  SortByKey,
  SortDir,
  parseRangeKey,
  parseSortByKey,
  parseSortDir,
  parseStatusKey,
  cleanNodeId,
} from "../pages/nodes/nodesUtils";

type SetMode = "push" | "replace";

export function useNodesSearchParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  const urlQ = (searchParams.get("q") ?? "").toString();
  const urlRange = parseRangeKey(searchParams.get("r"));
  const urlStatus = parseStatusKey(searchParams.get("st"));
  const urlBy = parseSortByKey(searchParams.get("by"));
  const urlDir = parseSortDir(searchParams.get("dir"));
  const urlNode = cleanNodeId(searchParams.get("node") ?? "");

  const setParam = (key: string, value?: string, mode: SetMode = "push") => {
    const next = new URLSearchParams(searchParams);
    if (value == null || value === "") next.delete(key);
    else next.set(key, value);
    setSearchParams(next, { replace: mode === "replace" });
  };

  const setParams = (
    entries: Array<{ key: string; value?: string }>,
    mode: SetMode = "push"
  ) => {
    const next = new URLSearchParams(searchParams);
    for (const e of entries) {
      if (e.value == null || e.value === "") next.delete(e.key);
      else next.set(e.key, e.value);
    }
    setSearchParams(next, { replace: mode === "replace" });
  };

  return useMemo(
    () => ({
      searchParams,
      urlQ,
      urlRange: urlRange as RangeKey,
      urlStatus: urlStatus as StatusKey,
      urlBy: urlBy as SortByKey,
      urlDir: urlDir as SortDir,
      urlNode,
      setParam,
      setParams,
    }),
    [searchParams, urlQ, urlRange, urlStatus, urlBy, urlDir, urlNode]
  );
}
