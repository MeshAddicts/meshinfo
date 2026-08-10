// This file intentionally mixes a router config export with small helper
// components (NodeRedirect, PageLoader) that are only used here. Fast refresh
// is not meaningful for a router module, so the rule is disabled file-wide.
/* eslint-disable react-refresh/only-export-components */
import React, { Suspense } from "react";
import { createBrowserRouter, Navigate, Outlet, useParams } from "react-router";

import { Layout } from "./components/Layout";
import { RouteError } from "./pages/RouteError";

/** Redirect legacy /nodes/:id to the split-view /nodes?node=:id */
function NodeRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={`/nodes?node=${id}`} replace />;
}

// Every page is code-split so the entry chunk stays small and stable; the
// index route is a redirect to /map, so there is no eager landing page
// component to preserve. Map in particular anchors maplibre-gl (~1 MB min),
// which must never land in the entry chunk.
const LazyChat = React.lazy(() =>
  import("./pages/Chat").then((m) => ({ default: m.Chat })),
);
const LazyGraph = React.lazy(() => import("./pages/Graph"));
const LazyLog = React.lazy(() =>
  import("./pages/Log").then((m) => ({ default: m.Log })),
);
const LazyMap = React.lazy(() =>
  import("./pages/Map").then((m) => ({ default: m.Map })),
);
const LazyNeighbors = React.lazy(() =>
  import("./pages/Neighbors").then((m) => ({ default: m.Neighbors })),
);
const LazyNodes = React.lazy(() =>
  import("./pages/Nodes").then((m) => ({ default: m.Nodes })),
);
const LazyStats = React.lazy(() =>
  import("./pages/Stats").then((m) => ({ default: m.Stats })),
);
const LazyTelemetry = React.lazy(() =>
  import("./pages/Telemetry").then((m) => ({ default: m.Telemetry })),
);
const LazyTraceroutes = React.lazy(() =>
  import("./pages/Traceroutes").then((m) => ({ default: m.Traceroutes })),
);

function PageLoader({ label }: { label: string }) {
  return (
    <div className="h-full w-full flex items-center justify-center bg-white dark:bg-gray-950">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-indigo-500 animate-spin" />
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {label}
        </span>
      </div>
    </div>
  );
}

function page(Component: React.ComponentType, label: string) {
  return (
    <Suspense fallback={<PageLoader label={label} />}>
      <Component />
    </Suspense>
  );
}

export const router = createBrowserRouter([
  {
    path: "/",
    element: (
      <Layout>
        <Outlet />
      </Layout>
    ),
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/map" replace /> },
      { path: "/chat", element: page(LazyChat, "Loading chat…") },
      { path: "/graph", element: page(LazyGraph, "Loading graph…") },
      { path: "/map", element: page(LazyMap, "Loading map…") },
      { path: "/nodes", element: page(LazyNodes, "Loading nodes…") },
      { path: "/nodes/:id", element: <NodeRedirect /> },
      { path: "/neighbors", element: page(LazyNeighbors, "Loading neighbors…") },
      { path: "/stats", element: page(LazyStats, "Loading stats…") },
      { path: "/telemetry", element: page(LazyTelemetry, "Loading telemetry…") },
      {
        path: "/traceroutes",
        element: page(LazyTraceroutes, "Loading traceroutes…"),
      },
      { path: "/logs", element: page(LazyLog, "Loading logs…") },
      // legacy redirects
      { path: "/mesh-log", element: <Navigate to="/logs" replace /> },
      { path: "/mqtt-log", element: <Navigate to="/logs" replace /> },
    ],
  },
]);
