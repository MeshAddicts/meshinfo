#!/usr/bin/env sh
# Fetches NTIA/itm at a pinned tag into ./vendor/.
# Safe to re-run — blows away and re-clones if vendor/ already exists.
set -eu

ITM_TAG="v1.4"
ITM_REPO="https://github.com/NTIA/itm.git"

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE"

if [ -d vendor ]; then
  echo "[fetch-vendor] removing existing vendor/"
  rm -rf vendor
fi

echo "[fetch-vendor] cloning NTIA/itm @ ${ITM_TAG}"
git clone --depth 1 --branch "${ITM_TAG}" "${ITM_REPO}" vendor

# The upstream sources were authored on Windows and use backslash path
# separators inside #include directives, e.g.:
#
#   #include "..\include\itm.h"
#
# On Linux (and therefore Emscripten), clang treats the backslashed form
# as a single filename rather than a path and the compile fails with
# `'..\include\itm.h' file not found`. Normalize all include lines to
# forward slashes. Scoped to lines beginning with `#include` so string
# literals and comments elsewhere aren't touched.
echo "[fetch-vendor] normalizing Windows-style include paths to POSIX"
find vendor/src vendor/include \( -name '*.cpp' -o -name '*.h' -o -name '*.hpp' \) -print0 \
  | xargs -0 sed -i -E '/^[[:space:]]*#[[:space:]]*include/ s|\\|/|g'

# The upstream `itm.h` unconditionally does:
#
#   #define DLLEXPORT extern "C" __declspec(dllexport)
#
# `__declspec(dllexport)` is a Microsoft-specific attribute that clang
# (which emcc wraps) rejects on non-Windows builds with:
#
#   error: '__declspec' attributes are not enabled; use '-fdeclspec' or '-fms-extensions'
#
# We don't need Windows DLL semantics — Emscripten's `-s EXPORTED_FUNCTIONS`
# keeps our target symbols alive and `extern "C"` gives them clean C
# names. So strip the `__declspec(dllexport)` tokens everywhere in the
# vendored tree. The macro still expands to `extern "C"` which is what
# we want.
echo "[fetch-vendor] stripping __declspec(dllexport) from vendored sources"
find vendor \( -name '*.h' -o -name '*.hpp' -o -name '*.cpp' \) -print0 \
  | xargs -0 sed -i 's| __declspec(dllexport)||g'

# Pull test fixtures into a friendlier location for the vitest suite.
# The upstream `cmd_examples/` dir holds both input files (i_*.txt) and
# expected outputs (o_*.txt) — we copy both. Each input describes a small
# batch of predictions; the matching output gives the reference's own
# path-loss numbers so we can assert our WASM port matches exactly.
if [ -d fixtures ]; then
  rm -rf fixtures
fi
mkdir -p fixtures
if [ -d vendor/cmd_examples ]; then
  cp vendor/cmd_examples/*.txt fixtures/ 2>/dev/null || true
  echo "[fetch-vendor] copied $(ls fixtures/ | wc -l) example files to fixtures/"
else
  echo "[fetch-vendor] WARNING: vendor/cmd_examples not found"
fi

echo "[fetch-vendor] done. Vendor at $(git -C vendor describe --tags)."
