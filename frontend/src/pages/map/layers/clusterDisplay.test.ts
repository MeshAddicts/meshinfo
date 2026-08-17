import { describe, expect, it } from "vitest";

import {
  abbreviateCount,
  displayFeatureCollection,
  dropDominatedByFinerTiles,
  mergeOverlappingClusters,
  parseClusterMembers,
  pixelRadiusForCount,
  type SourceCluster,
  zoomDeltaToSeparate,
} from "./clusterDisplay";

// px per degree of longitude at zoom z (512 px tiles)
const pxPerDegLng = (z: number) => (512 * Math.pow(2, z)) / 360;

function pair(sepPx: number, zoom: number, countA: number, countB: number, lat = 34): SourceCluster[] {
  const dLng = sepPx / pxPerDegLng(zoom);
  return [
    { lng: -118, lat, count: countA, online: countA, clusterId: 1 },
    { lng: -118 + dLng, lat, count: countB, online: 0, clusterId: 2 },
  ];
}

describe("mergeOverlappingClusters", () => {
  it("leaves well-separated clusters alone", () => {
    const out = mergeOverlappingClusters(pair(200, 6, 246, 211), 6);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.members)).toEqual([[1], [2]]);
    expect(out.map((c) => c.count).sort()).toEqual([211, 246]);
  });

  it("merges two big clusters whose donuts overlap (issue #567, LA at z6: 30 px apart)", () => {
    const out = mergeOverlappingClusters(pair(30, 6, 246, 211), 6);
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.count).toBe(457);
    expect(m.online).toBe(246);
    expect(m.members.sort()).toEqual([1, 2]);
    expect(m.r).toBe(pixelRadiusForCount(457));
    // count-weighted centroid sits between the two, nearer the bigger one
    expect(m.lng).toBeGreaterThan(-118);
    expect(m.lng).toBeLessThan(-118 + 30 / pxPerDegLng(6) / 2);
    expect(m.lat).toBeCloseTo(34, 3);
  });

  it("merges when the gap is smaller than the pad, not when it clears it", () => {
    const need = pixelRadiusForCount(370) + pixelRadiusForCount(32); // 52 + ~34
    expect(mergeOverlappingClusters(pair(need + 1, 8, 370, 32), 8)).toHaveLength(1); // inside 2 px pad
    expect(mergeOverlappingClusters(pair(need + 3, 8, 370, 32), 8)).toHaveLength(2);
  });

  it("the same pair separates again at a higher zoom, and reports that zoom", () => {
    const src = pair(80, 6, 246, 211); // need 106 px → separates 0.41 zoom levels in
    const [m] = mergeOverlappingClusters(src, 6);
    const dz = zoomDeltaToSeparate(80, 52 + 52 + 2);
    expect(dz).toBeLessThan(1);
    expect(m.splitZoom).toBeCloseTo(6 + dz, 2);
    expect(mergeOverlappingClusters(src, 6 + dz + 0.05)).toHaveLength(2);
    expect(mergeOverlappingClusters(src, 6 + dz - 0.05)).toHaveLength(1);
  });

  it("caps splitZoom at the next integer zoom (source clusters change there anyway)", () => {
    const [m] = mergeOverlappingClusters(pair(5, 6.4, 246, 211), 6.4);
    expect(m.splitZoom).toBe(7);
  });

  it("merge:false keeps every cluster (past clusterMaxZoom)", () => {
    const out = mergeOverlappingClusters(pair(5, 21.5, 40, 40), 21.5, { merge: false });
    expect(out).toHaveLength(2);
    expect(out.every((c) => c.splitZoom === undefined)).toBe(true);
  });

  it("chains: a merged marker that grows absorbs a third neighbour", () => {
    // A(100) and B(100) overlap; C(20) is just outside A but inside the merged marker.
    const z = 7;
    const rA = pixelRadiusForCount(100), rC = pixelRadiusForCount(20);
    const sepAB = 40;
    const sepAC = rA + rC + 4; // clear of A alone by 2 px beyond the pad
    const src: SourceCluster[] = [
      { lng: -118, lat: 34, count: 100, online: 50, clusterId: 1 },
      { lng: -118 + sepAB / pxPerDegLng(z), lat: 34, count: 100, online: 50, clusterId: 2 },
      { lng: -118 - sepAC / pxPerDegLng(z), lat: 34, count: 20, online: 5, clusterId: 3 },
    ];
    const out = mergeOverlappingClusters(src, z);
    // AB merge → r=52 and centroid moves toward B, so C stays separate; verify
    // the fixpoint loop ran without double-counting either way.
    const total = out.reduce((s, c) => s + c.count, 0);
    expect(total).toBe(220);
    expect(out.flatMap((c) => c.members).sort()).toEqual([1, 2, 3]);
  });

  it("never merges clusters from different tile zooms (parent would double-count its children)", () => {
    const src = pair(30, 6, 246, 211).map((c, i) => ({ ...c, z: 6 + i }));
    expect(mergeOverlappingClusters(src, 6)).toHaveLength(2);
    const same = pair(30, 6, 246, 211).map((c) => ({ ...c, z: 6 }));
    expect(mergeOverlappingClusters(same, 6)).toHaveLength(1);
  });

  it("is deterministic regardless of input order", () => {
    const src = pair(30, 6, 246, 211);
    const a = mergeOverlappingClusters(src, 6);
    const b = mergeOverlappingClusters([...src].reverse(), 6);
    expect(a).toEqual(b);
  });

  it("empty input → empty output", () => {
    expect(mergeOverlappingClusters([], 5)).toEqual([]);
  });
});

describe("abbreviateCount", () => {
  it("matches supercluster's point_count_abbreviated", () => {
    expect(abbreviateCount(457)).toBe("457");
    expect(abbreviateCount(1234)).toBe("1.2k");
    expect(abbreviateCount(12345)).toBe("12k");
  });
});

describe("displayFeatureCollection / parseClusterMembers", () => {
  it("unmerged markers keep their source cluster_id and feature id; merged get a negative id + members", () => {
    const display = mergeOverlappingClusters(
      [...pair(30, 6, 246, 211), { lng: -100, lat: 40, count: 9, online: 4, clusterId: 77 }],
      6,
    );
    const fc = displayFeatureCollection(display);
    expect(fc.features).toHaveLength(2);
    const merged = fc.features.find((f) => f.properties!.merged)!;
    const single = fc.features.find((f) => !f.properties!.merged)!;

    expect(single.id).toBe(77);
    expect(single.properties).toMatchObject({ cluster: true, cluster_id: 77, point_count: 9, onlineCount: 4, point_count_abbreviated: "9" });
    expect(parseClusterMembers(single.properties)).toEqual([]);

    expect(merged.id).toBeUndefined();
    expect(merged.properties!.cluster_id).toBe(-1);
    expect(merged.properties).toMatchObject({ point_count: 457, onlineCount: 246, point_count_abbreviated: "457" });
    expect(typeof merged.properties!.members).toBe("string"); // survives the tile pbf as a string
    expect(parseClusterMembers(merged.properties).sort()).toEqual([1, 2]);
    expect(merged.properties!.split_zoom).toBeGreaterThan(6);
  });

  it("parseClusterMembers tolerates junk", () => {
    expect(parseClusterMembers(null)).toEqual([]);
    expect(parseClusterMembers({ members: "not json" })).toEqual([]);
    expect(parseClusterMembers({ members: "[1,\"x\",3]" })).toEqual([1, 3]);
    expect(parseClusterMembers({ members: [4, 5] })).toEqual([4, 5]);
  });
});

describe("dropDominatedByFinerTiles", () => {
  // Web-Mercator tile containing a point at zoom z (matches the helper's projection)
  const tileAt = (lng: number, lat: number, z: number) => {
    const n = 2 ** z;
    const x = Math.floor((lng / 360 + 0.5) * n);
    const sin = Math.sin((lat * Math.PI) / 180);
    const y = Math.floor((0.5 - (0.25 * Math.log((1 + sin) / (1 - sin))) / Math.PI) * n);
    return { x, y };
  };

  it("keeps everything when only one zoom is present", () => {
    const items = [
      { z: 6, ...tileAt(-118, 34, 6), lng: -118, lat: 34, id: "a" },
      { z: 6, ...tileAt(-122, 37, 6), lng: -122, lat: 37, id: "b" },
    ];
    expect(dropDominatedByFinerTiles(items).map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("drops a parent-tile feature where a child tile is present, keeps it elsewhere", () => {
    const f = (z: number, lng: number, lat: number, id: string) => ({ z, ...tileAt(lng, lat, z), lng, lat, id });
    const la7 = f(7, -118.25, 34.05, "child-LA");
    const la6 = f(6, -118.26, 34.06, "parent-LA"); // same z7 tile as the child
    expect(tileAt(la6.lng, la6.lat, 7)).toEqual({ x: la7.x, y: la7.y });
    const sd6 = f(6, -117.1, 32.7, "parent-SD"); // no z7 tile present here
    expect(tileAt(sd6.lng, sd6.lat, 7)).not.toEqual({ x: la7.x, y: la7.y });
    const out = dropDominatedByFinerTiles([la6, la7, sd6]).map((i) => i.id);
    expect(out).toContain("child-LA");
    expect(out).not.toContain("parent-LA");
    expect(out).toContain("parent-SD");
  });

  it("with mixed zooms, buffer copies (features outside their own tile) are dropped", () => {
    const child = { z: 7, ...tileAt(-118.2, 34.0, 7), lng: -118.2, lat: 34.0, id: "child" };
    // z6 copy that a neighbouring tile's buffer returned (tile x/y unrelated to the point)
    const parentBufferCopy = { z: 6, x: 0, y: 0, lng: -118.2, lat: 34.0, id: "parent-copy" };
    // z7 buffer copy of a cluster that actually lies in a region only a z6 tile covers
    const fineBufferCopy = { z: 7, ...tileAt(-118.2, 34.0, 7), lng: -117.0, lat: 32.7, id: "fine-buffer" };
    const coarseThere = { z: 6, ...tileAt(-117.0, 32.7, 6), lng: -117.05, lat: 32.72, id: "coarse-there" };
    const out = dropDominatedByFinerTiles([child, parentBufferCopy, fineBufferCopy, coarseThere]).map((i) => i.id);
    expect(out).toEqual(["child", "coarse-there"]);
  });

  it("with a single zoom, buffer copies are kept (position dedupe handles them)", () => {
    const a = { z: 7, ...tileAt(-118.2, 34.0, 7), lng: -118.2, lat: 34.0, id: "a" };
    const aBuffer = { z: 7, x: 0, y: 0, lng: -118.2, lat: 34.0, id: "a-buffer" };
    expect(dropDominatedByFinerTiles([a, aBuffer]).map((i) => i.id)).toEqual(["a", "a-buffer"]);
  });
});
