import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";

import { HeardBy } from "../components/HeardBy";
import {
  useGetConfigQuery,
  useGetMessagesQuery,
  useGetMqttMessagesQuery,
} from "../slices/apiSlice";
import { formatTimestamp } from "../utils/formatTimestamp";
import hljs from "highlight.js/lib/core";
import json from "highlight.js/lib/languages/json";
import "highlight.js/styles/github-dark-dimmed.css";

type RangeKey = "1h" | "24h" | "7d" | "all";
type SortKey = "desc" | "asc";
type RowViewKey = "mesh" | "raw"; // "raw" == mqtt raw

const DEFAULT_RANGE: RangeKey = "all";
const DEFAULT_SORT: SortKey = "desc";

type ViewDef = {
  key: string;
  label: string;
  short?: string;
  aliases: string[];
  tooltip?: string;
  isDefault?: boolean;
};

const normalizeKey = (s: string) => {
  const raw = String(s ?? "").trim().toLowerCase();
  const k = raw.replace(/[^a-z0-9]+/g, "");
  if (!k) return "";
  if (k.startsWith("all")) return "all";
  return k;
};

const toUnixSeconds = (ts: any): number => {
  if (ts == null) return 0;
  const n = Number(ts);
  if (!Number.isFinite(n)) return 0;
  if (n > 1_000_000_000_000) return Math.floor(n / 1000);
  return Math.floor(n);
};

const csvEscape = (v: any) => {
  const s = String(v ?? "");
  if (/[,"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const downloadBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
};

hljs.registerLanguage("json", json);

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
    ta.setSelectionRange(0, text.length);

    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function StatusChip({
  label,
  active,
  title,
  onClick,
}: {
  label: string;
  active?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  const clickable = !!onClick && !!active;

  return (
    <button
      type="button"
      onClick={clickable ? onClick : undefined}
      disabled={!clickable}
      title={title}
      className={[
        "rounded-full px-3 py-1 text-xs border transition whitespace-nowrap",
        "border-gray-300/60 dark:border-gray-700",
        clickable
          ? "text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40"
          : "text-gray-500 dark:text-gray-500 opacity-70 cursor-default",
        active ? "bg-white/5 dark:bg-gray-800/30 opacity-100" : "bg-transparent",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

function MobileSheet({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 lg:hidden">
      <button
        type="button"
        className="absolute inset-0 bg-black/40"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="absolute inset-x-0 bottom-0">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 pb-[env(safe-area-inset-bottom)]">
          <div className="rounded-t-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {title}
              </div>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={onClose}
              >
                Close
              </button>
            </div>
            <div className="max-h-[82dvh] overflow-y-auto">
              <div className="p-4">{children}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type Prepared = {
  key: string;
  matchKey: string;
  ts: number;
  topic: string;
  preset: string;
  raw: any;
  searchText: string;
};

type GroupedRow = {
  key: string; // matchKey (stable across both)
  ts: number;
  topic: string;
  preset: string;
  mesh?: Prepared;
  mqtt?: Prepared;
  searchText: string;
};

const matchKeyFor = (
  src: "mesh" | "mqtt",
  raw: any,
  ts: number,
  topic: string,
  idx: number,
) => {
  const id = raw?.id ?? raw?.packet?.id ?? raw?.raw?.id;
  const from = raw?.from ?? raw?.packet?.from ?? raw?.raw?.from;
  const typ = raw?.type ?? raw?.packet?.type ?? raw?.raw?.type;

  // strongest: topic + id
  if (topic && id != null) return `t:${topic}|id:${String(id)}`;

  // next: topic + from + ts + type
  if (topic && from != null) {
    return `t:${topic}|from:${String(from)}|ts:${ts}|type:${String(typ ?? "")}`;
  }

  // fallback: per-source uniqueness
  return `src:${src}|t:${topic || "?"}|ts:${ts}|i:${idx}`;
};

function JsonBlock({ code }: { code: string }) {
  const html = useMemo(() => {
    try {
      // highlight.js escapes content and returns HTML spans
      return hljs.highlight(code, { language: "json" }).value;
    } catch {
      // fallback: no highlight
      return code
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }
  }, [code]);

  return (
    <pre className="mt-3 rounded-lg border border-gray-200 dark:border-gray-800 bg-white/70 dark:bg-gray-950/40 p-3 text-xs font-mono text-gray-800 dark:text-gray-200 overflow-x-auto">
      <code
        className="hljs"
        style={{ background: "transparent" }} // prevent theme bg from fighting card bg
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </pre>
  );
}

export const Log = () => {
  const {
    data: rawMesh = [],
    fulfilledTimeStamp: meshUpdatedAt,
    isFetching: meshFetching,
    refetch: refetchMesh,
  } = useGetMessagesQuery();

  const {
    data: rawMqtt = [],
    fulfilledTimeStamp: mqttUpdatedAt,
    isFetching: mqttFetching,
    refetch: refetchMqtt,
  } = useGetMqttMessagesQuery();

  const { data: config } = useGetConfigQuery();

  const dataUpdatedAt = Math.max(meshUpdatedAt ?? 0, mqttUpdatedAt ?? 0);
  const isFetching = meshFetching || mqttFetching;

  const [searchParams, setSearchParams] = useSearchParams();

  // URL defaults to match UI defaults by omitting default params.
  const defaultViewKey = "all";

  const isDefaultParam = useCallback(
    (key: string, value: string) => {
      if (key === "ch" && value === defaultViewKey) return true;
      if (key === "r" && (value as RangeKey) === DEFAULT_RANGE) return true;
      if (key === "s" && (value as SortKey) === DEFAULT_SORT) return true;
      if (key === "q" && value.trim() === "") return true;
      return false;
    },
    [defaultViewKey],
  );

  const setParam = useCallback(
    (key: string, value: string | undefined, mode: "push" | "replace") => {
      const sp = new URLSearchParams(searchParams);
      const v = value == null ? "" : String(value);

      if (!v || isDefaultParam(key, v)) sp.delete(key);
      else sp.set(key, v);

      setSearchParams(sp, { replace: mode === "replace" });
    },
    [searchParams, setSearchParams, isDefaultParam],
  );

  const setParams = useCallback(
    (
      pairs: Array<{ key: string; value: string | undefined }>,
      mode: "push" | "replace",
    ) => {
      const sp = new URLSearchParams(searchParams);
      for (const p of pairs) {
        const v = p.value == null ? "" : String(p.value);
        if (!v || isDefaultParam(p.key, v)) sp.delete(p.key);
        else sp.set(p.key, v);
      }
      setSearchParams(sp, { replace: mode === "replace" });
    },
    [searchParams, setSearchParams, isDefaultParam],
  );

  // views from config (same pattern as MeshLog/MqttLog)
  const views: ViewDef[] = useMemo(() => {
    const vraw = (config?.broker?.channels as any)?.views;
    const out: ViewDef[] = [];

    out.push({
      key: "all",
      label: "All",
      short: "All",
      aliases: ["all"],
      tooltip: "Show messages from all modem presets",
      isDefault: false,
    });

    if (Array.isArray(vraw) && vraw.length > 0) {
      for (const v of vraw) {
        const chans = Array.isArray(v?.channels) ? v.channels.map(String) : [];
        if (chans.length !== 1) continue;

        const label = String(v?.label ?? v?.id ?? "");
        const short = v?.short ? String(v.short) : undefined;
        const key =
          normalizeKey(label) || normalizeKey(String(v?.id ?? "")) || "";
        if (!key) continue;

        const aliases = [
          key,
          String(v?.id ?? ""),
          String(v?.short ?? ""),
          label,
          normalizeKey(String(v?.id ?? "")),
          normalizeKey(String(v?.short ?? "")),
          normalizeKey(label),
        ]
          .map((x) => normalizeKey(String(x ?? "")))
          .filter(Boolean);

        out.push({
          key,
          label: label || key,
          short,
          aliases: Array.from(new Set(aliases)),
          tooltip: [
            `${label}${short ? ` • ${short}` : ""}`,
            v?.description ? String(v.description) : "",
          ]
            .filter(Boolean)
            .join("\n"),
          isDefault: !!v?.default,
        });
      }
    }

    return out;
  }, [config]);

  // preset alias map
  const aliasToKey = useMemo(() => {
    const m = new Map<string, string>();
    for (const v of views) {
      if (v.key === "all") continue;
      m.set(normalizeKey(v.key), v.key);
      for (const a of v.aliases) m.set(normalizeKey(a), v.key);
      m.set(normalizeKey(v.label), v.key);
      if (v.short) m.set(normalizeKey(v.short), v.key);
    }
    return m;
  }, [views]);

  const derivePresetKey = useCallback(
    (topic: string) => {
      const segs = String(topic ?? "").split("/").filter(Boolean);
      for (const seg of segs) {
        const nk = normalizeKey(seg);
        if (!nk) continue;
        const hit = aliasToKey.get(nk);
        if (hit) return hit;
      }
      return "unknown";
    },
    [aliasToKey],
  );

  // URL params
  const urlChRaw = searchParams.get("ch") ?? "";
  const urlChNorm = normalizeKey(urlChRaw);

  const selectedViewKey = useMemo(() => {
    if (!urlChNorm) return defaultViewKey;
    if (urlChNorm === "all") return defaultViewKey;
    const hit =
      views.find((v) => v.key === urlChNorm) ??
      views.find((v) => v.aliases.includes(urlChNorm));
    return hit?.key ?? defaultViewKey;
  }, [urlChNorm, views, defaultViewKey]);

  const selectedView = useMemo(
    () => views.find((v) => v.key === selectedViewKey) ?? views[0],
    [views, selectedViewKey],
  );

  const urlRange = (searchParams.get("r") as RangeKey) || DEFAULT_RANGE;
  const urlSort = (searchParams.get("s") as SortKey) || DEFAULT_SORT;
  const urlQ = searchParams.get("q") ?? "";

  // Search input (deferred)
  const [qInput, setQInput] = useState(urlQ);
  const qDeferred = useDeferredValue(qInput);

  useEffect(() => {
    setQInput(urlQ);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlQ]);

  useEffect(() => {
    if ((searchParams.get("q") ?? "") === qDeferred) return;
    setParam("q", qDeferred || undefined, "replace");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDeferred]);

  const [copiedLink, setCopiedLink] = useState(false);
  const copyLink = useCallback(async () => {
    const url = window.location.href;
    const ok = await copyTextToClipboard(url);
    if (ok) {
      setCopiedLink(true);
      window.setTimeout(() => setCopiedLink(false), 1200);
      return;
    }
    window.prompt("Copy link:", url);
  }, []);

  const nowSec = Math.floor(Date.now() / 1000);
  const rangeThreshold = useMemo(() => {
    switch (urlRange) {
      case "1h":
        return nowSec - 3600;
      case "24h":
        return nowSec - 86400;
      case "7d":
        return nowSec - 604800;
      case "all":
      default:
        return undefined;
    }
  }, [nowSec, urlRange]);

  const preparedMesh: Prepared[] = useMemo(() => {
    return (rawMesh as any[]).map((m, idx) => {
      const ts = toUnixSeconds(m?.timestamp);
      const topic = String(m?.topic ?? "");
      const preset = topic ? derivePresetKey(topic) : "unknown";

      let json = "";
      try {
        json = JSON.stringify(m);
      } catch {
        json = String(m ?? "");
      }

      const matchKey = matchKeyFor("mesh", m, ts, topic, idx);
      const key = String(m?.id ?? "") || `mesh|${matchKey}|${idx}`;

      return {
        key,
        matchKey,
        ts,
        topic,
        preset,
        raw: m,
        searchText: `${topic}\n${json}`.toLowerCase(),
      };
    });
  }, [rawMesh, derivePresetKey]);

  const preparedMqtt: Prepared[] = useMemo(() => {
    return (rawMqtt as any[]).map((m, idx) => {
      const ts = toUnixSeconds(m?.timestamp);
      const topic = String(m?.topic ?? "");
      const preset = topic ? derivePresetKey(topic) : "unknown";

      let json = "";
      try {
        json = JSON.stringify(m);
      } catch {
        json = String(m ?? "");
      }

      const matchKey = matchKeyFor("mqtt", m, ts, topic, idx);
      const key = String(m?.id ?? "") || `mqtt|${matchKey}|${idx}`;

      return {
        key,
        matchKey,
        ts,
        topic,
        preset,
        raw: m,
        searchText: `${topic}\n${json}`.toLowerCase(),
      };
    });
  }, [rawMqtt, derivePresetKey]);

  const grouped: GroupedRow[] = useMemo(() => {
    const map = new Map<string, GroupedRow>();

    const upsert = (kind: "mesh" | "mqtt", p: Prepared) => {
      const k = p.matchKey;
      const cur = map.get(k);

      const topic = p.topic || cur?.topic || "";
      const preset =
        p.preset !== "unknown" ? p.preset : cur?.preset || p.preset || "unknown";
      const ts = Math.max(cur?.ts ?? 0, p.ts ?? 0);

      const next: GroupedRow = {
        key: k,
        ts,
        topic,
        preset,
        mesh: cur?.mesh,
        mqtt: cur?.mqtt,
        searchText: "",
      };

      if (kind === "mesh") next.mesh = p;
      else next.mqtt = p;

      // combined search text
      const parts = [topic, next.mesh?.searchText ?? "", next.mqtt?.searchText ?? ""].filter(
        Boolean,
      );

      next.searchText = parts.join("\n").toLowerCase();

      map.set(k, next);
    };

    for (const p of preparedMesh) upsert("mesh", p);
    for (const p of preparedMqtt) upsert("mqtt", p);

    return [...map.values()];
  }, [preparedMesh, preparedMqtt]);

  // Logs page shows processed mesh rows.
  // Raw MQTT is only shown as the in-row "Raw" toggle when it matches a mesh row.
  const baseRows = useMemo(() => grouped.filter((g) => !!g.mesh), [grouped]);

  const countsByView = useMemo(() => {
    const counts = new Map<string, number>();
    counts.set("all", baseRows.length);

    for (const g of baseRows) {
      if (!g.preset) continue;
      counts.set(g.preset, (counts.get(g.preset) ?? 0) + 1);
    }
    return counts;
  }, [baseRows]);

  const filtered: GroupedRow[] = useMemo(() => {
    let items = baseRows;

    if (selectedViewKey !== defaultViewKey) {
      items = items.filter((x) => x.preset === selectedViewKey);
    }

    if (rangeThreshold) {
      items = items.filter((x) => x.ts >= rangeThreshold);
    }

    const q = urlQ.trim().toLowerCase();
    if (q) {
      items = items.filter((x) => x.searchText.includes(q));
    }

    items = items.slice().sort((a, b) => {
      return urlSort === "asc" ? a.ts - b.ts : b.ts - a.ts;
    });

    return items;
  }, [baseRows, selectedViewKey, defaultViewKey, rangeThreshold, urlQ, urlSort]);

  // Export popover
  const [exportOpen, setExportOpen] = useState(false);
  const exportMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!exportOpen) return;

    const onDown = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (exportMenuRef.current && !exportMenuRef.current.contains(t)) {
        setExportOpen(false);
      }
    };

    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [exportOpen]);

  const exportFilenameBase = useMemo(() => {
    const base = `${selectedView?.key || "logs"}`;
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    return `log_${base}_${ts}`;
  }, [selectedView]);

  const exportRow = useCallback((g: GroupedRow) => {
    return {
      ts_unix: g.ts || null,
      timestamp: g.ts ? new Date(g.ts * 1000).toISOString() : null,
      topic: g.topic || null,
      preset: g.preset || null,
      sources: {
        mesh: !!g.mesh,
        mqtt: !!g.mqtt,
      },
      mesh: g.mesh?.raw ?? null,
      mqtt: g.mqtt?.raw ?? null,
    };
  }, []);

  const doExportJson = useCallback(() => {
    const payload = {
      exportedAt: new Date().toISOString(),
      view: selectedViewKey,
      params: (() => {
        const obj: Record<string, string> = Object.fromEntries(searchParams.entries());
        delete (obj as any).src;
        delete (obj as any).wrap;
        return obj;
      })(),
      count: filtered.length,
      rows: filtered.map(exportRow),
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json;charset=utf-8",
    });

    downloadBlob(blob, `${exportFilenameBase}.json`);
    setExportOpen(false);
  }, [filtered, exportFilenameBase, searchParams, selectedViewKey, exportRow]);

  const doExportCsv = useCallback(() => {
    const cols = [
      "timestamp_unix",
      "timestamp",
      "preset",
      "topic",
      "has_mesh",
      "has_mqtt",
    ] as const;

    const lines = filtered.map((g) => {
      const iso = g.ts ? new Date(g.ts * 1000).toISOString() : "";
      const row = {
        timestamp_unix: g.ts || "",
        timestamp: iso,
        preset: g.preset || "",
        topic: g.topic || "",
        has_mesh: g.mesh ? "1" : "0",
        has_mqtt: g.mqtt ? "1" : "0",
      };
      return cols.map((c) => csvEscape((row as any)[c])).join(",");
    });

    const header = cols.join(",");
    const csv = "\ufeff" + [header, ...lines].join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });

    downloadBlob(blob, `${exportFilenameBase}.csv`);
    setExportOpen(false);
  }, [filtered, exportFilenameBase]);

  // Per-row view toggle state
  const [rowView, setRowView] = useState<Record<string, RowViewKey>>({});

  const getRowView = useCallback(
    (g: GroupedRow): RowViewKey => {
      const v = rowView[g.key];
      if (v) return v;
      // default mesh if present, else raw
      return g.mesh ? "mesh" : "raw";
    },
    [rowView],
  );

  const setRowViewKey = useCallback((groupKey: string, next: RowViewKey) => {
    setRowView((cur) => ({ ...cur, [groupKey]: next }));
  }, []);

  const buildCombinedForDisplay = useCallback((g: GroupedRow, v: RowViewKey) => {
    const message = v === "mesh" ? g.mesh?.raw ?? null : g.mqtt?.raw ?? null;

    // stable combined JSON
    return {
      ts_unix: g.ts || null,
      timestamp: g.ts ? new Date(g.ts * 1000).toISOString() : null,
      topic: g.topic || null,
      preset: g.preset || null,
      sources: {
        mesh: !!g.mesh,
        mqtt: !!g.mqtt,
      },
      view: v === "mesh" ? "mesh" : "raw",
      message,
    };
  }, []);

  const [copiedRowKey, setCopiedRowKey] = useState<string | null>(null);

  const copyRowJson = useCallback(async (groupKey: string, pretty: string) => {
    const ok = await copyTextToClipboard(pretty);
    if (ok) {
      setCopiedRowKey(groupKey);
      window.setTimeout(() => {
        setCopiedRowKey((cur) => (cur === groupKey ? null : cur));
      }, 1100);
      return;
    }
    window.prompt("Copy JSON:", pretty);
  }, []);

  // Keyboard shortcuts
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const [controlsOpen, setControlsOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      const isTypingContext =
        tag === "input" ||
        tag === "textarea" ||
        (e.target as any)?.isContentEditable;

      if (!isTypingContext && e.key === "/") {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (e.key === "Escape") {
        if (controlsOpen) {
          setControlsOpen(false);
          return;
        }
        if (exportOpen) setExportOpen(false);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [controlsOpen, exportOpen]);

  const virtuosoRef = useRef<VirtuosoHandle | null>(null);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (selectedViewKey !== defaultViewKey) n += 1;
    if (urlRange !== DEFAULT_RANGE) n += 1;
    if (urlSort !== DEFAULT_SORT) n += 1;
    if (urlQ.trim()) n += 1;
    return n;
  }, [selectedViewKey, defaultViewKey, urlRange, urlSort, urlQ]);

  const hasFilters = activeFilterCount > 0;

  const refetch = useCallback(() => {
    refetchMesh();
    refetchMqtt();
  }, [refetchMesh, refetchMqtt]);

  return (
    <div className="w-full h-[100dvh] overflow-hidden flex flex-col">
      <div className="sticky top-0 z-20 shrink-0 bg-white/90 dark:bg-gray-900/85 backdrop-blur border-b border-gray-200 dark:border-gray-800">
        <div className="mx-auto max-w-[1600px] pl-3 pr-14 sm:px-5 py-2 sm:py-3">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">
                Logs
              </h1>

              <div className="mt-1 hidden sm:flex flex-wrap items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span>
                  Updated:{" "}
                  <span className="font-medium">
                    {dataUpdatedAt && dataUpdatedAt > 0
                      ? new Date(dataUpdatedAt).toLocaleString()
                      : new Date().toLocaleString()}
                  </span>
                </span>

                <span className="opacity-60">•</span>

                <span className={isFetching ? "animate-pulse" : ""}>
                  {isFetching ? "Refreshing…" : "Ready"}
                </span>

                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={refetch}
                >
                  refresh
                </button>

                <span className="opacity-60">•</span>

                <span>
                  processed + raw from the mesh as <HeardBy />
                </span>
              </div>

              <div className="mt-1 flex sm:hidden items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                <span className={isFetching ? "animate-pulse" : ""}>
                  {isFetching ? "Refreshing…" : "Ready"}
                </span>
                <button
                  type="button"
                  className="underline hover:no-underline"
                  onClick={refetch}
                >
                  refresh
                </button>
              </div>

              <div className="mt-2 text-xs text-gray-600 dark:text-gray-400">
                This list shows processed mesh messages. Use the in-row Raw toggle
                (when present) to view the MQTT counterpart.
              </div>
            </div>

            <div className="hidden lg:flex items-center gap-2">
              <div className="relative" ref={exportMenuRef}>
                <button
                  type="button"
                  className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  onClick={() => setExportOpen((v) => !v)}
                  title="Export filtered rows"
                >
                  Export
                </button>

                {exportOpen ? (
                  <div className="absolute right-0 mt-2 w-56 rounded-lg border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-lg overflow-hidden z-30">
                    <div className="px-3 py-2 text-xs text-gray-600 dark:text-gray-400 border-b border-gray-200 dark:border-gray-800">
                      Export {filtered.length} row{filtered.length === 1 ? "" : "s"}
                    </div>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                      onClick={doExportCsv}
                    >
                      Export CSV
                    </button>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                      onClick={doExportJson}
                    >
                      Export JSON
                    </button>
                  </div>
                ) : null}
              </div>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={copyLink}
                title="Copy a shareable link (includes filters)"
              >
                {copiedLink ? "Copied!" : "Copy link"}
              </button>
            </div>
          </div>

          {/* Preset pills */}
          <div className="mt-3 flex gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch]">
            {views.map((v) => {
              const active = v.key === selectedViewKey;
              const count = countsByView.get(v.key) ?? 0;

              return (
                <button
                  key={`preset-${v.key}`}
                  type="button"
                  className={[
                    "whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium border transition",
                    active
                      ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                      : "bg-transparent text-gray-700 dark:text-gray-200 border-gray-300/60 dark:border-gray-600/60 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                  ].join(" ")}
                  onClick={() =>
                    setParams(
                      [{ key: "ch", value: v.key === defaultViewKey ? undefined : v.key }],
                      "push",
                    )
                  }
                  title={v.tooltip}
                >
                  {v.label}
                  <span
                    className={[
                      "ml-2 rounded-full px-2 py-0.5 text-xs",
                      active
                        ? "bg-white/20 text-white"
                        : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200",
                    ].join(" ")}
                  >
                    {count}
                  </span>
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex flex-col lg:flex-row gap-2 lg:items-center lg:justify-between">
            <div className="flex-1 min-w-0 lg:min-w-[260px]">
              <input
                ref={searchInputRef}
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search logs… (press / to focus)"
                className="w-full rounded-md border border-gray-300/70 dark:border-gray-700 bg-white dark:bg-gray-900 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/60"
              />
            </div>

            <div className="hidden lg:flex flex-wrap gap-2 items-center">
              <div className="inline-flex rounded-md border border-gray-300/60 dark:border-gray-700 overflow-hidden">
                {(["all", "1h", "24h", "7d"] as RangeKey[]).map((rk) => (
                  <button
                    key={`range-${rk}`}
                    type="button"
                    className={[
                      "px-3 py-2 text-sm transition",
                      urlRange === rk
                        ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                        : "bg-transparent text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                    ].join(" ")}
                    onClick={() => setParam("r", rk, "push")} // rk==="all" => deletes
                  >
                    {rk}
                  </button>
                ))}
              </div>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() =>
                  setParam("s", urlSort === "desc" ? "asc" : "desc", "push") // desc => deletes
                }
                title="Toggle sort"
              >
                {urlSort === "desc" ? "Newest" : "Oldest"}
              </button>

              <div className="flex items-center gap-2">
                <span className="min-w-[88px] text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                  {hasFilters
                    ? `${activeFilterCount} filter${activeFilterCount > 1 ? "s" : ""}`
                    : "no filters"}
                </span>

                <button
                  type="button"
                  className={[
                    "text-xs underline hover:no-underline text-gray-600 dark:text-gray-300",
                    hasFilters ? "visible" : "invisible pointer-events-none",
                  ].join(" ")}
                  onClick={() => {
                    setParams(
                      [
                        { key: "ch", value: undefined },
                        { key: "r", value: undefined },
                        { key: "s", value: undefined },
                        { key: "q", value: undefined },
                      ],
                      "push",
                    );
                  }}
                  title="Clear all filters"
                  tabIndex={hasFilters ? 0 : -1}
                  aria-disabled={!hasFilters}
                >
                  clear
                </button>
              </div>
            </div>
          </div>

          <div className="mt-2 hidden lg:flex items-center gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch] min-h-[30px]">
            <StatusChip
              label={`Preset: ${selectedView?.label ?? selectedViewKey}`}
              active={selectedViewKey !== defaultViewKey}
              title="Click to reset preset"
              onClick={() => setParam("ch", undefined, "push")}
            />
            <StatusChip
              label={`Range: ${urlRange}`}
              active={urlRange !== DEFAULT_RANGE}
              title="Click to reset range to all"
              onClick={() => setParam("r", undefined, "push")}
            />
            <StatusChip
              label={`Sort: ${urlSort === "desc" ? "newest" : "oldest"}`}
              active={urlSort !== DEFAULT_SORT}
              title="Click to reset sort to newest"
              onClick={() => setParam("s", undefined, "push")}
            />
            <StatusChip
              label={urlQ.trim() ? `Search: ${urlQ.trim()}` : "Search"}
              active={urlQ.trim().length > 0}
              title="Click to clear search"
              onClick={() => setParam("q", undefined, "push")}
            />
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 pt-3 pb-20 lg:pb-0 flex-1 min-h-0 w-full flex flex-col">
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-sm flex flex-col min-h-0 flex-1">
            <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 flex items-center justify-between">
              <div className="text-sm text-gray-800 dark:text-gray-200">
                <span className="font-semibold">
                  {selectedView?.label ?? "Logs"}
                </span>{" "}
                <span className="text-gray-500 dark:text-gray-400">
                  • showing {filtered.length} / {baseRows.length}
                </span>
              </div>
            </div>

            <div className="flex-1 min-h-0">
              {filtered.length === 0 ? (
                <div className="p-6 text-sm text-gray-600 dark:text-gray-400">
                  No rows match your current filters.
                </div>
              ) : (
                <Virtuoso
                  ref={virtuosoRef}
                  data={filtered}
                  style={{ height: "100%" }}
                  computeItemKey={(_index: number, item: GroupedRow) => item.key}
                  itemContent={(_index: number, g: groupedrow) => {
                    const tsLabel = g.ts
                      ? formatTimestamp(g.ts) || "Unknown"
                      : "Unknown";
                    const topic = g.topic || "";

                    const v = getRowView(g);
                    const canMesh = !!g.mesh;
                    const canRaw = !!g.mqtt;

                    const displayObj = buildCombinedForDisplay(g, v);
                    const pretty = JSON.stringify(displayObj, null, 2);

                    const sourceBadge =
                      g.mesh && g.mqtt ? "mesh + raw" : g.mesh ? "mesh" : "raw";

                    return (
                      <div className="px-3 sm:px-4 py-3 border-b border-gray-200/70 dark:border-gray-800">
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="text-xs text-gray-500 dark:text-gray-400">
                              {tsLabel}
                              {g.preset && g.preset !== "unknown" ? (
                                <span className="ml-2 rounded-full px-2 py-0.5 border border-gray-300/60 dark:border-gray-700 text-[11px] text-gray-600 dark:text-gray-300">
                                  {g.preset}
                                </span>
                              ) : null}
                              <span className="ml-2 rounded-full px-2 py-0.5 border border-gray-300/60 dark:border-gray-700 text-[11px] text-gray-600 dark:text-gray-300">
                                {sourceBadge}
                              </span>
                            </div>

                            {topic ? (
                              <div className="mt-1 text-xs font-mono text-gray-700 dark:text-gray-200 break-all">
                                {topic}
                              </div>
                            ) : null}
                          </div>

                          <div className="shrink-0 flex items-center gap-2">
                            {/* In-row toggle: Mesh (default) <-> Raw */}
                            <div className="inline-flex rounded-md border border-gray-300/60 dark:border-gray-700 overflow-hidden">
                              <button
                                type="button"
                                disabled={!canMesh}
                                className={[
                                  "px-2.5 py-1.5 text-xs transition",
                                  v === "mesh"
                                    ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                                    : "bg-transparent text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                                  !canMesh
                                    ? "opacity-40 cursor-not-allowed hover:bg-transparent"
                                    : "",
                                ].join(" ")}
                                onClick={() => setRowViewKey(g.key, "mesh")}
                                title={
                                  canMesh
                                    ? "Show processed mesh view"
                                    : "No mesh view for this row"
                                }
                              >
                                Mesh
                              </button>
                              <button
                                type="button"
                                disabled={!canRaw}
                                className={[
                                  "px-2.5 py-1.5 text-xs transition",
                                  v === "raw"
                                    ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                                    : "bg-transparent text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                                  !canRaw
                                    ? "opacity-40 cursor-not-allowed hover:bg-transparent"
                                    : "",
                                ].join(" ")}
                                onClick={() => setRowViewKey(g.key, "raw")}
                                title={
                                  canRaw
                                    ? "Show raw MQTT view"
                                    : "No raw view for this row"
                                }
                              >
                                Raw
                              </button>
                            </div>

                            <button
                              type="button"
                              className="rounded-md px-2.5 py-1.5 text-xs border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                              onClick={() => copyRowJson(g.key, pretty)}
                              title="Copy JSON"
                            >
                              {copiedRowKey === g.key ? "Copied!" : "Copy JSON"}
                            </button>
                          </div>
                        </div>

                        <JsonBlock code={pretty} />
                      </div>
                    );
                  }}
                />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Mobile bottom nav */}
      <div className="fixed inset-x-0 bottom-0 z-30 lg:hidden">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 pb-[env(safe-area-inset-bottom)]">
          <div className="mb-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white/90 dark:bg-gray-900/85 backdrop-blur shadow-sm overflow-hidden">
            <button
              type="button"
              className="w-full py-3 text-sm font-medium text-gray-800 dark:text-gray-100 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
              onClick={() => setControlsOpen((v) => !v)}
            >
              Controls
              {hasFilters ? (
                <span className="ml-2 inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs bg-gray-200/70 dark:bg-gray-700/60 text-gray-700 dark:text-gray-200">
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
          </div>
        </div>
      </div>

      <MobileSheet
        open={controlsOpen}
        title="Controls"
        onClose={() => setControlsOpen(false)}
      >
        <div className="space-y-4">
          <div className="text-xs text-gray-600 dark:text-gray-400">
            Range, sort, export, and quick actions.
          </div>

          <div className="grid grid-cols-1 gap-3">
            <div>
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Range
              </div>
              <div className="inline-flex rounded-md border border-gray-300/60 dark:border-gray-700 overflow-hidden">
                {(["all", "1h", "24h", "7d"] as RangeKey[]).map((rk) => (
                  <button
                    key={`m-range-${rk}`}
                    type="button"
                    className={[
                      "px-3 py-2 text-sm transition",
                      urlRange === rk
                        ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                        : "bg-transparent text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40",
                    ].join(" ")}
                    onClick={() => setParam("r", rk, "push")}
                  >
                    {rk}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 mb-2">
                Sort
              </div>
              <button
                type="button"
                className="w-full rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() =>
                  setParam("s", urlSort === "desc" ? "asc" : "desc", "push")
                }
              >
                {urlSort === "desc" ? "Newest → Oldest" : "Oldest → Newest"}
              </button>
            </div>
          </div>

          <div className="pt-4 border-t border-gray-200 dark:border-gray-800">
            <div className="text-xs text-gray-600 dark:text-gray-400">
              Updated:{" "}
              <span className="font-medium">
                {dataUpdatedAt && dataUpdatedAt > 0
                  ? new Date(dataUpdatedAt).toLocaleString()
                  : new Date().toLocaleString()}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-1 gap-2">
              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={refetch}
              >
                Refresh now
              </button>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={copyLink}
              >
                {copiedLink ? "Copied!" : "Copy link"}
              </button>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() => {
                  doExportCsv();
                  setControlsOpen(false);
                }}
              >
                Export CSV ({filtered.length})
              </button>

              <button
                type="button"
                className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                onClick={() => {
                  doExportJson();
                  setControlsOpen(false);
                }}
              >
                Export JSON ({filtered.length})
              </button>

              {hasFilters ? (
                <button
                  type="button"
                  className="rounded-md px-3 py-2 text-sm border border-red-300/70 dark:border-red-800/70 text-red-700 dark:text-red-200 hover:bg-red-50/60 dark:hover:bg-red-900/20 transition"
                  onClick={() => {
                    setParams(
                      [
                        { key: "ch", value: undefined },
                        { key: "r", value: undefined },
                        { key: "s", value: undefined },
                        { key: "q", value: undefined },
                      ],
                      "push",
                    );
                    setControlsOpen(false);
                  }}
                >
                  Clear all filters
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </MobileSheet>
    </div>
  );
};
