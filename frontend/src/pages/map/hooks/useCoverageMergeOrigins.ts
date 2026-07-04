import { useCallback, useMemo, useState } from "react";

import { toast } from "../../../components/toastStore";
import type { IMapNode } from "../lib/types";
import { effectiveAltitudeMslM } from "../rf/altitudeAssessment";
import type { MergeOrigin } from "../rf/coverageAnalysis";

/** Each merge origin multiplies per-pixel ITM cost; 8 keeps Survey tractable. */
export const MAX_MERGE_ORIGINS = 8;

/** Coverage-merge origins are session-only by design — contextual to one analysis. */
export function useCoverageMergeOrigins(nodes: Record<string, IMapNode>, toolFromId: string | null) {
  const [coverageMergeOrigins, setCoverageMergeOrigins] = useState<MergeOrigin[]>([]);
  // True while the panel's "Pick on map" button is armed; the next map click
  // adds a virtual merge origin.
  const [pickingMergeOrigin, setPickingMergeOrigin] = useState(false);

  const removeCoverageMergeOrigin = useCallback((id: string) => {
    setCoverageMergeOrigins((prev) => prev.filter((o) => o.id !== id));
  }, []);

  const clearCoverageMergeOrigins = useCallback(() => {
    setCoverageMergeOrigins([]);
    setPickingMergeOrigin(false);
  }, []);

  const moveCoverageMergeOrigin = useCallback((id: string, position: [number, number]) => {
    setCoverageMergeOrigins((prev) =>
      prev.map((o) => (o.id === id ? { ...o, position } : o)),
    );
  }, []);

  // Defined here (rather than next to the other coverage-merge state) so the
  // closure can read the live `nodes` map.
  const addCoverageMergeOriginById = useCallback((nodeId: string) => {
    const n = nodes[nodeId] ?? nodes[`!${nodeId}`];
    const pos = n?.map_position;
    if (!pos) return;
    const cleanId = nodeId.startsWith("!") ? nodeId.slice(1) : nodeId;
    setCoverageMergeOrigins((prev) => {
      if (prev.some((o) => o.id === cleanId)) return prev;
      if (prev.length >= MAX_MERGE_ORIGINS) {
        toast(`Merge-origin limit reached (${MAX_MERGE_ORIGINS}) — remove one first.`);
        return prev;
      }
      return [...prev, {
        id: cleanId,
        label: n?.shortname || n?.longname || cleanId,
        position: [pos[0], pos[1]],
        altitudeM: effectiveAltitudeMslM(n?.position),
      }];
    });
  }, [nodes]);

  const mergeNodeOptions = useMemo(() => {
    const out: Array<{ id: string; shortname?: string; longname?: string }> = [];
    const primaryId = toolFromId ? (toolFromId.startsWith("!") ? toolFromId.slice(1) : toolFromId) : null;
    for (const [rawId, n] of Object.entries(nodes)) {
      if (!n?.map_position) continue;
      const cleanId = rawId.startsWith("!") ? rawId.slice(1) : rawId;
      if (primaryId && cleanId === primaryId) continue;
      out.push({ id: cleanId, shortname: n.shortname, longname: n.longname });
    }
    return out;
  }, [nodes, toolFromId]);

  return {
    coverageMergeOrigins, setCoverageMergeOrigins,
    pickingMergeOrigin, setPickingMergeOrigin,
    addCoverageMergeOriginById,
    removeCoverageMergeOrigin,
    clearCoverageMergeOrigins,
    moveCoverageMergeOrigin,
    mergeNodeOptions,
  };
}
