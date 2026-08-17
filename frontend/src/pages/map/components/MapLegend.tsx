import type { ReactNode } from "react";

import { type LegendContext, legendContextIsEmpty } from "../hooks/useLegendContext";
import { PACKET_TYPE_LABELS, packetColorCss } from "../lib/packetColors";
import type { LinkMode } from "../lib/types";

function Row({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {swatch}
      <span>{children}</span>
    </div>
  );
}

function Dot({ color }: { color: string }) {
  return <div className="w-2.5 h-2.5 rounded-full shadow-sm shrink-0" style={{ backgroundColor: color }} />;
}

function Line({ dash, color = "#cbd5e1" }: { dash?: string; color?: string }) {
  return (
    <svg viewBox="0 0 24 4" preserveAspectRatio="none" className="w-4 h-0.5 shrink-0" aria-hidden="true">
      <line x1="0" y1="2" x2="24" y2="2" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray={dash} />
    </svg>
  );
}

/**
 * Contextual map legend: with a `context` (what the viewport is rendering) only
 * the rows that apply are shown; without one (first paint) every row is shown.
 */
export function MapLegend({
  linkMode = "selected",
  myNodeLabel,
  livePackets = true,
  context = null,
  nodesHidden = false,
  filtersActive = false,
}: {
  linkMode?: LinkMode;
  myNodeLabel?: string;
  /** Live packet-arc animation enabled (Settings → Live packets). */
  livePackets?: boolean;
  /** Viewport contents; `null` → show everything. */
  context?: LegendContext | null;
  /** Node markers hidden (Live coverage → Hide nodes). */
  nodesHidden?: boolean;
  /** A node filter (days / role / channel) is narrowing the map. */
  filtersActive?: boolean;
}) {
  const linkHint =
    linkMode === "all"
      ? "Showing links for all nodes."
      : linkMode === "mynode"
        ? `Showing links for ${myNodeLabel || "My Node"}.`
        : "Links shown when a node is selected.";
  // Link-direction wording depends on who the focal node is: the selected
  // node, My Node, or nobody (all-nodes mode draws one-way links without a
  // focal node, and never dashed heard_by links).
  const focal = linkMode === "mynode" ? myNodeLabel || "My Node" : "This node";
  const heardLabel = linkMode === "all" ? "One-way link" : `${focal} heard neighbor`;
  const heardByLabel = `Neighbor heard ${linkMode === "mynode" ? focal : "this node"}`;
  const traceLabel = linkMode === "selected" ? "Traceroute path (on select)" : "Traceroute path";
  const emptyCopy = nodesHidden
    ? "Nodes are hidden (Live coverage → Hide nodes)."
    : filtersActive
      ? "Nothing in view — pan or zoom out, or widen the filters."
      : "Nothing in view — pan or zoom out to see nodes.";

  const show = (flag: boolean) => context == null || flag;
  const c = context;
  const empty = c != null && legendContextIsEmpty(c);

  const anyNode = show(c?.onlineNode || c?.onlineRouter || c?.offlineNode || false);
  const anyLink = show(c?.linkSnr || c?.linkSnrUnknown || c?.linkHeard || c?.linkHeardBy || c?.linkMutual || c?.linkTrace || false);
  const showNodes = anyNode || show(c?.cluster ?? false);

  const sections: ReactNode[] = [];

  // Applies to nodes and links alike, so it must survive a links-only view.
  const recencyRow = (
    <Row
      swatch={
        <svg viewBox="0 0 24 4" preserveAspectRatio="none" className="w-4 h-0.5 shrink-0" aria-hidden="true">
          <defs>
            <linearGradient id="legend-recency-fade" x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="#FFFFFF" stopOpacity="1.0" />
              <stop offset="100%" stopColor="#FFFFFF" stopOpacity="0.2" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="24" height="4" fill="url(#legend-recency-fade)" />
        </svg>
      }
    >
      Brightness = recency (nodes &amp; links)
    </Row>
  );

  if (empty) {
    sections.push(
      <div key="empty" className="text-gray-500 leading-tight">
        {emptyCopy}
      </div>,
    );
  }

  if (showNodes) {
    sections.push(
      <div key="nodes" className="space-y-1.5">
        {show(c?.onlineNode ?? false) && <Row swatch={<Dot color="#32f032" />}>Online node</Row>}
        {show(c?.onlineRouter ?? false) && <Row swatch={<Dot color="#3b82f6" />}>Online router</Row>}
        {show(c?.offlineNode ?? false) && <Row swatch={<Dot color="#72798a" />}>Offline node (any role)</Row>}
        {(anyNode || anyLink) && recencyRow}
        {show(c?.cluster ?? false) && (
          <Row
            swatch={
              <svg viewBox="0 0 20 20" className="w-4 h-4 shrink-0" aria-hidden="true">
                <circle cx="10" cy="10" r="7" fill="none" stroke="#72798a" strokeWidth="3" />
                <circle
                  cx="10" cy="10" r="7"
                  fill="none" stroke="#32f032" strokeWidth="3"
                  strokeDasharray="30 100"
                  transform="rotate(-90 10 10)"
                />
                <circle cx="10" cy="10" r="4" fill="#0f172a" />
              </svg>
            }
          >
            Cluster (ring = online ratio)
          </Row>
        )}
      </div>,
    );
  }

  if (anyLink) {
    // Links — colour = SNR (quality); kind = line style
    sections.push(
      <div key="links" className="space-y-1.5">
        {!showNodes && recencyRow}
        {show(c?.linkSnr ?? false) && (
          <Row
            swatch={
              <svg viewBox="0 0 24 4" preserveAspectRatio="none" className="w-4 h-0.5 shrink-0" aria-hidden="true">
                <defs>
                  <linearGradient id="legend-snr-gradient" x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0%" stopColor="#FF4444" />
                    <stop offset="50%" stopColor="#FFDD00" />
                    <stop offset="100%" stopColor="#44CC44" />
                  </linearGradient>
                </defs>
                <rect x="0" y="0" width="24" height="4" fill="url(#legend-snr-gradient)" />
              </svg>
            }
          >
            Link quality (low → high SNR)
          </Row>
        )}
        {show(c?.linkSnrUnknown ?? false) && (
          <Row swatch={<div className="w-4 h-0.5 bg-gray-400 rounded-full shrink-0" />}>SNR unknown</Row>
        )}
        {show(c?.linkHeard ?? false) && <Row swatch={<Line />}>{heardLabel}</Row>}
        {show(c?.linkHeardBy ?? false) && <Row swatch={<Line dash="4 3" />}>{heardByLabel}</Row>}
        {show(c?.linkMutual ?? false) && (
          <Row
            swatch={
              <svg viewBox="0 0 24 8" preserveAspectRatio="none" className="w-4 h-2 shrink-0" aria-hidden="true">
                <path d="M 1 6 Q 12 -2 23 6" stroke="#cbd5e1" strokeWidth="2.5" fill="none" strokeLinecap="round" />
              </svg>
            }
          >
            Mutual link
          </Row>
        )}
        {show(c?.linkTrace ?? false) && (
          <Row swatch={<Line dash="1 3" color="#F59E0B" />}>{traceLabel}</Row>
        )}
      </div>,
    );
  }

  if (livePackets) {
    sections.push(
      <div key="live" className="space-y-1.5">
        <div className="text-[10px] uppercase tracking-wider text-gray-500">Live packets</div>
        <Row
          swatch={
            <svg viewBox="0 0 24 10" preserveAspectRatio="none" className="w-4 h-2.5 shrink-0" aria-hidden="true">
              <path d="M 2 8 Q 12 -1 21 4" stroke="#94a3b8" strokeWidth="1.5" fill="none" strokeLinecap="round" />
              <circle cx="21" cy="4" r="2.6" fill="#e2e8f0" />
            </svg>
          }
        >
          Packet → gateway that heard it
        </Row>
        <div className="grid grid-cols-2 gap-x-2 gap-y-1">
          {PACKET_TYPE_LABELS.map(({ type, label }) => (
            <div key={type} className="flex items-center gap-1.5 min-w-0">
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: packetColorCss(type) }}
              />
              <span className="truncate">{label}</span>
            </div>
          ))}
        </div>
        <div className="text-[10px] text-gray-500 leading-tight">
          Traceroutes animate the full multi-hop path.
        </div>
      </div>,
    );
  }

  sections.push(
    <div key="footer" className="text-[10px] text-gray-500 leading-tight">
      Online = seen in last 6 hours.
      <br />
      {linkHint}
    </div>,
  );

  return (
    <div
      id="legend"
      role="group"
      aria-labelledby="legend-heading"
      tabIndex={0}
      className="bg-gray-900/80 backdrop-blur-xl rounded-xl shadow-2xl border border-white/10 p-3
                 max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-7rem)] overflow-y-auto overscroll-contain"
    >
      <div id="legend-heading" className="text-xs font-semibold text-gray-300 mb-2">
        Legend
      </div>
      <div className="text-[11px] text-gray-400">
        {sections.map((s, i) => (
          <div key={i}>
            {i > 0 && <div className="border-t border-white/10 my-1.5" />}
            {s}
          </div>
        ))}
      </div>
    </div>
  );
}
