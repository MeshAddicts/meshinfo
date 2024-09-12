/* eslint-disable no-param-reassign */
import { createSlice } from "@reduxjs/toolkit";

interface InitialState {}

const initialState: InitialState = {};

export const appSlice = createSlice({
  name: "app",
  initialState,
  reducers: {},
});

export const {} = appSlice.actions;
