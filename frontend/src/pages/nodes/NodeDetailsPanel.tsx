import { useState } from "react";
import { Link } from "react-router";

import { Avatar } from "../../components/Avatar";
import { HardwareImg } from "../../components/HardwareImg";
import { Role } from "../../components/Role";
import { useGetConfigQuery } from "../../slices/apiSlice";
import { INode } from "../../types";
import {
  convertNodeIdFromHexToInt,
} from "../../utils/convertNodeId";
import { getElsewhereLinks, resolveElsewhereUrl } from "../../utils/elsewhereLinks";
import { calculateDistanceBetweenNodes } from "../../utils/getDistanceBetweenTwoNodes";
import { NodeMap } from "../NodeMap";
import {
  cleanNodeId,
  getLatLon,
  getTelemetrySnapshot,
  isNodeOnline,
  roleLabel,
} from "./nodesUtils";

function KV({
  k,
  v,
  mono,
}: {
  k: string;
  v: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <div className="text-xs text-gray-600 dark:text-gray-400">{k}</div>
      <div
        className={[
          "text-xs text-gray-900 dark:text-gray-100 text-right",
          mono ? "font-mono" : "",
        ].join(" ")}
      >
        {v}
      </div>
    </div>
  );
}

function GaugeRow({
  label,
  valueText,
  pct,
}: {
  label: string;
  valueText: string;
  pct: number | null;
}) {
  const safePct = pct == null ? 0 : Math.max(0, Math.min(100, pct));

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400">
        <span>{label}</span>
        <span className="tabular-nums">{valueText}</span>
      </div>
      <div className="h-2 rounded-full bg-gray-200/70 dark:bg-gray-800 overflow-hidden">
        <div className="h-full bg-indigo-600/80" style={{ width: `${safePct}%` }} />
      </div>
    </div>
  );
}

function CopyLinkButton({ nodeId }: { nodeId: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      const u = new URL(window.location.href);
      u.searchParams.set("node", nodeId);
      await navigator.clipboard.writeText(u.toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // fallback
      const u = new URL(window.location.href);
      u.searchParams.set("node", nodeId);
      window.prompt("Copy link:", u.toString());
    }
  };

  return (
    <button
      type="button"
      className="rounded-md px-2 py-1 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
      onClick={handleCopy}
      title="Copy a direct link to this node"
    >
      {copied ? "Copied!" : "Copy link"}
    </button>
  );
}

export function NodeDetailsPanel({
  node,
  nodes,
  serverNode,
  onClearSelection,
  onSelectNode,
}: {
  node: INode;
  nodes: Record<string, INode>;
  serverNode: INode | null;
  onClearSelection: () => void;
  onSelectNode?: (id: string) => void;
}) {
  const { data: config } = useGetConfigQuery();
  const n: any = node as any;
  const id = cleanNodeId(n?.id ?? "");
  const short = String(n?.shortname ?? "UNK");
  const long = String(n?.longname ?? "");
  const online = isNodeOnline(node);

  const ll = getLatLon(node);
  const telem = getTelemetrySnapshot(node);

  const distanceFromServer =
    serverNode && calculateDistanceBetweenNodes(serverNode as any, node as any) != null
      ? calculateDistanceBetweenNodes(serverNode as any, node as any)
      : null;

  const openStreetMapUrl =
    ll ? `https://www.openstreetmap.org/?mlat=${ll[1]}&mlon=${ll[0]}#map=14/${ll[1]}/${ll[0]}` : null;

  return (
    <div className="flex flex-col gap-4 min-h-0">
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 overflow-hidden shadow-xs flex flex-col">
        <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-3">
                <Avatar id={id} size={12} />
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                    {short} <span className="text-gray-500 dark:text-gray-400">—</span>{" "}
                    <span className="font-normal">{long}</span>
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                    <span
                      className={[
                        "rounded-full px-2 py-0.5 border text-[11px] font-medium",
                        online
                          ? "bg-emerald-600 text-white border-emerald-600"
                          : "bg-gray-200/70 dark:bg-gray-700/60 text-gray-800 dark:text-gray-200 border-gray-300/50 dark:border-gray-600/50",
                      ].join(" ")}
                    >
                      {online ? "Online" : "Offline"}
                    </span>

                    {typeof n?.role === "number" ? (
                      <span className="rounded-full px-2 py-0.5 border border-gray-300/60 dark:border-gray-700 text-[11px]">
                        {roleLabel(n?.role)}
                      </span>
                    ) : null}

                    <span className="font-mono opacity-80">{id}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <CopyLinkButton nodeId={id} />
              <button
                type="button"
                className="rounded-md px-2 py-1 text-sm border border-indigo-300/70 dark:border-indigo-800/70 text-indigo-700 dark:text-indigo-200 hover:bg-indigo-50/60 dark:hover:bg-indigo-900/20 transition"
                onClick={onClearSelection}
              >
                Clear
              </button>
            </div>
          </div>

          {/* Quick telemetry strip */}
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/30 p-3">
              <div className="text-xs text-gray-600 dark:text-gray-400">Battery</div>
              <div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                {telem.batteryPct != null ? `${Math.round(telem.batteryPct)}%` : "—"}
              </div>
            </div>
            <div className="rounded-lg border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/30 p-3">
              <div className="text-xs text-gray-600 dark:text-gray-400">Voltage</div>
              <div className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100 tabular-nums">
                {telem.voltage != null ? `${telem.voltage.toFixed(2)}V` : "—"}
              </div>
            </div>
          </div>
        </div>

        <div className="p-4 space-y-4">
          {/* Gauges */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/30 p-3 shadow-xs">
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Utilization
            </div>
            <div className="mt-3 space-y-3">
              <GaugeRow
                label="Air Util TX"
                valueText={telem.airTx != null ? `${telem.airTx.toFixed(1)}%` : "—"}
                pct={telem.airTx}
              />
              <GaugeRow
                label="Channel Util"
                valueText={telem.chanUtil != null ? `${telem.chanUtil.toFixed(1)}%` : "—"}
                pct={telem.chanUtil}
              />
            </div>
          </div>

          {/* Details */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/30 p-3 shadow-xs">
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Details
            </div>

            <div className="mt-3 divide-y divide-dashed divide-gray-200 dark:divide-gray-800">
              <KV k="ID (hex)" v={id} mono />
              <KV
                k="ID (int)"
                v={id ? String(convertNodeIdFromHexToInt(id)) : "—"}
                mono
              />
              <KV
                k="Hardware"
                v={n?.hardware != null ? <HardwareImg model={n.hardware} showLabel /> : "Unknown"}
              />
              <KV k="Role" v={n?.role != null ? <Role role={n.role} /> : "Unknown"} />
              <KV
                k="Last seen"
                v={
                  n?.last_seen
                    ? new Date(n.last_seen).toLocaleString(undefined, {
                        year: "numeric",
                        month: "2-digit",
                        day: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                        hour12: false,
                      })
                    : "Unknown"
                }
              />
              <KV
                k="Altitude"
                v={
                  n?.position?.altitude != null
                    ? `${n.position.altitude} m`
                    : "Unknown"
                }
              />
              <KV
                k="Coordinates"
                v={
                  ll ? (
                    <span className="tabular-nums">
                      {ll[1].toFixed(6)}, {ll[0].toFixed(6)}
                    </span>
                  ) : (
                    "Unknown"
                  )
                }
                mono
              />
              <KV
                k="Map"
                v={
                  openStreetMapUrl ? (
                    <a
                      href={openStreetMapUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline hover:no-underline text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                    >
                      OpenStreetMap
                    </a>
                  ) : (
                    "—"
                  )
                }
              />
              <KV
                k="Distance from server"
                v={distanceFromServer != null ? `${distanceFromServer} km` : "Unknown"}
              />
              <KV
                k="Neighbors (count)"
                v={n?.neighborinfo?.neighbors_count != null ? String(n.neighborinfo.neighbors_count) : "—"}
              />
              <KV
                k="Gateway"
                v={(() => {
                  const gw = n?.gateway;
                  if (!gw) return "—";
                  const gwNode = nodes[gw];
                  const label = gwNode?.shortname || gwNode?.longname || gw;
                  if (onSelectNode) {
                    return (
                      <button
                        type="button"
                        className="underline hover:no-underline text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                        onClick={() => onSelectNode(gw)}
                      >
                        {label}
                      </button>
                    );
                  }
                  return label;
                })()}
              />
            </div>
          </div>

          {/* Map */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/30 p-3 shadow-xs">
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Location
              </div>
              {ll && (
                <Link
                  to={`/map?node=${id}`}
                  className="text-xs underline hover:no-underline text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300"
                >
                  View on map
                </Link>
              )}
            </div>
            <div className="mt-3">
              {ll ? (
                <NodeMap node={node} />
              ) : (
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  No coordinates available for this node.
                </div>
              )}
            </div>
          </div>

          {/* Elsewhere */}
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white/60 dark:bg-gray-900/30 p-3 shadow-xs">
            <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              Elsewhere
            </div>

            <div className="mt-2 text-sm text-gray-700 dark:text-gray-200 space-y-1">
              {getElsewhereLinks(config?.mesh?.elsewhere_links).map((link, i) => (
                <a
                  key={i}
                  className="underline hover:no-underline text-indigo-600 hover:text-indigo-700 dark:text-indigo-400 dark:hover:text-indigo-300 block"
                  href={resolveElsewhereUrl(link.url ?? "", id, convertNodeIdFromHexToInt(id))}
                  target="_blank"
                  rel="noreferrer"
                >
                  {link.name}
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
