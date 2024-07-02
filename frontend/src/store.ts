import { configureStore } from "@reduxjs/toolkit";
import { appSlice } from "./slices/appSlice";
import { apiSlice } from "./slices/apiSlice";

export const store = configureStore({
  reducer: {
    [appSlice.reducerPath]: appSlice.reducer,
    [apiSlice.reducerPath]: apiSlice.reducer,
  },
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware().concat(apiSlice.middleware),
});

// Infer the `RootState` and `AppDispatch` types from the store itself
export type RootState = ReturnType<typeof store.getState>;
// Inferred type: {posts: PostsState, comments: CommentsState, users: UsersState}
export type AppDispatch = typeof store.dispatch;
