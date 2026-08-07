import { configureStore } from "@reduxjs/toolkit";
import { setupListeners } from "@reduxjs/toolkit/query";

import { apiSlice } from "./slices/apiSlice";
import { appSlice } from "./slices/appSlice";

export const store = configureStore({
  reducer: {
    [appSlice.reducerPath]: appSlice.reducer,
    [apiSlice.reducerPath]: apiSlice.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(apiSlice.middleware),
});

// Without this, RTK Query never learns about focus/visibility changes and every
// skipPollingIfUnfocused / refetchOnFocus flag in the app is silently inert —
// hidden tabs keep polling full payloads forever.
setupListeners(store.dispatch);

// Infer the `RootState` and `AppDispatch` types from the store itself
export type RootState = ReturnType<typeof store.getState>;
// Inferred type: {posts: PostsState, comments: CommentsState, users: UsersState}
export type AppDispatch = typeof store.dispatch;
