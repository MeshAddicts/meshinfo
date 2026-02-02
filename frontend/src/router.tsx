import { createBrowserRouter, Outlet, Navigate } from "react-router-dom";

import { Layout } from "./components/Layout";
import { RouteError } from "./pages/RouteError";

import { Chat } from "./pages/Chat";
import { Graph } from "./pages/Graph";
import { Map } from "./pages/Map";
import { MeshLog } from "./pages/MeshLog";
import { MqttLog } from "./pages/MqttLog";
import { Neighbors } from "./pages/Neighbors";
import { Node } from "./pages/Node";
import { Nodes } from "./pages/Nodes";
import { Stats } from "./pages/Stats";
import { Telemetry } from "./pages/Telemetry";
import { Traceroutes } from "./pages/Traceroutes";

export const router = createBrowserRouter([
  {
    path: "/",
    element: (
      <Layout>
        <Outlet />
      </Layout>
    ),
    // ✅ Render error UI directly (does not depend on Layout rendering children)
    errorElement: <RouteError />,
    children: [
      { index: true, element: <Navigate to="/map" replace /> },

      // (Optional but harmless) Redundant per-route boundaries for extra certainty
      { path: "/chat", element: <Chat />, errorElement: <RouteError /> },
      { path: "/graph", element: <Graph />, errorElement: <RouteError /> },
      { path: "/map", element: <Map />, errorElement: <RouteError /> },
      { path: "/nodes", element: <Nodes />, errorElement: <RouteError /> },
      { path: "/nodes/:id", element: <Node />, errorElement: <RouteError /> },
      { path: "/neighbors", element: <Neighbors />, errorElement: <RouteError /> },
      { path: "/stats", element: <Stats />, errorElement: <RouteError /> },
      { path: "/telemetry", element: <Telemetry />, errorElement: <RouteError /> },
      { path: "/traceroutes", element: <Traceroutes />, errorElement: <RouteError /> },
      { path: "/mesh-log", element: <MeshLog />, errorElement: <RouteError /> },
      { path: "/mqtt-log", element: <MqttLog />, errorElement: <RouteError /> },
    ],
  },
]);
