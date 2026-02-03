import { createBrowserRouter, Outlet, Navigate } from "react-router-dom";

import { Layout } from "./components/Layout";
import { Chat } from "./pages/Chat";
import { Graph } from "./pages/Graph";
import { Map } from "./pages/Map";
import { Log } from "./pages/Log";
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
    children: [
      { index: true, element: <Navigate to="/map" replace /> },
      { path: "/chat", element: <Chat /> },
      { path: "/graph", element: <Graph /> },
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
