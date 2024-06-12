import { createBrowserRouter } from "react-router-dom";

import { Chat } from "./pages/Chat";
import { Home } from "./pages/Home";
import { Map } from "./pages/Map";

export const router = createBrowserRouter([
  { path: "/", element: <Home /> },
  { path: "/chat", element: <Chat /> },
  { path: "/map", element: <Map /> },
]);
