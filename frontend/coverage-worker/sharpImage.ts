/** sharp-backed tile decode (for the engine's tile builders) + RGBA→PNG encode. */
import sharp from "sharp";

import { setTilePixelDecoder } from "../src/pages/map/tileDecode";

/** Point the engine's tile decoder at sharp. Call once at startup. */
export function installSharpDecoder(): void {
  setTilePixelDecoder(async (blob) => {
    const buf = Buffer.from(await blob.arrayBuffer());
    const { data, info } = await sharp(buf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data: new Uint8ClampedArray(data) };
  });
}

/** Encode a width×height RGBA buffer to a PNG. */
export function encodePng(rgba: Uint8ClampedArray, width: number, height: number): Promise<Buffer> {
  return sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), {
    raw: { width, height, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
