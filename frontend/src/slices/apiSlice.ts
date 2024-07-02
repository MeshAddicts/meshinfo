import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

import { IChatResponse, INodesResponse } from "../types";

export const apiSlice = createApi({
  reducerPath: "api",
  tagTypes: ["Chat", "Node"],
  baseQuery: fetchBaseQuery({ baseUrl: "/api/data" }),
  endpoints: (builder) => ({
    getChats: builder.query<IChatResponse, void>({
      query: () => "chat.json",
      providesTags: [{ type: "Chat", id: "LIST" }],
    }),
    getNodes: builder.query<INodesResponse, void>({
      query: () => "nodes.json",
      providesTags: [{ type: "Node", id: "LIST" }],
    }),
  }),
});

export const { useGetChatsQuery, useGetNodesQuery } = apiSlice;
