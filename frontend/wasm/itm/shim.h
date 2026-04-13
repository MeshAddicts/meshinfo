/*
 * Compatibility shim for the NTIA ITM sources, which are designed to build
 * as a Windows DLL. Upstream declares each exported function as
 *
 *     extern "C" DLLEXPORT int ITM_P2P_TLS(...)
 *
 * where `DLLEXPORT` expands to `__declspec(dllexport)` on MSVC. Under
 * Emscripten / non-Windows builds that macro is a no-op. We override it
 * to `EMSCRIPTEN_KEEPALIVE` so the linker does not dead-strip the
 * public entry points.
 *
 * This header is force-included by the emcc invocation (via `-include`),
 * before any upstream source, so we intercept the symbol.
 */

#ifndef MESHINFO_ITM_SHIM_H
#define MESHINFO_ITM_SHIM_H

#ifdef __EMSCRIPTEN__
  #include <emscripten/emscripten.h>
  #undef  DLLEXPORT
  #define DLLEXPORT EMSCRIPTEN_KEEPALIVE
#endif

#endif /* MESHINFO_ITM_SHIM_H */
