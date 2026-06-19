import { createSlice } from "@reduxjs/toolkit";

interface AppState {
  /**
   * Monotonic counter bumped once per live `chat` SSE event (see
   * useLiveEvents). The Chat page refetches when this changes *and* its live
   * toggle is on, so pushed chats are delivered without breaking the explicit
   * "Live off" pause.
   */
  chatPing: number;
}

const initialState: AppState = {
  chatPing: 0,
};

export const appSlice = createSlice({
  name: "app",
  initialState,
  reducers: {
    chatPinged(state) {
      state.chatPing += 1;
    },
  },
});

export const { chatPinged } = appSlice.actions;
