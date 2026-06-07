import { describe, expect, it } from "vitest";

import { normalizeNodeId8 } from "./normalizeNodeId8";

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
