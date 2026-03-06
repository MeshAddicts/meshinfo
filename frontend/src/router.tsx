import React, { Suspense } from "react";
import { createBrowserRouter, Navigate,Outlet } from "react-router-dom";

import { Layout } from "./components/Layout";
import { Chat } from "./pages/Chat";
import { Log } from "./pages/Log";
import { Map } from "./pages/Map";
import { Neighbors } from "./pages/Neighbors";
import { Node } from "./pages/Node";
import { Nodes } from "./pages/Nodes";
import { Stats } from "./pages/Stats";
import { Telemetry } from "./pages/Telemetry";
import { Traceroutes } from "./pages/Traceroutes";

// eslint-disable-next-line react-refresh/only-export-components
const LazyGraph = React.lazy(() => import("./pages/Graph"));

// eslint-disable-next-line react-refresh/only-export-components
function GraphLoader() {
  return (
    <div className="h-full w-full flex items-center justify-center bg-white dark:bg-gray-950">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 rounded-full border-2 border-gray-300 dark:border-gray-600 border-t-indigo-500 animate-spin" />
        <span className="text-sm text-gray-500 dark:text-gray-400">
          Loading graph…
        </span>
      </div>
    </div>
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
    children: [
      { index: true, element: <Navigate to="/map" replace /> },
      { path: "/chat", element: <Chat /> },
      {
        path: "/graph",
        element: (
          <Suspense fallback={<GraphLoader />}>
            <LazyGraph />
          </Suspense>
        ),
      },
      { path: "/map", element: <Map /> },
      { path: "/nodes", element: <Nodes /> },
      { path: "/nodes/:id", element: <Node /> },
      { path: "/neighbors", element: <Neighbors /> },
      { path: "/stats", element: <Stats /> },
      { path: "/telemetry", element: <Telemetry /> },
      { path: "/traceroutes", element: <Traceroutes /> },
      { path: "/logs", element: <Log /> },
      // legacy redirects
      { path: "/mesh-log", element: <Navigate to="/logs" replace /> },
      { path: "/mqtt-log", element: <Navigate to="/logs" replace /> },
    ],
  },
]);
