export type RangeKey = "all" | "1h" | "24h" | "7d";

export type TraceroutePairSummary = {
  /** Canonical undirected pair key: sorted `${min}|${max}`. */
  pairKey: string;
  /** Newest run's initiator (travel orientation). */
  from: string;
  /** Newest run's target. */
  to: string;
  /** Both endpoints have initiated traceroutes in this scope. */
  bidirectional: boolean;
  /** Exchanges (request+reply packets of one traceroute collapsed). */
  count: number;
  /** Raw packets observed (requests + replies, before collapsing). */
  packetCount: number;
  firstTsMs: number;
  lastTsMs: number;
  uniqueRoutes: number;

  // preview for list row; topRouteFrom/topRouteTo carry the top route's OWN
  // direction — on a bidirectional (⇄) pair it can oppose the summary's
  // newest-run from/to, and unlabeled chips would read backwards.
  topRouteIds: string[];
  topRouteCount: number;
  topRouteFrom: string;
  topRouteTo: string;
};

export type TraceroutesListItem =
  | {
      kind: "all";
      key: "all";
      totalPairs: number;
      /** Exchanges in scope (see TraceroutePairSummary.count). */
      totalEvents: number;
      /** Raw packets in scope. */
      totalPackets: number;
      lastTsMs: number;
      uniqueRoutes: number; // unique hop-sequences across all pairs
    }
  | {
      kind: "pair";
      key: `pair:${string}`;
      pairKey: string; // canonical undirected sorted key
      from: string;
      to: string;
      summary: TraceroutePairSummary;
    };
