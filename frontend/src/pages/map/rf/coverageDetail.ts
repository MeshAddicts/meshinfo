/** Output raster size (the DEM is always 2048²). Compute cost scales ~size². */
export type CoverageDetail = "standard" | "high" | "ultra" | "survey";

export const COVERAGE_DETAIL_SIZE: Record<CoverageDetail, number> = {
  standard: 512,
  high: 768,
  ultra: 1024,
  survey: 2048,
};

/** Per-Detail DEM tile cap. Higher = finer native zoom at smaller radii. Standard
 *  matches the Tilezen LRU size so default-tier repeats hit cache 100%. */
export const COVERAGE_DETAIL_MAX_TILES: Record<CoverageDetail, number> = {
  standard: 256,
  high: 512,
  ultra: 768,
  survey: 1024,
};
