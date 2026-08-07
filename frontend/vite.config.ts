import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const proxyTarget = env.VITE_API_PROXY_TARGET ?? "http://meshinfo:9000";

  return {
    plugins: [react()],
    base: "/",
    build: {
      rollupOptions: {
        output: {
          // Rolldown's manual chunking (Vite 8 is Rolldown-powered; the
          // Rollup-style `manualChunks` is deprecated here and ignored when
          // `codeSplitting` is set). Stable vendor chunks mean an app-code
          // change no longer re-downloads the heavy libraries.
          codeSplitting: {
            groups: [
              // maplibre-gl (+ its own deps, captured recursively) is only
              // imported by lazy chunks, so this chunk stays lazy too.
              {
                name: "maplibre",
                test: /node_modules[\\/]maplibre-gl[\\/]/,
                priority: 30,
              },
              {
                name: "react-vendor",
                test: /node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/,
                priority: 20,
              },
              // Deliberately NOT a node_modules catch-all: that would merge
              // lazily-loaded page deps (react-virtuoso, highlight.js, …)
              // into one chunk the entry imports eagerly. Scope it to the
              // redux data layer, which the entry loads at startup anyway.
              {
                name: "vendor",
                test: /node_modules[\\/](@reduxjs[\\/]toolkit|react-redux|redux|redux-thunk|immer|reselect)[\\/]/,
                priority: 10,
              },
            ],
          },
        },
      },
    },
    server: {
      proxy: {
        "/api": {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ""),
        },
      },
    },
  };
});
