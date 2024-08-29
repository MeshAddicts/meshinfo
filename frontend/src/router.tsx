import { createBrowserRouter, Outlet } from "react-router-dom";

import { Layout } from "./components/Layout";
import { Chat } from "./pages/Chat";
import { Graph } from "./pages/Graph";
import { Home } from "./pages/Home";
import { Map } from "./pages/Map";
import { MeshLog } from "./pages/MeshLog";
import { MqttLog } from "./pages/MqttLog";
import { Neighbors } from "./pages/Neighbors";
import { Node } from "./pages/Node";
import { Nodes } from "./pages/Nodes";
import { Stats } from "./pages/Stats";
import { Telemetry } from "./pages/Telemetry";
import { Traceroutes } from "./pages/Traceroutes";

export const router = createBrowserRouter(
  [
    {
      path: "/",
      element: (
        <Layout>
          <Outlet />
        </Layout>
      ),
      children: [
        { path: "", element: <Home /> },
        { path: "/chat", element: <Chat /> },
        { path: "/graph", element: <Graph /> },
        { path: "/map", element: <Map /> },
        { path: "/nodes", element: <Nodes /> },
        { path: "/nodes/:id", element: <Node /> },
        { path: "/neighbors", element: <Neighbors /> },
        { path: "/stats", element: <Stats /> },
        { path: "/telemetry", element: <Telemetry /> },
        { path: "/traceroutes", element: <Traceroutes /> },
        { path: "/mesh-log", element: <MeshLog /> },
        { path: "/mqtt-log", element: <MqttLog /> },
      ],
    },
  ],
  { basename: "/next" }
);
