import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

import {
  IChannelResponse,
  IChatMessageResponse,
  IMessagesResponse,
  IMqttMessagesResponse,
  INode,
  INodesResponse,
  IStatsResponse,
  ITelemetryResponse,
  ITraceroutesResponse,
} from "../types";
import { IConfigResponse } from "../types/config";

export const apiSlice = createApi({
  reducerPath: "api",
  tagTypes: [
    "Chat",
    "Channels",
    "Node",
    "Config",
    "Stats",
    "Telemetry",
    "Traceroutes",
    "Messages",
    "MqttMessages",
  ],
  baseQuery: fetchBaseQuery({
    baseUrl: `${import.meta.env.VITE_API_BASE_URL ?? window.location.origin}/v1`,
  }),
  endpoints: (builder) => ({
    getConfig: builder.query<IConfigResponse, void>({
      query: () => "server/config",
      transformResponse: (response: { config: IConfigResponse }) =>
        response.config,
      providesTags: [{ type: "Config", id: "LIST" }],
    }),
    getChannels: builder.query<IChannelResponse[], void>({
      query: () => "chat",
      transformResponse: (response: { channels: IChannelResponse[] }) =>
        response.channels,
      providesTags: [{ type: "Channels", id: "LIST" }],
    }),
    getChats: builder.query<IChatMessageResponse[], string>({
      query: (id) => `chat/${id}/messages`,
      transformResponse: (response: { messages: IChatMessageResponse[] }) =>
        response.messages,
      // transformResponse: (response: IChatResponse) => {
      //   const channels = Object.fromEntries(
      //     Object.entries(response.channels).map(([id, channel]) => [
      //       id,
      //       {
      //         ...channel,
      //         totalMessages: channel.messages.length,
      //         messages: Object.values(
      //           channel.messages.reduce(
      //             (acc, message) => ({
      //               ...acc,
      //               [message.id]: {
      //                 ...message,
      //                 sender: (acc[message.id]?.sender ?? []).concat(
      //                   message.sender
      //                 ),
      //               },
      //             }),
      //             {} as Record<
      //               string,
      //               IChatResponse["channels"]["0"]["messages"][0]
      //             >
      //           )
      //         ),
      //       },
      //     ])
      //   );
      //   return { channels };
      // },
      providesTags: [{ type: "Chat", id: "LIST" }],
    }),
    getNodes: builder.query<
      INodesResponse,
      void | { status?: "online"; days?: number }
    >({
      query: (args) => ({
        url: "nodes",
        params: args ?? {},
      }),
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
    getNode: builder.query<INode, string>({
      query: (id) => `nodes/${id}`,
      transformResponse: ({ node }: { node: INode }) => ({
        ...node,
        position: node.position
          ? {
              ...node.position,
              latitude: node.position.latitude_i / 1e7,
              longitude: node.position.longitude_i / 1e7,
            }
          : undefined,
      }),
      providesTags: (_r, _e, id) => [{ type: "Node", id }],
    }),
    getStats: builder.query<IStatsResponse, void>({
      query: () => "stats",
      transformResponse: (response: { stats: IStatsResponse }) =>
        response.stats,
      providesTags: [{ type: "Stats", id: "LIST" }],
    }),
    getTelemetry: builder.query<ITelemetryResponse[], void>({
      query: () => "telemetry",
      providesTags: [{ type: "Telemetry", id: "LIST" }],
    }),
    getTraceroutes: builder.query<ITraceroutesResponse[], void>({
      query: () => "traceroutes",
      providesTags: [{ type: "Traceroutes", id: "LIST" }],
    }),
    getMessages: builder.query<IMessagesResponse[], void>({
      query: () => "messages",
      providesTags: [{ type: "Messages", id: "LIST" }],
    }),
    getMqttMessages: builder.query<IMqttMessagesResponse[], void>({
      query: () => "mqtt_messages",
      providesTags: [{ type: "MqttMessages", id: "LIST" }],
    }),
    getReverseGeocode: builder.query<
      {
        address?: {
          town?: string;
          city?: string;
          county?: string;
          state?: string;
          country?: string;
        };
      },
      { lon: string; lat: string }
    >({
      query: ({ lon, lat }) =>
        `https://nominatim.openstreetmap.org/reverse?format=json&lon=${lon}&lat=${lat}`,
    }),
  }),
});

export const {
  useGetChatsQuery,
  useGetChannelsQuery,
  useGetNodesQuery,
  useGetNodeQuery,
  useGetConfigQuery,
  useGetStatsQuery,
  useGetTelemetryQuery,
  useGetTraceroutesQuery,
  useGetMessagesQuery,
  useGetMqttMessagesQuery,
  useGetReverseGeocodeQuery,
} = apiSlice;
