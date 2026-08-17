import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { HeardBy } from "../components/HeardBy";
import { LivePill } from "../components/LivePill";
import {
  canonicalPresetName,
  FIRMWARE_MODEM_PRESETS,
  isFirmwarePreset,
} from "../meshtasticPresets";
import { useGetStatsQuery } from "../slices/apiSlice";
import { copyTextToClipboard } from "../utils/clipboard";
import { downloadBlob } from "../utils/export";
import {
  foldHardwareSlices,
  HARDWARE_TOP_N,
  hardwareSlicesFrom,
} from "./stats/hardwareMix";
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
  /** All-time gateway uplinks (#526) — mqtt_messages counts logical packets. */
  total_receptions?: number;

  session_by_modem_preset?: Record<string, number>;
  /** Nodes heard in the last 6 hours — same window as the map's online dot. */
  online_nodes?: number;
  /** Hardware split (#579), keyed by stringified HardwareModel enum id. */
  nodes_by_hardware?: Record<string, number>;
  online_nodes_by_hardware?: Record<string, number>;
};

// ---------------------- small helpers ----------------------

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function safeNum(n: any) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/** Firmware preset name -> two-letter chip ("MF", "LF", ...). */
const PRESET_SHORT: Record<string, string> = Object.fromEntries(
  FIRMWARE_MODEM_PRESETS.map((p) => [p.name, p.short])
);

/** Bars shown before the remainder collapses into "Other". */
const PRESET_TOP_N = 4;

type PresetSlice = {
  name: string;
  count: number;
  /** Wire name a human typed rather than a firmware preset (never true for "Other"). */
  custom: boolean;
};

/** Keys are topic channel-name segments: canonicalize, sort busiest-first, fold past top N into "Other". */
function presetSlicesFrom(presets: Record<string, number> | undefined): PresetSlice[] {
  const counts = new Map<string, number>();
  for (const [key, raw] of Object.entries(presets ?? {})) {
    const n = safeNum(raw);
    if (n <= 0) continue;
    const name = canonicalPresetName(key);
    counts.set(name, (counts.get(name) ?? 0) + n);
  }

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const slices: PresetSlice[] = sorted
    .slice(0, PRESET_TOP_N)
    .map(([name, count]) => ({ name, count, custom: !isFirmwarePreset(name) }));

  const other = sorted
    .slice(PRESET_TOP_N)
    .reduce((acc, [, count]) => acc + count, 0);
  if (other > 0) slices.push({ name: "Other", count: other, custom: false });

  return slices;
}

export const Stats = () => {
  // ---- Live polling ----
  const [liveEnabled, setLiveEnabled] = useState(true);

  const {
    data: rawStats,
    isFetching,
    isError,
    refetch,
  } = useGetStatsQuery(undefined, {
    pollingInterval: liveEnabled ? 5000 : 0,
    refetchOnFocus: liveEnabled,
    refetchOnReconnect: liveEnabled,
  });

  const stats = rawStats as StatsPayload | undefined;

  // Hardware mix scope: online (6h, like the map) vs the whole inventory.
  const [hwScope, setHwScope] = useState<"online" | "all">("online");
  const [hwExpanded, setHwExpanded] = useState(false);

  const [copied, setCopied] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  // click-outside for export menu
  useEffect(() => {
    if (!exportOpen) return;

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (exportMenuRef.current && !exportMenuRef.current.contains(t)) {
        setExportOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExportOpen(false);
    };

    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [exportOpen]);

  // Manual refresh
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const doManualRefresh = useCallback(() => {
    if (manualRefreshing) return;
    setManualRefreshing(true);
    Promise.resolve(refetch()).finally(() => {
      window.setTimeout(() => setManualRefreshing(false), 250);
    });
  }, [refetch, manualRefreshing]);

  // Live pill helpers
  const livePillTitle = useMemo(() => {
    if (!liveEnabled)
      return "Live mode is off. Auto-refresh is disabled. Click to enable.";
    return "Live mode is on. Auto-refresh polls every 5 seconds. Click to disable.";
  }, [liveEnabled]);

  const derived = useMemo(() => {
    const active = safeNum(stats?.active_nodes);
    const nodes = safeNum(stats?.total_nodes);
    const online = safeNum(stats?.online_nodes);

    const chat = safeNum(stats?.total_chat);
    const telemetry = safeNum(stats?.total_telemetry);
    const traceroutes = safeNum(stats?.total_traceroutes);

    const session = safeNum(stats?.total_messages);
    const receptions = safeNum(stats?.total_receptions);

    // modem preset split
    const presetSlices = presetSlicesFrom(stats?.session_by_modem_preset);
    const presetTotal = presetSlices.reduce((acc, s) => acc + s.count, 0);

    // hardware split (unfolded — commonest first)
    const hardwareOnlineSlices = hardwareSlicesFrom(stats?.online_nodes_by_hardware);
    const hardwareAllSlices = hardwareSlicesFrom(stats?.nodes_by_hardware);
    const hardwareOnlineTotal = hardwareOnlineSlices.reduce((acc, s) => acc + s.count, 0);
    const hardwareAllTotal = hardwareAllSlices.reduce((acc, s) => acc + s.count, 0);

    const persistedTotal = chat + telemetry + traceroutes;

    const activeRatio = nodes > 0 ? active / nodes : 0;

    const msgsPerActive = active > 0 ? session / active : 0;
    const persistedPerNode = nodes > 0 ? persistedTotal / nodes : 0;

    return {
      active,
      nodes,
      online,
      chat,
      telemetry,
      traceroutes,
      persistedTotal,
      session,
      receptions,

      presetSlices,
      presetTotal,

      hardwareOnlineSlices,
      hardwareAllSlices,
      hardwareOnlineTotal,
      hardwareAllTotal,

      activeRatio: clamp01(activeRatio),
      msgsPerActive,
      persistedPerNode,
      hasPresetSplit: presetTotal > 0,
    };
  }, [stats]);

  const onCopyLink = useCallback(async () => {
    const ok = await copyTextToClipboard(window.location.href);
    if (!ok) return;

    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, []);

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
      ["total_mqtt_messages", safeNum(stats.total_mqtt_messages)],
      ["total_receptions", safeNum(stats.total_receptions)],
    ];

    for (const s of derived.presetSlices) {
      // custom wire names may hold anything — keep the CSV key plain
      rows.push([`preset_${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_24h`, s.count]);
    }

    for (const s of derived.hardwareAllSlices) {
      // _all: counts every known node, not just the panel's selected scope
      rows.push([`hardware_${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}_all`, s.count]);
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

    // Active ratio. "Known" includes stub-only nodes, so a healthy mesh sits in the 25-50% band.
    if (derived.nodes > 0) {
      const pct = Math.round(derived.activeRatio * 100);
      if (pct >= 50) {
        items.push({
          title: "Healthy presence",
          detail: `${pct}% of known nodes have been active recently.`,
          tone: "good",
        });
      } else if (pct >= 20) {
        items.push({
          title: "Typical activity",
          detail: `${pct}% of known nodes have been active recently.`,
          tone: "info",
        });
      } else {
        items.push({
          title: "Low activity",
          detail: `${pct}% of known nodes have been active recently. Worth checking gateways or coverage.`,
          tone: "warn",
        });
      }
    }

    // Preset split — slices are busiest-first, so [0] is the dominant channel
    if (derived.hasPresetSplit) {
      const parts = derived.presetSlices
        .slice(0, 3)
        .map((s) => `${s.name} ${Math.round((s.count / derived.presetTotal) * 100)}%`);
      items.push({
        title: "Traffic split (24h)",
        detail: `${parts.join(" • ")} (dominant: ${derived.presetSlices[0].name}).`,
        tone: "info",
      });
    } else {
      items.push({
        title: "Traffic split",
        detail: "No MQTT traffic recorded in the last 24 hours — preset split unavailable.",
        tone: "info",
      });
    }

    // Hardware mix — prefer the on-air fleet, fall back to the whole inventory
    const hwSlices =
      derived.hardwareOnlineTotal > 0
        ? derived.hardwareOnlineSlices
        : derived.hardwareAllSlices;
    const hwTotal =
      derived.hardwareOnlineTotal > 0
        ? derived.hardwareOnlineTotal
        : derived.hardwareAllTotal;
    if (hwTotal > 0) {
      const top = hwSlices[0];
      const pct = Math.round((top.count / hwTotal) * 100);
      const scope = derived.hardwareOnlineTotal > 0 ? "online" : "known";
      items.push({
        title: "Fleet hardware",
        detail: `${top.name} is the most common hardware — ${pct}% of ${scope} nodes that report it.`,
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

  // Hardware panel view of the selected scope
  const hwPanelAllSlices =
    hwScope === "online" ? derived.hardwareOnlineSlices : derived.hardwareAllSlices;
  const hwPanelSlices = hwExpanded
    ? hwPanelAllSlices
    : foldHardwareSlices(hwPanelAllSlices);
  const hwPanelTotal =
    hwScope === "online" ? derived.hardwareOnlineTotal : derived.hardwareAllTotal;
  const hwPanelPopulation = Math.max(
    hwScope === "online" ? derived.online : derived.nodes,
    hwPanelTotal
  );

  return (
    <div className="w-full h-dvh overflow-hidden flex flex-col">
      {/* ── Sticky header (matches Nodes) ── */}
      <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur-sm border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-400 px-3 sm:px-5 py-2 sm:py-3">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Stats
              </h1>

              {/* Desktop meta row */}
              <div className="mt-1 hidden sm:flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className={isFetching || manualRefreshing ? "animate-pulse" : ""}>
                  {isFetching || manualRefreshing ? "Refreshing…" : "Ready"}
                </span>

                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={doManualRefresh}
                >
                  refresh
                </button>

                <LivePill
                  mode={liveEnabled ? "live" : "off"}
                  onToggle={() => setLiveEnabled((v) => !v)}
                  title={livePillTitle}
                />

                <span className="opacity-60">•</span>

                <HeardBy />

                {isError ? (
                  <>
                    <span className="opacity-60">•</span>
                    <span className="text-red-600 dark:text-red-400 font-medium">
                      API error
                    </span>
                  </>
                ) : null}
              </div>

              {/* Mobile meta row */}
              <div className="mt-1 flex sm:hidden flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className={isFetching || manualRefreshing ? "animate-pulse" : ""}>
                  {isFetching || manualRefreshing ? "Refreshing…" : "Ready"}
                </span>

                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={doManualRefresh}
                >
                  refresh
                </button>

                <LivePill
                  mode={liveEnabled ? "live" : "off"}
                  onToggle={() => setLiveEnabled((v) => !v)}
                  title={livePillTitle}
                />

                {isError ? (
                  <>
                    <span className="opacity-60">•</span>
                    <span className="text-red-600 dark:text-red-400 font-medium">
                      API error
                    </span>
                  </>
                ) : null}
              </div>
            </div>

            {/* Desktop action buttons */}
            <div className="hidden sm:flex items-center gap-2">
              <div className="relative" ref={exportMenuRef}>
                <button
                  type="button"
                  onClick={() => setExportOpen((v) => !v)}
                  className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  title="Export stats"
                >
                  Export <span className="text-gray-400 dark:text-gray-500">▾</span>
                </button>

                {exportOpen && (
                  <div className="absolute right-0 z-20 mt-2 w-44 overflow-hidden rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950/95 shadow-lg">
                    <button
                      type="button"
                      onClick={onExportJSON}
                      className="w-full px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-900/60 transition"
                    >
                      Download JSON
                    </button>
                    <button
                      type="button"
                      onClick={onExportCSV}
                      className="w-full px-3 py-2 text-left text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-900/60 transition"
                    >
                      Download CSV
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={onCopyLink}
                title="Copy a shareable link"
              >
                {copied ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="mx-auto max-w-400 px-4 py-5 lg:px-8 lg:py-6">
          {/* Hero */}
          <div>
            <Panel className="relative overflow-hidden">
              {!stats ? (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                  <div className="lg:col-span-7">
                    <div className="h-6 w-56 rounded-sm bg-gray-800/50" />
                    <div className="mt-3 h-4 w-96 rounded-sm bg-gray-800/30" />
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
                    <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                      <Icon name="pulse" />
                      Mesh pulse
                    </div>

                    <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-gray-100">
                      {derived.active} active nodes{" "}
                      <span className="text-gray-400 dark:text-gray-500">
                        out of {derived.nodes} known
                      </span>
                    </div>

                    <div className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                      This dashboard is intentionally lightweight — it summarizes
                      what you can find in greater detail throughout MeshInfo.
                    </div>

                    <div className="mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <KpiCard
                        title="Logged packets"
                        value={derived.session}
                        subtitle="all-time logical packets (deduplicated)"
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
                      {derived.receptions > 0 ? (
                        <KpiCard
                          title="Gateway uplinks"
                          value={derived.receptions}
                          subtitle="all-time per-gateway receptions"
                          icon={<Icon name="pulse" />}
                          compact
                        />
                      ) : null}
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
                  subtitle="recently heard"
                  icon={<Icon name="signal" />}
                  hint="Nodes with a last_seen newer than the configured prune threshold (server.node_activity_prune_threshold, default 3 days)."
                />
                <KpiCard
                  title="Chat messages"
                  value={derived.chat}
                  subtitle="all channels"
                  icon={<Icon name="chat" />}
                  hint="Persisted chat messages across every channel."
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

                <KpiCard
                  title="Modem presets"
                  value={
                    derived.hasPresetSplit ? (
                      <div className="space-y-1">
                        <div className="text-base text-gray-900 dark:text-gray-100">
                          {derived.presetSlices.slice(0, 3).map((s, i) => (
                            <span key={s.name}>
                              {i > 0 ? (
                                <span className="text-gray-400 dark:text-gray-500">
                                  {" "}
                                  •{" "}
                                </span>
                              ) : null}
                              {PRESET_SHORT[s.name] ?? s.name}{" "}
                              <span className="font-semibold">
                                {Math.round(s.count).toLocaleString()}
                              </span>
                            </span>
                          ))}
                        </div>
                        <div className="text-xs text-gray-400 dark:text-gray-500">
                          last 24h (topic preset)
                        </div>
                      </div>
                    ) : (
                      <span className="text-gray-400 dark:text-gray-500">No traffic in 24h</span>
                    )
                  }
                  subtitle={derived.hasPresetSplit ? undefined : "topic preset split"}
                  icon={<Icon name="signal" />}
                  hint="Busiest modem presets (topic channel-name segment) seen on MQTT in the last 24 hours."
                />
              </>
            )}
          </div>

          {/* Mix + Insights */}
          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-12">
            <Panel className="lg:col-span-7">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Data mix</div>
                </div>
                <div className="text-xs text-gray-400 dark:text-gray-500">Derived from stored totals</div>
              </div>

              {!stats ? (
                <div className="mt-4 space-y-3">
                  <div className="h-4 w-48 rounded-sm bg-gray-800/30" />
                  <div className="h-2 w-full rounded-sm bg-gray-800/20" />
                  <div className="h-4 w-56 rounded-sm bg-gray-800/30" />
                  <div className="h-2 w-full rounded-sm bg-gray-800/20" />
                  <div className="h-4 w-52 rounded-sm bg-gray-800/30" />
                  <div className="h-2 w-full rounded-sm bg-gray-800/20" />
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
                    <Panel className="p-4 bg-transparent border border-gray-200 dark:border-gray-800/60">
                      <div className="text-xs text-gray-600 dark:text-gray-400">Preset mix</div>

                      {derived.hasPresetSplit ? (
                        <div className="mt-2 space-y-3">
                          {derived.presetSlices.map((s) => (
                            <BarMeter
                              key={s.name}
                              label={s.custom ? `${s.name} (custom)` : s.name}
                              value={derived.presetTotal > 0 ? s.count / derived.presetTotal : 0}
                              leftValue={s.count}
                              rightHint="of last 24h"
                            />
                          ))}
                          <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                            Total: {derived.presetTotal.toLocaleString()} packets in 24h
                          </div>
                        </div>
                      ) : (
                        <div className="mt-2 text-xs text-gray-400 dark:text-gray-500">
                          No MQTT traffic recorded in the last 24 hours.
                        </div>
                      )}
                    </Panel>

                    <Panel className="p-4 bg-transparent border border-gray-200 dark:border-gray-800/60">
                      <div className="text-xs text-gray-600 dark:text-gray-400">Density</div>
                      <div className="mt-2 text-2xl font-semibold text-gray-900 dark:text-gray-100">
                        {Math.round(derived.persistedPerNode)}
                      </div>
                      <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                        persisted events per known node (avg)
                      </div>
                    </Panel>
                  </div>
                </div>
              )}
            </Panel>

            <div className="lg:col-span-5 flex flex-col gap-4">
            <Panel>
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Hardware</div>

                <div className="flex items-center gap-1 text-xs" role="group" aria-label="Hardware scope">
                  <button
                    type="button"
                    aria-pressed={hwScope === "online"}
                    onClick={() => setHwScope("online")}
                    className={
                      "rounded-md px-2 py-1 border transition " +
                      (hwScope === "online"
                        ? "border-indigo-500/50 bg-indigo-600/15 text-indigo-700 dark:text-indigo-300"
                        : "border-gray-300/60 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100/60 dark:hover:bg-gray-800/40")
                    }
                    title="Hardware of nodes heard in the last 6 hours — same window as the map"
                  >
                    Online
                  </button>
                  <button
                    type="button"
                    aria-pressed={hwScope === "all"}
                    onClick={() => setHwScope("all")}
                    className={
                      "rounded-md px-2 py-1 border transition " +
                      (hwScope === "all"
                        ? "border-indigo-500/50 bg-indigo-600/15 text-indigo-700 dark:text-indigo-300"
                        : "border-gray-300/60 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-100/60 dark:hover:bg-gray-800/40")
                    }
                    title="Hardware across the whole persisted inventory"
                  >
                    All known
                  </button>
                </div>
              </div>

              {!stats ? (
                <div className="mt-4 space-y-3">
                  <div className="h-4 w-40 rounded-sm bg-gray-800/30" />
                  <div className="h-2 w-full rounded-sm bg-gray-800/20" />
                  <div className="h-4 w-48 rounded-sm bg-gray-800/30" />
                  <div className="h-2 w-full rounded-sm bg-gray-800/20" />
                </div>
              ) : hwPanelTotal > 0 ? (
                <div className="mt-4 space-y-3">
                  {hwPanelSlices.map((s) => (
                    <BarMeter
                      key={s.name}
                      label={s.name}
                      value={s.count / hwPanelTotal}
                      leftValue={s.count}
                      rightHint="nodes"
                    />
                  ))}
                  <div className="mt-1 text-xs text-gray-400 dark:text-gray-500">
                    {hwPanelTotal.toLocaleString()} of {hwPanelPopulation.toLocaleString()}{" "}
                    {hwScope === "online" ? "online" : "known"} nodes report hardware
                  </div>
                  {hwPanelAllSlices.length > HARDWARE_TOP_N ? (
                    <button
                      type="button"
                      aria-expanded={hwExpanded}
                      onClick={() => setHwExpanded((v) => !v)}
                      className="w-full flex items-center justify-center gap-1 rounded-md px-2 py-1 text-xs text-gray-500 dark:text-gray-400 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                    >
                      {hwExpanded
                        ? `Show top ${HARDWARE_TOP_N}`
                        : `Show all ${hwPanelAllSlices.length} models`}
                      <svg
                        className={
                          "h-3 w-3 transition-transform " +
                          (hwExpanded ? "rotate-180" : "")
                        }
                        viewBox="0 0 24 24"
                        fill="none"
                        aria-hidden="true"
                      >
                        <path
                          d="M6 9l6 6 6-6"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  ) : null}
                </div>
              ) : (
                <div className="mt-4 text-xs text-gray-400 dark:text-gray-500">
                  {hwScope === "online"
                    ? "No online node has reported hardware yet."
                    : "No node has reported hardware yet."}
                </div>
              )}
            </Panel>

            <Panel>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-medium text-gray-900 dark:text-gray-100">Quick insights</div>
                </div>
                <Icon name="spark" />
              </div>

              <div className="mt-4 space-y-2">
                {!stats ? (
                  <>
                    <div className="h-10 w-full rounded-sm bg-gray-800/20" />
                    <div className="h-10 w-full rounded-sm bg-gray-800/20" />
                    <div className="h-10 w-full rounded-sm bg-gray-800/20" />
                  </>
                ) : insights.length === 0 ? (
                  <div className="text-sm text-gray-600 dark:text-gray-400">No insights yet.</div>
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

              <div className="mt-5 rounded-xl border border-gray-200 dark:border-gray-800/60 bg-gray-50 dark:bg-gray-950/30 p-3">
                <div className="text-xs font-medium text-gray-800 dark:text-gray-200">Tip</div>
                <div className="mt-1 text-xs text-gray-600 dark:text-gray-400">
                  For per-node detail, drill into the Nodes page. Stats here are global rollups —
                  useful for spotting trends, less so for chasing individual nodes.
                </div>
              </div>
            </Panel>
            </div>
          </div>

          <div className="mt-6 text-xs text-gray-400 dark:text-gray-500">
            Stats reflect what the backend has ingested and persisted.
          </div>
        </div>
      </div>
    </div>
  );
};
