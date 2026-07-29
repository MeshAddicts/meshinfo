/** Shareable tool deep links: keeps ?tool=los|traceroute&from&to(&fh&th&fq / &play)
 *  in sync with the active analysis, restores once from the URL on mount, and
 *  fires a play=1 tour when the restored path is ready. LOS and traceroute share
 *  one URL snapshot — the tools are mutually exclusive. */
import { useEffect, useRef } from "react";

import { prefersReducedMotion } from "../../../utils/reducedMotion";
import type { AnalyzedPath } from "../lib/pathAnalysis";
import type { useLosState } from "./useLosState";

type LosState = ReturnType<typeof useLosState>;
type MapTool = "los" | "traceroute" | "coverage" | "scan" | null;

/** Rewrite only the tool-owned params via history.replaceState — a router
 *  navigation (setSearchParams) would re-render the whole Map route per tool
 *  change for a purely cosmetic URL update. Reads window.location fresh so
 *  ?lat/lng/z, ?node= and any other params are preserved, and skips the write
 *  when nothing changed (Safari rate-limits replaceState). */
function writeToolParams(mutate: (sp: URLSearchParams) => void): void {
  const sp = new URLSearchParams(window.location.search);
  const before = sp.toString();
  mutate(sp);
  const after = sp.toString();
  if (after === before) return;
  const next = `${window.location.pathname}${after ? `?${after}` : ""}${window.location.hash}`;
  // Keep the router's history.state (usr/key/idx) — nulling it would break
  // react-router's back/forward bookkeeping.
  window.history.replaceState(window.history.state, "", next);
}

export type ToolUrlSyncParams = {
  activeTool: MapTool;
  toolStep: "pickFrom" | "pickTo" | "result";
  toolFromId: string | null;
  toolToId: string | null;
  setActiveTool: (t: Exclude<MapTool, null>) => void;
  setToolStep: (s: "pickFrom" | "pickTo" | "result") => void;
  setToolFromId: (id: string | null) => void;
  setToolToId: (id: string | null) => void;
  losState: LosState;
  /** One-shot play=1 request; Map.tsx drops it on resetTool / path select. */
  tracePendingPlayRef: { current: boolean };
  traceSelectedPath: AnalyzedPath | null;
  tracePosKey: string;
  styleEpoch: number;
  startFlyover: (path: AnalyzedPath) => boolean;
};

export function useToolUrlSync({
  activeTool, toolStep, toolFromId, toolToId,
  setActiveTool, setToolStep, setToolFromId, setToolToId,
  losState, tracePendingPlayRef, traceSelectedPath, tracePosKey, styleEpoch,
  startFlyover,
}: ToolUrlSyncParams): void {
  // Snapshot the URL at first render: the write effect rewrites the real URL
  // synchronously (loader-less router), so the restore effect must never read
  // window.location at effect time — it would see its own params stripped.
  const urlSnapshotRef = useRef<URLSearchParams | null>(null);
  if (urlSnapshotRef.current === null) {
    urlSnapshotRef.current = new URLSearchParams(window.location.search);
  }
  const losUrlRestoredRef = useRef(false);
  const traceUrlRestoredRef = useRef(false);

  // Keep ?tool=los&from&to&fh&th&fq in sync with the analysis
  useEffect(() => {
    // Hold all writes (including the strip branch) until the mount restore ran
    if (!losUrlRestoredRef.current) return;
    const showing =
      activeTool === "los" && toolStep === "result" &&
      (toolFromId || losState.losVirtualFrom) && (toolToId || losState.losVirtualTo);
    // Only strip when the URL currently claims tool=los — the traceroute
    // sync owns its own snapshot of the shared keys.
    const had = new URLSearchParams(window.location.search).get("tool") === "los";
    if (!showing && !had) return;
    writeToolParams((sp) => {
      if (showing) {
        sp.set("tool", "los");
        sp.set("from", toolFromId ?? `${losState.losVirtualFrom![1].toFixed(5)},${losState.losVirtualFrom![0].toFixed(5)}`);
        sp.set("to", toolToId ?? `${losState.losVirtualTo![1].toFixed(5)},${losState.losVirtualTo![0].toFixed(5)}`);
        sp.set("fh", String(losState.losFromHeightM));
        sp.set("th", String(losState.losToHeightM));
        sp.set("fq", String(losState.losFreqMhz));
      } else {
        for (const k of ["tool", "from", "to", "fh", "th", "fq"]) sp.delete(k);
      }
    });
  }, [activeTool, toolStep, toolFromId, toolToId, losState.losVirtualFrom, losState.losVirtualTo, losState.losFromHeightM, losState.losToHeightM, losState.losFreqMhz]);

  // Restore a shared LOS analysis from the URL snapshot (once, on mount)
  useEffect(() => {
    if (losUrlRestoredRef.current) return;
    losUrlRestoredRef.current = true;
    const sp = urlSnapshotRef.current ?? new URLSearchParams();
    if (sp.get("tool") !== "los") return;
    const parseEnd = (v: string | null): { id: string } | { pos: [number, number] } | null => {
      if (!v) return null;
      const m = v.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
      if (m) {
        const lat = Number(m[1]);
        const lng = Number(m[2]);
        return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { pos: [lng, lat] } : null;
      }
      return /^!?[0-9a-zA-Z_-]{1,32}$/.test(v) ? { id: v.replace(/^!/, "") } : null;
    };
    const f = parseEnd(sp.get("from"));
    const t = parseEnd(sp.get("to"));
    if (!f || !t) return;
    const num = (k: string, min: number, max: number): number | null => {
      const raw = sp.get(k);
      if (raw == null) return null;
      const n = Number(raw);
      return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : null;
    };
    const fh = num("fh", 0, 300);
    const th = num("th", 0, 300);
    const fq = num("fq", 100, 2500);
    // The sharer's values drive this session but must not overwrite the
    // viewer's saved defaults in localStorage.
    losState.markUrlAppliedSettings(
      fh ?? losState.losFromHeightM,
      th ?? losState.losToHeightM,
      fq ?? losState.losFreqMhz,
    );
    if (fh != null) losState.setLosFromHeightM(fh);
    if (th != null) losState.setLosToHeightM(th);
    if (fq != null) losState.setLosFreqMhz(fq);
    if ("id" in f) setToolFromId(f.id); else losState.setLosVirtualFrom(f.pos);
    if ("id" in t) setToolToId(t.id); else losState.setLosVirtualTo(t.pos);
    setActiveTool("los");
    setToolStep("result");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep ?tool=traceroute&from&to in sync
  useEffect(() => {
    if (!traceUrlRestoredRef.current) return;
    const showing = activeTool === "traceroute" && toolStep === "result" && !!toolFromId && !!toolToId;
    const had = new URLSearchParams(window.location.search).get("tool") === "traceroute";
    if (!showing && !had) return;
    writeToolParams((sp) => {
      if (showing) {
        sp.set("tool", "traceroute");
        sp.set("from", toolFromId);
        sp.set("to", toolToId);
        // play=1 is a one-shot request from a shared link — never persist it
        sp.delete("play");
      } else {
        for (const k of ["tool", "from", "to", "play"]) sp.delete(k);
      }
    });
  }, [activeTool, toolStep, toolFromId, toolToId]);

  // Restore a shared traceroute analysis from the URL snapshot (once, on mount)
  useEffect(() => {
    if (traceUrlRestoredRef.current) return;
    traceUrlRestoredRef.current = true;
    const sp = urlSnapshotRef.current ?? new URLSearchParams();
    if (sp.get("tool") !== "traceroute") return;
    const idOf = (v: string | null): string | null =>
      v && /^!?[0-9a-zA-Z_-]{1,32}$/.test(v) ? v.replace(/^!/, "") : null;
    const f = idOf(sp.get("from"));
    const t = idOf(sp.get("to"));
    if (!f || !t || f === t) {
      // Invalid share link: the write effect never re-runs (no state changed),
      // so strip the stale params here or they linger in the URL forever.
      writeToolParams((spx) => {
        for (const k of ["tool", "from", "to", "play"]) spx.delete(k);
      });
      return;
    }
    setToolFromId(f);
    setToolToId(t);
    setActiveTool("traceroute");
    setToolStep("result");
    if (sp.get("play") === "1") tracePendingPlayRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A shared link with play=1 starts the tour once data + positions are in.
  useEffect(() => {
    if (!tracePendingPlayRef.current) return;
    // The mount run precedes the restore's state commit — wait, don't clear.
    // The one-shot flag is dropped on the real exits: resetTool + path select.
    if (activeTool !== "traceroute" || toolStep !== "result") return;
    if (prefersReducedMotion()) {
      tracePendingPlayRef.current = false;
      return;
    }
    if (!traceSelectedPath) return; // traceroutes still loading — retry on next change
    if (startFlyover(traceSelectedPath)) tracePendingPlayRef.current = false;
    // tracePosKey: retries as hop positions stream in after a cold deep-link load
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTool, toolStep, traceSelectedPath, tracePosKey, styleEpoch]);
}
