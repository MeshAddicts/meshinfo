import { describe, expect, it } from "vitest";

import { nextCoverageSearch, parseCoverageParam } from "./coverageUrlParam";

describe("parseCoverageParam", () => {
  it("returns null when the param is absent", () => {
    expect(parseCoverageParam("")).toBeNull();
    expect(parseCoverageParam("?lat=37.1&lng=-118.2&z=6")).toBeNull();
  });

  it("reads 1 and true (any case) as on", () => {
    expect(parseCoverageParam("?cov=1")).toBe(true);
    expect(parseCoverageParam("?cov=true")).toBe(true);
    expect(parseCoverageParam("?cov=TRUE")).toBe(true);
  });

  it("reads 0, false, and unrecognized values as off", () => {
    expect(parseCoverageParam("?cov=0")).toBe(false);
    expect(parseCoverageParam("?cov=false")).toBe(false);
    expect(parseCoverageParam("?cov=banana")).toBe(false);
  });
});

describe("nextCoverageSearch", () => {
  it("appends cov=1 when enabling, preserving other params", () => {
    expect(nextCoverageSearch("?lat=37.1&z=6.04", true)).toBe("lat=37.1&z=6.04&cov=1");
    expect(nextCoverageSearch("", true)).toBe("cov=1");
  });

  it("leaves pristine URLs alone while off", () => {
    expect(nextCoverageSearch("?lat=37.1", false)).toBeNull();
    expect(nextCoverageSearch("", false)).toBeNull();
  });

  it("flips an existing cov to 0 in place when disabling", () => {
    expect(nextCoverageSearch("?cov=1&lat=37.1", false)).toBe("cov=0&lat=37.1");
  });

  it("no-ops when the URL already matches", () => {
    expect(nextCoverageSearch("?cov=1", true)).toBeNull();
    expect(nextCoverageSearch("?cov=0", false)).toBeNull();
  });

  it("normalizes true/false spellings to 1/0", () => {
    expect(nextCoverageSearch("?cov=true", true)).toBe("cov=1");
    expect(nextCoverageSearch("?cov=false", false)).toBe("cov=0");
  });
});
