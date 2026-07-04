/**
 * Injectable PNG-tile decoder so the tile builders run outside the browser.
 * Browser default: createImageBitmap + OffscreenCanvas. The coverage-worker
 * injects a sharp decoder via setTilePixelDecoder().
 */
export interface DecodedTile {
  width: number;
  height: number;
  /** RGBA, row-major, length width*height*4. */
  data: Uint8ClampedArray;
}

export type TilePixelDecoder = (blob: Blob) => Promise<DecodedTile>;

const browserDecoder: TilePixelDecoder = async (blob) => {
  const bitmap = await createImageBitmap(blob);
  try {
    const w = bitmap.width;
    const h = bitmap.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("OffscreenCanvas 2d context unavailable");
    ctx.drawImage(bitmap, 0, 0);
    const img = ctx.getImageData(0, 0, w, h);
    return { width: w, height: h, data: img.data };
  } finally {
    bitmap.close();
  }
};

let activeDecoder: TilePixelDecoder = browserDecoder;

/** Override the tile decoder (e.g. a sharp-based one in Node). */
export function setTilePixelDecoder(decoder: TilePixelDecoder): void {
  activeDecoder = decoder;
}

/** Decode a PNG tile blob to RGBA pixels using the active decoder. */
export function decodeTilePixels(blob: Blob): Promise<DecodedTile> {
  return activeDecoder(blob);
}
