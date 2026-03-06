 
import { createSlice } from "@reduxjs/toolkit";

interface InitialState {}

const initialState: InitialState = {};

export const appSlice = createSlice({
  name: "app",
  initialState,
  reducers: {},
});

// Actions will be exported here when reducers are added
