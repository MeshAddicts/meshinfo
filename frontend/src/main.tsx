import "./index.css";

import React from "react";
import ReactDOM from "react-dom/client";
import { Provider } from "react-redux";
import { RouterProvider } from "react-router";

import { LiveEvents } from "./components/LiveEvents";
import { ToastHost } from "./components/toast";
import { router } from "./router";
import { store } from "./store";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Provider store={store}>
      <LiveEvents />
      <RouterProvider router={router} />
      <ToastHost />
    </Provider>
  </React.StrictMode>
);
