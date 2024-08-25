import { createBrowserRouter, Outlet } from "react-router-dom";

import { Layout } from "./components/Layout";
import { Chat } from "./pages/Chat";
import { Home } from "./pages/Home";
import { Map } from "./pages/Map";
import { Nodes } from "./pages/Nodes";
import { Map2 } from "./pages/Map2";

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
        { path: "/map", element: <Map /> },
        { path: "/nodes", element: <Nodes /> },
      ],
    },
  ],
  { basename: "/next" }
);
