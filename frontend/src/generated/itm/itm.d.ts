/**
 * Emscripten module produced by build.sh from NTIA/itm v1.4.
 * Auto-generated glue; hand-written `.d.ts` lives here so TS consumers
 * see a typed default export even when the .js is freshly rebuilt.
 */
export interface ItmModule {
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  _ITM_P2P_TLS: (...args: number[]) => number;
  _ITM_P2P_TLS_Ex: (...args: number[]) => number;
  _ITM_P2P_CR: (...args: number[]) => number;
  _ITM_P2P_CR_Ex: (...args: number[]) => number;
  _ITM_AREA_TLS: (...args: number[]) => number;
  _ITM_AREA_TLS_Ex: (...args: number[]) => number;
  _ITM_AREA_CR: (...args: number[]) => number;
  _ITM_AREA_CR_Ex: (...args: number[]) => number;
  HEAP8: Int8Array;
  HEAPU8: Uint8Array;
  HEAP16: Int16Array;
  HEAPU16: Uint16Array;
  HEAP32: Int32Array;
  HEAPU32: Uint32Array;
  HEAPF32: Float32Array;
  HEAPF64: Float64Array;
  getValue(ptr: number, type: string): number;
  setValue(ptr: number, value: number, type: string): void;
}

declare const createItm: (overrides?: Partial<ItmModule>) => Promise<ItmModule>;
export default createItm;
