/** Latch pausing the 400ms SSE node flush during camera tours (each flush
 *  re-renders the Map page + re-clusters the source). Events keep coalescing
 *  while suspended and apply shortly after resume. */
export const liveNodeFlushGate = { suspended: false };
