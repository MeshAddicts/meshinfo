import { createBrowserRouter } from "react-router-dom";

import { Chat } from "./pages/Chat";
import { Home } from "./pages/Home";
import { Map } from "./pages/Map";
import { Nodes } from "./pages/Nodes";

export const router = createBrowserRouter([
  { path: "/next", element: <Home /> },
  { path: "/next/chat", element: <Chat /> },
  { path: "/next/map", element: <Map /> },
  { path: "/next/nodes", element: <Nodes /> },
]);
