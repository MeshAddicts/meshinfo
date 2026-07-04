/** Ambient live packet arcs: coalesce SSE packets, resolve from→sender
 *  positions (snapped to covering cluster donuts), and spawn into the
 *  activity layer one rAF batch at a time. */
import type { Map as MlMap } from "maplibre-gl";
import { useCallback, useEffect, useRef } from "react";

import { useLiveEvent } from "../../../hooks/useLiveEvent";
import { prefersReducedMotion } from "../../../utils/reducedMotion";
import type { ActivityLayer } from "../layers/activityLayer";
import type { ClusterDonutLayer } from "../layers/clusterDonutLayer";
import { samePoint } from "../lib/geo";
import { type PacketArc, PacketCoalescer, type RawPacket } from "../lib/packetCoalescer";
import { packetColor } from "../lib/packetColors";
import type { IMapNode } from "../lib/types";

// Cap arcs spawned per flush so a burst can't stall a frame (drop oldest excess).
const MAX_ARCS_PER_FLUSH = 40;

/** Map a reported signal to a 0..1 arc intensity — prefer SNR, fall back to RSSI. */
function packetWeight(rssi?: number, snr?: number): number {
  const clamp = (v: number) => Math.max(0.15, Math.min(1, v));
  if (typeof snr === "number") return clamp((snr + 20) / 30);
  if (typeof rssi === "number") return clamp((rssi + 120) / 90);
  return 0.5;
}

export type LivePacketArcsParams = {
  activityLayerRef: { current: ActivityLayer | null };
  clusterDonutLayerRef: { current: ClusterDonutLayer | null };
  mbMapRef: { current: MlMap | null };
  nodesRef: { current: Record<string, IMapNode> };
  clusterEnabledRef: { current: boolean };
  livePacketsRef: { current: boolean };
  flyoverFlyingRef: { current: boolean };
};

export function useLivePacketArcs({
  activityLayerRef, clusterDonutLayerRef, mbMapRef, nodesRef,
  clusterEnabledRef, livePacketsRef, flyoverFlyingRef,
}: LivePacketArcsParams): void {
  const coalescerRef = useRef<PacketCoalescer | null>(null);
  const pendingArcsRef = useRef<PacketArc[]>([]);
  const flushRafRef = useRef<number | null>(null);

  const flushPacketArcs = useCallback(() => {
    flushRafRef.current = null;
    const layer = activityLayerRef.current;
    const all = pendingArcsRef.current;
    pendingArcsRef.current = [];
    if (!layer || all.length === 0) return;
    // Drop oldest excess on a burst; keep the most recent so the feed stays live.
    const arcs = all.length > MAX_ARCS_PER_FLUSH ? all.slice(-MAX_ARCS_PER_FLUSH) : all;
    const liveNodes = nodesRef.current;
    const now = performance.now();

    // With clustering on, snap endpoints to the donut that visually covers them so
    // arcs line up with the clusters on screen. Project cluster centroids once.
    const map = mbMapRef.current;
    const projected =
      clusterEnabledRef.current && map && clusterDonutLayerRef.current
        ? clusterDonutLayerRef.current.visibleClusters().map((c) => {
            const p = map.project([c.lng, c.lat]);
            return { x: p.x, y: p.y, r: c.r, lngLat: [c.lng, c.lat] as [number, number] };
          })
        : null;
    const anchor = (pos: [number, number]): [number, number] => {
      if (!projected || !map) return pos;
      const p = map.project(pos);
      let best: [number, number] | null = null;
      let bestD = Infinity;
      for (const c of projected) {
        const d = Math.hypot(c.x - p.x, c.y - p.y);
        if (d <= c.r && d < bestD) {
          bestD = d;
          best = c.lngLat;
        }
      }
      return best ?? pos;
    };

    layer.beginBatch(); // coalesce this flush into one GPU upload
    for (const a of arcs) {
      const fromRaw = liveNodes[a.fromId]?.map_position;
      const senderRaw = liveNodes[a.senderId]?.map_position;
      const fromPos = fromRaw ? anchor(fromRaw) : undefined;
      const senderPos = senderRaw ? anchor(senderRaw) : undefined;
      const color = packetColor(a.type);
      if (a.isNewTransmission && fromPos) layer.spawnPulse(fromPos, color, now);
      if (fromPos && senderPos && !samePoint(fromPos, senderPos)) {
        layer.spawnArc(fromPos, senderPos, color, packetWeight(a.rssi, a.snr), now);
      } else if (!fromPos && senderPos) {
        layer.spawnRipple(senderPos, color, now); // heard, origin position unknown
      }
    }
    layer.endBatch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLiveEvent<RawPacket>("packet", (p) => {
    if (!livePacketsRef.current || prefersReducedMotion()) return;
    if (flyoverFlyingRef.current) return; // spotlight: the tour owns the stage
    if (p.type === "traceroute") return; // handled by the dedicated multi-hop tracer
    const coalescer = (coalescerRef.current ??= new PacketCoalescer());
    const arc = coalescer.ingest(p, Date.now());
    if (!arc) return;
    pendingArcsRef.current.push(arc);
    if (flushRafRef.current == null) flushRafRef.current = requestAnimationFrame(flushPacketArcs);
  });

  useEffect(
    () => () => {
      if (flushRafRef.current != null) cancelAnimationFrame(flushRafRef.current);
    },
    [],
  );
}
