/**
 * Unit tests for the shared lat/lng parse + format helpers.
 *
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";

import { formatLatLng, parseLatLng } from "./helpers";

describe("parseLatLng", () => {
  it("parses comma-separated lat,lng into [lng, lat]", () => {
    expect(parseLatLng("37.5816, -121.4944")).toEqual([-121.4944, 37.5816]);
  });

  it("parses whitespace-separated coordinates", () => {
    expect(parseLatLng("37.5816 -121.4944")).toEqual([-121.4944, 37.5816]);
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseLatLng("  37.5816 ,  -121.4944  ")).toEqual([-121.4944, 37.5816]);
  });

  it("accepts a trailing degree sign and N/S/E/W hemisphere", () => {
    expect(parseLatLng("37.5° N, 122.3° W")).toEqual([-122.3, 37.5]);
  });

  it("accepts four whitespace tokens with hemispheres", () => {
    expect(parseLatLng("37.5 N 122.3 W")).toEqual([-122.3, 37.5]);
  });

  it("treats S/W as negative magnitudes regardless of sign", () => {
    expect(parseLatLng("12.0 S, 8.0 E")).toEqual([8, -12]);
  });

  it("rejects out-of-range latitude", () => {
    expect(parseLatLng("95, 10")).toBeNull();
  });

  it("rejects out-of-range longitude", () => {
    expect(parseLatLng("10, 200")).toBeNull();
  });

  it("rejects the wrong number of components", () => {
    expect(parseLatLng("1, 2, 3")).toBeNull();
    expect(parseLatLng("5")).toBeNull();
  });

  it("rejects non-numeric input", () => {
    expect(parseLatLng("somewhere nice")).toBeNull();
    expect(parseLatLng("")).toBeNull();
  });
});

describe("formatLatLng", () => {
  it("formats [lng, lat] as 'lat, lng' at 5 dp by default", () => {
    expect(formatLatLng(-121.494445, 37.581622)).toBe("37.58162, -121.49444");
  });

  it("honors a custom precision", () => {
    expect(formatLatLng(-121.4944, 37.5816, 2)).toBe("37.58, -121.49");
  });
});
