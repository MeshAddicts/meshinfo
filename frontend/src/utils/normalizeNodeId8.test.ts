import { describe, expect, it } from "vitest";

import { normalizeNodeId8, normNodeId } from "./normalizeNodeId8";

describe("normNodeId", () => {
  it("pads numeric ids to 8 hex chars (matches backend keys)", () => {
    expect(normNodeId(0x0165ec15)).toBe("0165ec15");
    expect(normNodeId(255)).toBe("000000ff");
  });

  it("treats ≤8-digit all-decimal strings as hex verbatim", () => {
    // 8-hex backend ids can be all digits; decimal ids arrive as numbers or
    // >8-digit strings, so at ≤8 chars hex must win.
    expect(normNodeId("23456789")).toBe("23456789");
    expect(normNodeId("1234567")).toBe("1234567");
  });

  it("decimal-parses >8-digit numeric strings, padded", () => {
    expect(normNodeId("1128082076")).toBe((1128082076).toString(16));
    expect(normNodeId("305441741")).toBe("1234abcd");
  });

  it("passes longnames through lowercased and unpadded", () => {
    expect(normNodeId("Base Camp")).toBe("base camp");
    expect(normNodeId("cafe")).toBe("cafe");
  });
});

describe("normalizeNodeId8", () => {
  it("left-pads short hex to the canonical 8 chars", () => {
    expect(normalizeNodeId8(255)).toBe("000000ff");
    expect(normalizeNodeId8("a9c")).toBe("00000a9c");
    expect(normalizeNodeId8(" a9c ")).toBe("00000a9c");
  });

  it("passes through full ids and strips ! / 0x / case", () => {
    expect(normalizeNodeId8("433d2a9c")).toBe("433d2a9c");
    expect(normalizeNodeId8("!433D2A9C")).toBe("433d2a9c");
    expect(normalizeNodeId8("0x433d2a9c")).toBe("433d2a9c");
  });

  it("accepts a protobuf decimal uint32 (int or numeric string) identically", () => {
    const fromInt = normalizeNodeId8(1128082076);
    expect(fromInt).toHaveLength(8);
    expect(normalizeNodeId8("1128082076")).toBe(fromInt);
  });

  it("normalizes the broadcast address to ffffffff (callers must guard it)", () => {
    expect(normalizeNodeId8(4294967295)).toBe("ffffffff");
  });

  it("returns undefined for missing / invalid ids", () => {
    expect(normalizeNodeId8(null)).toBeUndefined();
    expect(normalizeNodeId8(undefined)).toBeUndefined();
    expect(normalizeNodeId8(0)).toBeUndefined();
    expect(normalizeNodeId8(-5)).toBeUndefined();
    expect(normalizeNodeId8("")).toBeUndefined();
  });
});
