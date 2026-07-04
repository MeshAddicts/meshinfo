export type RangeKey = "all" | "1h" | "24h" | "7d";

export type TraceroutePairSummary = {
  pairKey: string; // `${from}|${to}`
  from: string;
  to: string;
  count: number;
  firstTsMs: number;
  lastTsMs: number;
  uniqueRoutes: number;

  // preview for list row
  topRouteIds: string[];
  topRouteCount: number;
};

export type TraceroutesListItem =
  | {
      kind: "all";
      key: "all";
      totalPairs: number;
      totalEvents: number;
      lastTsMs: number;
      uniqueRoutes: number; // unique hop-sequences across all pairs
    }
  | {
      kind: "pair";
      key: `pair:${string}`;
      pairKey: string; // `${from}|${to}`
      from: string;
      to: string;
      summary: TraceroutePairSummary;
    };
