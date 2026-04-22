# ITM (Longley-Rice) WebAssembly build

This directory builds NTIA's official Irregular Terrain Model reference
implementation to WebAssembly, for use by the coverage prediction tool.

## Source

- **Upstream:** https://github.com/NTIA/itm
- **Pinned version:** tag `v1.4` (2021-04-26)
- **Language:** C++ (the `itm-longley-rice` FORTRAN legacy archive is NOT used)
- **License:** US-Government work — public domain in the US, no warranty,
  attribution requested. See `vendor/LICENSE.md` after running `fetch-vendor.sh`.
- **Primary algorithm reference:** NTIA Report 82-100 (Hufford, Longley, Kissick,
  1982) and the 1985 Hufford algorithm memo.

## How it fits together

```
 wasm/itm/
 ├── fetch-vendor.sh    clones NTIA/itm @ v1.4 into vendor/
 ├── shim.h             remaps DLLEXPORT → EMSCRIPTEN_KEEPALIVE
 ├── build.sh           runs emcc with the right exports
 ├── Dockerfile         emscripten/emsdk base image, self-contained build
 ├── vendor/            (gitignored) upstream source, fetched on build
 └── dist/              (gitignored) intermediate build output
```

Final artifacts are emitted into `frontend/src/generated/itm/`:

```
 src/generated/itm/
 ├── itm.js             emscripten loader (embeds the .wasm via SINGLE_FILE=1)
 └── itm.d.ts           typed shim so TS consumers compile
```

This keeps the TS consumer import path stable (`import createItm from
"../generated/itm/itm.js"`) regardless of whether the artifact is freshly
built or left over from a previous run.

## Building locally

One-liner from the repo root:

```bash
docker build -t meshinfo-itm-build frontend/wasm/itm
docker run --rm -v "$PWD/frontend/src/generated/itm":/out meshinfo-itm-build
```

Or via the npm script (same thing, nicer ergonomics):

```bash
cd frontend && yarn build:wasm
```

The build takes a few minutes on first run because Docker has to download
the `emscripten/emsdk` base image (~1 GB). Subsequent runs are <30s.

## Why SINGLE_FILE=1

We embed the WASM binary as base64 inside `itm.js` via
`-s SINGLE_FILE=1`. This trades ~33% size for zero file-loading
complexity — Vite, Web Workers, tests, and prod bundles all just `import`
one JS file and get a ready-to-use module. The WASM is ~100–200 KB raw;
embedded it's ~150–300 KB, well within tolerable bundle overhead for the
coverage tool.

## Validation

`cmd_examples/` in the upstream repo contains input/output pairs produced
by the reference CLI driver. `fetch-vendor.sh` copies these into
`fixtures/` so the vitest suite (`src/pages/map/itm.test.ts`) can prove
our WASM port matches the reference output bit-for-bit.

## Attribution

When shipping a production build, the UI's propagation-model tooltip
should include:

> "Basic transmission loss computed with NTIA's Irregular Terrain Model
> (ITM v1.4). Public-domain source: github.com/NTIA/itm."

and the `LICENSE.md` file from the upstream repo should be bundled in
the project's third-party notices.
