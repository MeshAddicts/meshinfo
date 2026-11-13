import { describe, expect, it } from "vitest";

import { crc32, zipStore } from "./zipStore";

const ascii = (s: string) => new TextEncoder().encode(s);

/** Reads an archive back the way an unzip tool does: end record → central
 *  directory → each local header. */
function readZip(bytes: Uint8Array): Array<{ name: string; data: Uint8Array; crc: number; method: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  const directorySize = view.getUint32(end + 12, true);
  let pos = view.getUint32(end + 16, true);
  expect(pos + directorySize).toBe(end);

  const decoder = new TextDecoder();
  const entries = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(pos, true)).toBe(0x02014b50);
    const method = view.getUint16(pos + 10, true);
    const crc = view.getUint32(pos + 16, true);
    const size = view.getUint32(pos + 24, true);
    const nameLen = view.getUint16(pos + 28, true);
    const local = view.getUint32(pos + 42, true);
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nameLen));
    pos += 46 + nameLen;

    expect(view.getUint32(local, true)).toBe(0x04034b50);
    expect(view.getUint32(local + 14, true)).toBe(crc);
    expect(view.getUint32(local + 18, true)).toBe(size);
    expect(view.getUint32(local + 22, true)).toBe(size);
    const localNameLen = view.getUint16(local + 26, true);
    expect(decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLen))).toBe(name);
    const start = local + 30 + localNameLen + view.getUint16(local + 28, true);
    entries.push({ name, data: bytes.subarray(start, start + size), crc, method });
  }
  return entries;
}

describe("crc32", () => {
  it("matches the standard check value", () => {
    expect(crc32(ascii("123456789"))).toBe(0xcbf43926);
  });

  it("is 0 for no input", () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });
});

describe("zipStore", () => {
  it("round-trips entries in order, stored and checksummed", () => {
    const binary = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) & 0xff);
    const zip = zipStore([
      { name: "doc.kml", data: ascii("<kml/>") },
      { name: "files/coverage.png", data: binary },
    ]);

    const entries = readZip(zip);
    expect(entries.map((e) => e.name)).toEqual(["doc.kml", "files/coverage.png"]);
    expect(new TextDecoder().decode(entries[0].data)).toBe("<kml/>");
    expect(entries[1].data).toEqual(binary);
    for (const e of entries) {
      expect(e.method).toBe(0);
      expect(e.crc).toBe(crc32(e.data));
    }
  });

  it("writes a valid empty archive", () => {
    const zip = zipStore([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it("encodes the modification time as an MS-DOS timestamp", () => {
    const zip = zipStore([{ name: "a", data: ascii("a") }], new Date(2026, 10, 12, 13, 45, 58));
    const view = new DataView(zip.buffer);
    expect(view.getUint16(10, true)).toBe((13 << 11) | (45 << 5) | 29);
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (11 << 5) | 12);
  });
});
