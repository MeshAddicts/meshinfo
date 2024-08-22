import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

import { IChatResponse, INodesResponse } from "../types";
import { IConfigResponse } from "../types/config";

export const apiSlice = createApi({
  reducerPath: "api",
  tagTypes: ["Chat", "Node", "Config"],
  baseQuery: fetchBaseQuery({ baseUrl: "/api/v1" }),
  endpoints: (builder) => ({
    getConfig: builder.query<IConfigResponse, void>({
      query: () => "server/config",
      transformResponse: (response: { config: IConfigResponse }) =>
        response.config,
      providesTags: [{ type: "Config", id: "LIST" }],
    }),
    getChats: builder.query<IChatResponse, void>({
      query: () => "chat",
      transformResponse: (response: IChatResponse) => {
        const channels = Object.fromEntries(
          Object.entries(response.channels).map(([id, channel]) => [
            id,
            {
              ...channel,
              totalMessages: channel.messages.length,
              messages: Object.values(
                channel.messages.reduce(
                  (acc, message) => ({
                    ...acc,
                    [message.id]: {
                      ...message,
                      sender: (acc[message.id]?.sender ?? []).concat(
                        message.sender
                      ),
                    },
                  }),
                  {} as Record<
                    string,
                    IChatResponse["channels"]["0"]["messages"][0]
                  >
                )
              ),
            },
          ])
        );
        return { channels };
      },
      providesTags: [{ type: "Chat", id: "LIST" }],
    }),
    getNodes: builder.query<INodesResponse, void>({
      query: () => "nodes",
      transformResponse: (response: INodesResponse) =>
        Object.fromEntries(
          Object.entries(response.nodes).map(([id, node]) => [
            id,
            {
              ...node,
              position: node.position
                ? {
                    ...node.position,
                    latitude: node.position.latitude_i / 1e7,
                    longitude: node.position.longitude_i / 1e7,
                  }
                : undefined,
            },
          ])
        ),
      providesTags: [{ type: "Node", id: "LIST" }],
    }),
  }),
});

export const { useGetChatsQuery, useGetNodesQuery, useGetConfigQuery } =
  apiSlice;
