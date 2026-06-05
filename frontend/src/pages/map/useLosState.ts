import { useState } from "react";

import type { LoSResult } from "./losAnalysis";
import type { DemSource } from "./terrainRgb";

/** LoS endpoint hardware/antenna/height + result state. */
export function useLosState() {
  const [losResult, setLosResult] = useState<LoSResult | null>(null);
  /** DEM tile source used for the last LoS compute. */
  const [losDemSource, setLosDemSource] = useState<DemSource | null>(null);
  /** Last LoS compute error, or null. */
  const [losError, setLosError] = useState<string | null>(null);
  // LOS virtual pins — endpoints can be arbitrary map points, not just nodes
  const [losVirtualFrom, setLosVirtualFrom] = useState<[number, number] | null>(null);
  const [losVirtualTo, setLosVirtualTo] = useState<[number, number] | null>(null);
  // Per-endpoint hardware/antenna/height for asymmetric LOS
  const [losFromHwIdx, setLosFromHwIdx] = useState(0);
  const [losFromAntIdx, setLosFromAntIdx] = useState(3); // Rokland 5.8 dBi
  const [losFromHeightM, setLosFromHeightM] = useState(2);
  const [losToHwIdx, setLosToHwIdx] = useState(0);
  const [losToAntIdx, setLosToAntIdx] = useState(3);
  const [losToHeightM, setLosToHeightM] = useState(2);

  return {
    losResult, setLosResult,
    losDemSource, setLosDemSource,
    losError, setLosError,
    losVirtualFrom, setLosVirtualFrom,
    losVirtualTo, setLosVirtualTo,
    losFromHwIdx, setLosFromHwIdx,
    losFromAntIdx, setLosFromAntIdx,
    losFromHeightM, setLosFromHeightM,
    losToHwIdx, setLosToHwIdx,
    losToAntIdx, setLosToAntIdx,
    losToHeightM, setLosToHeightM,
  };
}

export type LosState = ReturnType<typeof useLosState>;
