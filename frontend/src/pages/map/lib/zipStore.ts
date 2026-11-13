/**
 * Minimal ZIP writer: entries are stored, not compressed. That is all a KMZ
 * needs, since its bulk is a PNG that is already compressed.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3), the checksum ZIP stores per entry. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Path inside the archive, forward slashes. */
  name: string;
  data: Uint8Array;
}

const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;
/** 1.0 — the lowest reader version, enough for stored entries. */
const VERSION = 10;
/** General-purpose bit 11: entry names are UTF-8. */
const FLAG_UTF8 = 0x0800;

/** Entries are written in the order given; readers such as Google Earth treat
 *  the first .kml in a KMZ as its root document. */
export function zipStore(entries: ZipEntry[], modified: Date = new Date()): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  const files = entries.map((e) => ({ name: encoder.encode(e.name), data: e.data, crc: crc32(e.data) }));

  // MS-DOS timestamp: 2 s resolution, years from 1980.
  const time = (modified.getHours() << 11) | (modified.getMinutes() << 5) | (modified.getSeconds() >> 1);
  const date =
    (Math.max(0, modified.getFullYear() - 1980) << 9) | ((modified.getMonth() + 1) << 5) | modified.getDate();

  let total = END_RECORD_BYTES;
  for (const f of files) total += LOCAL_HEADER_BYTES + CENTRAL_HEADER_BYTES + 2 * f.name.length + f.data.length;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let pos = 0;

  const offsets: number[] = [];
  for (const f of files) {
    offsets.push(pos);
    view.setUint32(pos, 0x04034b50, true);
    view.setUint16(pos + 4, VERSION, true);
    view.setUint16(pos + 6, FLAG_UTF8, true);
    view.setUint16(pos + 8, 0, true); // method: stored
    view.setUint16(pos + 10, time, true);
    view.setUint16(pos + 12, date, true);
    view.setUint32(pos + 14, f.crc, true);
    view.setUint32(pos + 18, f.data.length, true); // compressed size
    view.setUint32(pos + 22, f.data.length, true); // uncompressed size
    view.setUint16(pos + 26, f.name.length, true);
    out.set(f.name, pos + LOCAL_HEADER_BYTES);
    out.set(f.data, pos + LOCAL_HEADER_BYTES + f.name.length);
    pos += LOCAL_HEADER_BYTES + f.name.length + f.data.length;
  }

  const directoryStart = pos;
  files.forEach((f, i) => {
    view.setUint32(pos, 0x02014b50, true);
    view.setUint16(pos + 4, VERSION, true); // made by
    view.setUint16(pos + 6, VERSION, true); // needed to extract
    view.setUint16(pos + 8, FLAG_UTF8, true);
    view.setUint16(pos + 10, 0, true); // method: stored
    view.setUint16(pos + 12, time, true);
    view.setUint16(pos + 14, date, true);
    view.setUint32(pos + 16, f.crc, true);
    view.setUint32(pos + 20, f.data.length, true);
    view.setUint32(pos + 24, f.data.length, true);
    view.setUint16(pos + 28, f.name.length, true);
    view.setUint32(pos + 42, offsets[i], true); // local header offset
    out.set(f.name, pos + CENTRAL_HEADER_BYTES);
    pos += CENTRAL_HEADER_BYTES + f.name.length;
  });

  view.setUint32(pos, 0x06054b50, true);
  view.setUint16(pos + 8, files.length, true); // entries on this disk
  view.setUint16(pos + 10, files.length, true); // entries in total
  view.setUint32(pos + 12, pos - directoryStart, true);
  view.setUint32(pos + 16, directoryStart, true);

  return out;
}
