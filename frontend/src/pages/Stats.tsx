import { useEffect, useMemo, useState } from "react";

import { HeardBy } from "../components/HeardBy";
import { useGetStatsQuery } from "../slices/apiSlice";

import {
  BarMeter,
  Icon,
  InsightRow,
  KpiCard,
  Panel,
  RingProgress,
  SkeletonKpiCard,
} from "./stats/StatsWidgets";

type StatsPayload = {
  active_nodes: number;
  total_nodes: number;
  total_chat: number;
  total_telemetry: number;
  total_traceroutes: number;
  total_messages: number;
  total_mqtt_messages: number;

  session_by_modem_preset?: Record<string, number>;
};

// ---------------------- small helpers ----------------------

async function copyTextToClipboard(text: string) {
  try {
    if (navigator.clipboard && (window as any).isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);

    ta.focus();
    ta.select();
    ta.setSelectionRange(0, ta.value.length);

    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function safeNum(n: any) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

function pickPreset(presets: Record<string, number> | undefined, names: string[]) {
  if (!presets) return 0;
  for (const n of names) {
    if (Number.isFinite(Number((presets as any)[n]))) return Number((presets as any)[n]);
  }
  return 0;
}

export const Stats = () => {
  // ---- Live polling ----
  // Adjust pollingInterval (e.g. 3000–10000ms).
  const {
    data: rawStats,
    isFetching,
    isError,
    fulfilledTimeStamp,
  } = useGetStatsQuery(undefined, {
    pollingInterval: 5000,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });

  const stats = rawStats as StatsPayload | undefined;

  const [copied, setCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);

  useEffect(() => {
    if (!exportOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExportOpen(false);
    };
    const onMouseDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest("[data-export-menu]")) return;
      setExportOpen(false);
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onMouseDown);
    };
  }, [exportOpen]);

  const derived = useMemo(() => {
    const active = safeNum(stats?.active_nodes);
    const nodes = safeNum(stats?.total_nodes);

    const chat = safeNum(stats?.total_chat);
    const telemetry = safeNum(stats?.total_telemetry);
    const traceroutes = safeNum(stats?.total_traceroutes);

    const session = safeNum(stats?.total_messages);

    // new: modem preset split
    const presetMap = stats?.session_by_modem_preset;
    const mediumFast = pickPreset(presetMap, [
      "MediumFast",
      "mediumfast",
      "Medium_Fast",
      "medium_fast",
    ]);
    const longFast = pickPreset(presetMap, [
      "LongFast",
      "longfast",
      "Long_Fast",
      "long_fast",
    ]);
    const presetTotal =
      presetMap && Object.keys(presetMap).length > 0
        ? Object.values(presetMap).reduce((a, b) => a + safeNum(b), 0)
        : mediumFast + longFast;

    const persistedTotal = chat + telemetry + traceroutes;

    const activeRatio = nodes > 0 ? active / nodes : 0;

    const msgsPerActive = active > 0 ? session / active : 0;
    const persistedPerNode = nodes > 0 ? persistedTotal / nodes : 0;

    return {
      active,
      nodes,
      chat,
      telemetry,
      traceroutes,
      persistedTotal,
      session,

      mediumFast,
      longFast,
      presetTotal,

      activeRatio: clamp01(activeRatio),
      msgsPerActive,
      persistedPerNode,
      hasPresetSplit: presetTotal > 0,
    };
  }, [stats]);

  const lastUpdatedLabel = useMemo(() => {
    if (!fulfilledTimeStamp) return null;
    try {
      return new Date(fulfilledTimeStamp).toLocaleTimeString();
    } catch {
      return null;
    }
  }, [fulfilledTimeStamp]);

  const onCopyLink = async () => {
    const ok = await copyTextToClipboard(window.location.href);
    if (!ok) return;

    setCopied(true);
    window.setTimeout(() => setCopied(false), 900);
  };

  const onExportJSON = () => {
    if (!stats) return;
    const blob = new Blob([JSON.stringify(stats, null, 2)], {
      type: "application/json",
    });
    downloadBlob(blob, "meshinfo-stats.json");
    setExportOpen(false);
  };

  const onExportCSV = () => {
    if (!stats) return;

    const rows: Array<[string, number]> = [
      ["active_nodes", safeNum(stats.active_nodes)],
      ["total_nodes", safeNum(stats.total_nodes)],
      ["total_chat", safeNum(stats.total_chat)],
      ["total_telemetry", safeNum(stats.total_telemetry)],
      ["total_traceroutes", safeNum(stats.total_traceroutes)],
      ["total_messages", safeNum(stats.total_messages)],
    ];

    // include preset split if available
    if (derived.hasPresetSplit) {
      rows.push(["session_mediumfast", derived.mediumFast]);
      rows.push(["session_longfast", derived.longFast]);
    }

    const csv =
      "metric,value\n" +
      rows.map(([k, v]) => `${k},${v}`).join("\n") +
      "\n";

    const blob = new Blob([csv], { type: "text/csv" });
    downloadBlob(blob, "meshinfo-stats.csv");
    setExportOpen(false);
  };

  const insights = useMemo(() => {
    const items: Array<{
      title: string;
      detail: string;
      tone?: "good" | "warn" | "info";
    }> = [];

    // Active ratio
    if (derived.nodes > 0) {
      const pct = Math.round(derived.activeRatio * 100);
      if (pct >= 65) {
        items.push({
          title: "Healthy presence",
          detail: `${pct}% of known nodes are active right now.`,
          tone: "good",
        });
      } else if (pct >= 35) {
        items.push({
          title: "Mixed activity",
          detail: `${pct}% of known nodes are active. Consider widening your time range on Nodes for context.`,
          tone: "info",
        });
      } else {
        items.push({
          title: "Low activity",
          detail: `${pct}% of known nodes are active. Check gateways, power, and coverage.`,
          tone: "warn",
        });
      }
    }

    // Session traffic
    if (derived.session > 0 && derived.active > 0) {
      const per = Math.round(derived.msgsPerActive);
      items.push({
        title: "Session chatter",
        detail: `~${per} session messages per active node.`,
        tone: per >= 10 ? "good" : "info",
      });
    }

    // Preset split
    if (derived.hasPresetSplit) {
      const mfPct = Math.round((derived.mediumFast / derived.presetTotal) * 100);
      const lfPct = Math.round((derived.longFast / derived.presetTotal) * 100);
      const dominant = derived.mediumFast >= derived.longFast ? "MediumFast" : "LongFast";
      items.push({
        title: "Traffic split",
        detail: `MediumFast ${mfPct}% • LongFast ${lfPct}% (dominant: ${dominant}).`,
        tone: "info",
      });
    } else {
      items.push({
        title: "Traffic split",
        detail:
          "Add session_by_modem_preset to /stats to unlock MediumFast vs LongFast insights.",
        tone: "info",
      });
    }

    // Data mix
    if (derived.persistedTotal > 0) {
      const top =
        derived.telemetry >= derived.chat && derived.telemetry >= derived.traceroutes
          ? "Telemetry"
          : derived.chat >= derived.traceroutes
          ? "Chat"
          : "Traceroutes";

      items.push({
        title: "Dominant stream",
        detail: `${top} is currently your largest persisted dataset.`,
        tone: "info",
      });
    }

    return items.slice(0, 5);
  }, [derived]);

  return (
    <div className="w-full px-4 py-5 lg:px-8 lg:py-6">
      <div className="mx-auto w-full max-w-[1400px]">
        {/* Header */}
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl font-semibold text-gray-100">Stats</h1>

              <span className="rounded-full border border-gray-800 bg-gray-950/40 px-2 py-0.5 text-[11px] text-gray-400">
                {isFetching ? "Updating…" : "Live"}
                {lastUpdatedLabel ? (
                  <span className="text-gray-600"> · {lastUpdatedLabel}</span>
                ) : null}
              </span>

              {isError ? (
                <span className="rounded-full border border-red-900/60 bg-red-950/30 px-2 py-0.5 text-[11px] text-red-300">
                  API error
                </span>
              ) : null}
            </div>

            <p className="mt-1 text-sm text-gray-400">
              Quick signal on your mesh — based on messages <HeardBy />.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onCopyLink}
              className="inline-flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/40 px-3 py-2 text-sm text-gray-200 hover:bg-gray-900/40 transition"
              title="Copy a shareable link"
            >
              <Icon name={copied ? "check" : "link"} />
              {copied ? "Copied" : "Copy link"}
            </button>

            <div className="relative" data-export-menu>
              <button
                type="button"
                onClick={() => setExportOpen((v) => !v)}
                className="inline-flex items-center gap-2 rounded-xl border border-gray-800 bg-gray-950/40 px-3 py-2 text-sm text-gray-200 hover:bg-gray-900/40 transition"
                title="Export stats"
              >
                <Icon name="download" />
                Export
                <span className="text-gray-500">▾</span>
              </button>

              {exportOpen && (
                <div className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-xl border border-gray-800 bg-gray-950/95 shadow-lg">
                  <button
                    type="button"
                    onClick={onExportJSON}
                    className="w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-900/60 transition"
                  >
                    Download JSON
                  </button>
                  <button
                    type="button"
                    onClick={onExportCSV}
                    className="w-full px-3 py-2 text-left text-sm text-gray-200 hover:bg-gray-900/60 transition"
                  >
                    Download CSV
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Hero */}
        <div className="mt-5">
          <Panel className="relative overflow-hidden">

            {!stats ? (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                <div className="lg:col-span-7">
                  <div className="h-6 w-56 rounded bg-gray-800/50" />
                  <div className="mt-3 h-4 w-96 rounded bg-gray-800/30" />
                  <div className="mt-6 grid grid-cols-2 gap-3">
                    <SkeletonKpiCard />
                    <SkeletonKpiCard />
                  </div>
                </div>
                <div className="lg:col-span-5 flex items-center justify-center">
                  <div className="h-40 w-40 rounded-full bg-gray-800/30" />
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-12 lg:items-center">
                <div className="lg:col-span-7">
                  <div className="flex items-center gap-2 text-xs text-gray-400">
                    <Icon name="pulse" />
                    Mesh pulse
                  </div>

                  <div className="mt-2 text-2xl font-semibold text-gray-100">
                    {derived.active} active nodes{" "}
                    <span className="text-gray-500">
                      out of {derived.nodes} known
                    </span>
                  </div>

                  <div className="mt-2 text-sm text-gray-400">
                    This dashboard is intentionally lightweight — it summarizes
                    what you can find in greater detail throughout MeshInfo.
                  </div>

                  <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <KpiCard
                      title="Session messages"
                      value={derived.session}
                      subtitle="since backend restart"
                      icon={<Icon name="inbox" />}
                      compact
                    />
                    <KpiCard
                      title="Persisted events"
                      value={derived.persistedTotal}
                      subtitle="chat + telemetry + traceroutes"
                      icon={<Icon name="database" />}
                      compact
                    />
                  </div>
                </div>

                <div className="lg:col-span-5 flex items-center justify-center">
                  <RingProgress
                    label="Active ratio"
                    value={derived.activeRatio}
                    centerTop={`${Math.round(derived.activeRatio * 100)}%`}
                    centerBottom="nodes active"
                    footerLeft="Active"
                    footerRight="Known"
                    footerLeftValue={derived.active}
                    footerRightValue={derived.nodes}
                  />
                </div>
              </div>
            )}
          </Panel>
        </div>

        {/* KPI grid */}
        <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {!stats ? (
            <>
              <SkeletonKpiCard />
              <SkeletonKpiCard />
              <SkeletonKpiCard />
              <SkeletonKpiCard />
              <SkeletonKpiCard />
              <SkeletonKpiCard />
            </>
          ) : (
            <>
              <KpiCard
                title="Known nodes"
                value={derived.nodes}
                subtitle="persisted inventory"
                icon={<Icon name="nodes" />}
                hint="Total distinct nodes seen historically."
              />
              <KpiCard
                title="Active nodes"
                value={derived.active}
                subtitle="currently online"
                icon={<Icon name="signal" />}
                hint="Online/active status derived by backend."
              />
              <KpiCard
                title="Chat messages"
                value={derived.chat}
                subtitle="channel 0"
                icon={<Icon name="chat" />}
                hint="Persisted chat messages, channel 0."
              />
              <KpiCard
                title="Telemetry samples"
                value={derived.telemetry}
                subtitle="sensor/metrics"
                icon={<Icon name="thermo" />}
                hint="All telemetry entries in storage."
              />
              <KpiCard
                title="Traceroutes"
                value={derived.traceroutes}
                subtitle="route events"
                icon={<Icon name="route" />}
                hint="All traceroute events persisted."
              />

              {/* Replaces "MQTT messages" */}
              <KpiCard
                title="Modem presets"
                value={
                  derived.hasPresetSplit ? (
                    <div className="space-y-1">
                      <div className="text-base text-gray-100">
                        MF{" "}
                        <span className="font-semibold">
                          {Math.round(derived.mediumFast).toLocaleString()}
                        </span>{" "}
                        <span className="text-gray-500">•</span>{" "}
                        LF{" "}
                        <span className="font-semibold">
                          {Math.round(derived.longFast).toLocaleString()}
                        </span>
                      </div>
                      <div className="text-xs text-gray-500">
                        this session (topic preset)
                      </div>
                    </div>
                  ) : (
                    <span className="text-gray-500">Add preset counts</span>
                  )
                }
                subtitle={derived.hasPresetSplit ? undefined : "backend enhancement"}
                icon={<Icon name="signal" />}
                hint="Requires /stats to include session_by_modem_preset."
              />
            </>
          )}
        </div>

        {/* Mix + Insights */}
        <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-12">
          <Panel className="lg:col-span-7">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-gray-100">Data mix</div>
              </div>
              <div className="text-xs text-gray-500">Derived from stored totals</div>
            </div>

            {!stats ? (
              <div className="mt-4 space-y-3">
                <div className="h-4 w-48 rounded bg-gray-800/30" />
                <div className="h-2 w-full rounded bg-gray-800/20" />
                <div className="h-4 w-56 rounded bg-gray-800/30" />
                <div className="h-2 w-full rounded bg-gray-800/20" />
                <div className="h-4 w-52 rounded bg-gray-800/30" />
                <div className="h-2 w-full rounded bg-gray-800/20" />
              </div>
            ) : (
              <div className="mt-4 space-y-3">
                <BarMeter
                  label="Telemetry"
                  value={derived.persistedTotal > 0 ? derived.telemetry / derived.persistedTotal : 0}
                  leftValue={derived.telemetry}
                  rightHint="of persisted"
                />
                <BarMeter
                  label="Chat"
                  value={derived.persistedTotal > 0 ? derived.chat / derived.persistedTotal : 0}
                  leftValue={derived.chat}
                  rightHint="of persisted"
                />
                <BarMeter
                  label="Traceroutes"
                  value={derived.persistedTotal > 0 ? derived.traceroutes / derived.persistedTotal : 0}
                  leftValue={derived.traceroutes}
                  rightHint="of persisted"
                />

                <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {/* Replaces MQTT share panel */}
                  <Panel className="p-4 bg-transparent border border-gray-800/60">
                    <div className="text-xs text-gray-400">Preset mix</div>

                    {derived.hasPresetSplit ? (
                      <div className="mt-2 space-y-3">
                        <BarMeter
                          label="MediumFast"
                          value={derived.presetTotal > 0 ? derived.mediumFast / derived.presetTotal : 0}
                          leftValue={derived.mediumFast}
                          rightHint="of session"
                        />
                        <BarMeter
                          label="LongFast"
                          value={derived.presetTotal > 0 ? derived.longFast / derived.presetTotal : 0}
                          leftValue={derived.longFast}
                          rightHint="of session"
                        />
                        <div className="mt-1 text-xs text-gray-500">
                          Total: {derived.presetTotal.toLocaleString()}
                        </div>
                      </div>
                    ) : (
                      <div className="mt-2 text-xs text-gray-500">
                        Add <span className="text-gray-300">session_by_modem_preset</span> to /stats.
                      </div>
                    )}
                  </Panel>

                  <Panel className="p-4 bg-transparent border border-gray-800/60">
                    <div className="text-xs text-gray-400">Density</div>
                    <div className="mt-2 text-2xl font-semibold text-gray-100">
                      {Math.round(derived.persistedPerNode)}
                    </div>
                    <div className="mt-1 text-xs text-gray-500">
                      persisted events per known node (avg)
                    </div>
                  </Panel>
                </div>
              </div>
            )}
          </Panel>

          <Panel className="lg:col-span-5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-sm font-medium text-gray-100">Quick insights</div>
              </div>
              <Icon name="spark" />
            </div>

            <div className="mt-4 space-y-2">
              {!stats ? (
                <>
                  <div className="h-10 w-full rounded bg-gray-800/20" />
                  <div className="h-10 w-full rounded bg-gray-800/20" />
                  <div className="h-10 w-full rounded bg-gray-800/20" />
                </>
              ) : insights.length === 0 ? (
                <div className="text-sm text-gray-400">No insights yet.</div>
              ) : (
                insights.map((i, idx) => (
                  <InsightRow
                    key={`ins-${idx}`}
                    title={i.title}
                    detail={i.detail}
                    tone={i.tone}
                  />
                ))
              )}
            </div>

            <div className="mt-5 rounded-xl border border-gray-800/60 bg-gray-950/30 p-3">
              <div className="text-xs font-medium text-gray-200">Pro tip</div>
              <div className="mt-1 text-xs text-gray-400">
                change this to something meaningful
              </div>
            </div>
          </Panel>
        </div>

        <div className="mt-6 text-xs text-gray-500">
          Stats reflect what the backend has ingested and persisted.
        </div>
      </div>
    </div>
  );
};
