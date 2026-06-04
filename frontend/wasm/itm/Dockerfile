# Self-contained build image for the ITM WebAssembly module.
#
# Usage from repo root:
#   docker build -t meshinfo-itm-build frontend/wasm/itm
#   docker run --rm -v "$PWD/frontend/src/generated/itm":/out meshinfo-itm-build
#
# The container runs fetch-vendor.sh + build.sh, then copies artifacts
# (itm.js and itm.d.ts) out to the volume mount.

FROM emscripten/emsdk:6.0.0 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /itm

# Scripts are copied in first so Docker caches dependency layers above
COPY fetch-vendor.sh build.sh shim.h ./
RUN chmod +x fetch-vendor.sh build.sh

# Fetch upstream + build. These run at image build time so repeated
# `docker run` invocations are instant — build happens once per image.
RUN ./fetch-vendor.sh
RUN ./build.sh

# At container run time, copy the artifacts out to whatever the caller
# mounted at /out. Using cp not mv so repeated runs are idempotent.
CMD ["sh", "-c", "cp -v dist/itm.js /out/itm.js && cp -v dist/itm.d.ts /out/itm.d.ts && echo OK"]
