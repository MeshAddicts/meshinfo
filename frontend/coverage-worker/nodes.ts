/** Fetch the node set from meshinfo and reduce to coverage origins. */
import { canonicalPresetName } from "../src/meshtasticPresets";
import { txDbmForRole } from "../src/pages/map/live/liveCoverageParams";
import { isKnownPreset } from "../src/pages/map/live/liveCoveragePresets";
import { fetchWithTimeout } from "../src/pages/map/terrain/fetchWithTimeout";
import type { NodeRole } from "../src/types";
import { BBOX, DEFAULT_PRESET, MESHINFO_URL, reachKmForRole, RECENCY_HOURS } from "./config";

export interface CoverageOrigin {
  id: string;
  lng: number;
  lat: number;
  /** GPS MSL altitude (m) if reported + sane, else null. */
  altitudeM: number | null;
  txDbm: number;
  reachKm: number;
  /** Modem preset id (e.g. "LongFast") — the node's mesh, via channel-hash meta. */
  preset: string;
}

interface RawNode {
  role?: number;
  last_seen?: string | null;
  last_channel?: string | null;
  position?: { latitude_i?: number; longitude_i?: number; altitude?: number } | null;
}

function validLngLat(lng: number, lat: number): boolean {
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;
  if (lng === 0 && lat === 0) return false;
  return lng >= -180 && lng <= 180 && lat >= -85 && lat <= 85;
}

/**
 * Channel-hash → modem-preset map from meshinfo's `[broker.channels.meta.*]`
 * config (the operator's authoritative channel registry — a channel is NOT a
 * preset, so a future regional channel maps by adding one meta entry there).
 * Cached; failures throw so a transient config outage can't silently flip
 * every node to the default preset (which would mass-invalidate the cache).
 */
interface ChannelMetaConfig {
  broker?: { channels?: { meta?: Record<string, { preset?: unknown }> } };
}

let presetMap: { at: number; map: Map<string, string> } | null = null;
const PRESET_MAP_TTL_MS = 10 * 60_000;
const warnedPresets = new Set<string>();

async function channelPresetMap(): Promise<Map<string, string>> {
  if (presetMap && Date.now() - presetMap.at < PRESET_MAP_TTL_MS) return presetMap.map;
  try {
    const res = await fetchWithTimeout(`${MESHINFO_URL}/v1/server/config`, { timeoutMs: 15_000 });
    if (!res.ok) throw new Error(`/v1/server/config failed: HTTP ${res.status}`);
    const body = (await res.json()) as { config?: ChannelMetaConfig };
    const meta = body.config?.broker?.channels?.meta ?? {};
    const map = new Map<string, string>();
    for (const [hash, entry] of Object.entries(meta)) {
      const preset = typeof entry?.preset === "string" ? entry.preset : null;
      if (!preset) continue;
      if (!isKnownPreset(preset)) {
        if (!warnedPresets.has(preset)) {
          warnedPresets.add(preset);
          console.warn(`[coverage-worker] channel meta ${hash} has unknown preset "${preset}" — using ${DEFAULT_PRESET}`);
        }
        continue;
      }
      // Canonicalize so pyramid groups don't fork on historical spellings.
      map.set(String(hash), canonicalPresetName(preset));
    }
    presetMap = { at: Date.now(), map };
    return map;
  } catch (err) {
    // A refresh failure must not stall bakes (including erases) when we still
    // hold a last-good map — the mapping changes ~never between config edits.
    if (presetMap) {
      console.warn("[coverage-worker] channel-preset map refresh failed; keeping cached map:", err);
      presetMap.at = Date.now(); // pace retries
      return presetMap.map;
    }
    throw err; // first fetch: no safe fallback (defaulting would mass-invalidate the cache)
  }
}

/** GET /v1/nodes → positioned nodes heard within the recency window. All roles.
 *  Sorted by id: origins[0] anchors the bake's longitude frame (and the sticky
 *  bbox), so the order must not depend on API response ordering. */
export async function fetchCoverageOrigins(nowMs: number): Promise<CoverageOrigin[]> {
  // The API pre-filters by whole days; round up so RECENCY_HOURS > 24 works.
  const days = Math.max(1, Math.ceil(RECENCY_HOURS / 24));
  const [res, presets] = await Promise.all([
    fetchWithTimeout(`${MESHINFO_URL}/v1/nodes?days=${days}`, { timeoutMs: 30_000 }),
    channelPresetMap(),
  ]);
  if (!res.ok) throw new Error(`/v1/nodes failed: HTTP ${res.status}`);
  const body = (await res.json()) as { nodes?: Record<string, RawNode> };
  const recencyMs = RECENCY_HOURS * 60 * 60 * 1000;
  const out: CoverageOrigin[] = [];
  for (const [id, n] of Object.entries(body.nodes ?? {})) {
    const pos = n.position;
    if (!pos || pos.latitude_i == null || pos.longitude_i == null) continue;
    const lng = pos.longitude_i / 1e7;
    const lat = pos.latitude_i / 1e7;
    if (!validLngLat(lng, lat)) continue;
    if (BBOX && (lng < BBOX[0] || lng > BBOX[2] || lat < BBOX[1] || lat > BBOX[3])) continue;
    if (!n.last_seen) continue;
    const seen = new Date(n.last_seen).getTime();
    if (!Number.isFinite(seen) || nowMs - seen > recencyMs) continue;
    const role = n.role as NodeRole | undefined;
    // Quantize position (~100 m) / altitude (5 m) so GPS jitter doesn't read as movement.
    out.push({
      id,
      lng: Math.round(lng * 1000) / 1000,
      lat: Math.round(lat * 1000) / 1000,
      altitudeM:
        typeof pos.altitude === "number" && Number.isFinite(pos.altitude)
          ? Math.round(pos.altitude / 5) * 5
          : null,
      txDbm: txDbmForRole(role),
      reachKm: reachKmForRole(role),
      preset: presets.get(String(n.last_channel ?? "")) ?? DEFAULT_PRESET,
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
