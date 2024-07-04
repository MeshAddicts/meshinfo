import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

import { IChatResponse, INode, INodesResponse } from "../types";

export const apiSlice = createApi({
  reducerPath: "api",
  tagTypes: ["Chat", "Node"],
  baseQuery: fetchBaseQuery({ baseUrl: "/api/data" }),
  endpoints: (builder) => ({
    getChats: builder.query<IChatResponse, void>({
      query: () => "chat.json",
      providesTags: [{ type: "Chat", id: "LIST" }],
    }),
    getNodes: builder.query<Record<string, INode>, void>({
      query: () => "nodes.json",
      transformResponse: (response: INodesResponse) => {
        const now = new Date();
        return Object.fromEntries(
          Object.entries(response).map(([id, node]) => [
            id,
            {
              ...node,
              online: new Date(node.last_seen) > new Date(now.getTime() - 7200),
              position: node.position
                ? [
                    (node.position?.longitude_i ?? 0) / 10000000,
                    (node.position?.latitude_i ?? 0) / 10000000,
                  ]
                : undefined,
              neighbors: node.neighborinfo?.neighbors?.map((neighbor) => ({
                id: neighbor.node_id.toString(16),
                snr: neighbor.snr,
                distance: neighbor.distance,
              })),
            },
          ])
        );
      },
      providesTags: [{ type: "Node", id: "LIST" }],
    }),
  }),
});

export const { useGetChatsQuery, useGetNodesQuery } = apiSlice;
