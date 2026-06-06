import { createApi, fetchBaseQuery } from "@reduxjs/toolkit/query/react";

import { env } from "../env";
import {
  IChatResponse,
  IMessagesResponse,
  IMqttMessagesResponse,
  INodesResponse,
  IStatsResponse,
  ITelemetryResponse,
  ITraceroutesResponse,
} from "../types";
import { IConfigResponse } from "../types/config";
import { transformNode } from "./nodeTransform";

/** A parsed packet from the mqtt_messages archive. Loosely typed — the payload
 *  shape varies by packet type. `mqtt_row_id` is the stable DB id (deeplinks). */
export type IPacketMessage = Record<string, unknown> & {
  mqtt_row_id?: number;
  topic?: string;
  timestamp?: number;
  type?: string;
  from?: string;
};

/** One keyset-paginated page from /v1/packets. */
export interface IPacketPage {
  messages: IPacketMessage[];
  next_cursor: string | null;
}

/** Filters for the packet archive query (the cursor is handled separately). */
export interface IPacketsArg {
  q?: string;
  topic?: string;
  range?: string;
  start?: number;
  end?: number;
  limit?: number;
}

export const apiSlice = createApi({
  reducerPath: "api",
  tagTypes: [
    "Chat",
    "Node",
    "Config",
    "Stats",
    "Telemetry",
    "Traceroutes",
    "Messages",
    "MqttMessages",
  ],
  baseQuery: fetchBaseQuery({
    baseUrl: `${env.API_BASE_URL ?? window.location.origin}/v1`,
  }),
  endpoints: (builder) => ({
    getConfig: builder.query<IConfigResponse, void>({
      query: () => "server/config",
      transformResponse: (response: { config: IConfigResponse }) =>
        response.config,
      providesTags: [{ type: "Config", id: "LIST" }],
    }),
    getChats: builder.query<
        IChatResponse,
        { channel?: string; range?: string } | void
    >({
        query: (params) => {
        const sp = new URLSearchParams();
        if (params && params.channel) sp.set("channel", params.channel);
        if (params && params.range) sp.set("range", params.range);
        const qs = sp.toString();
        return qs ? `chat?${qs}` : "chat";
        },
        transformResponse: (response: IChatResponse) => {
        const channels = Object.fromEntries(
            Object.entries(response.channels).map(([id, channel]) => [
            id,
            {
                ...channel,
                // Use backend-provided totalMessages if available,
                // fall back to response array length for backward compat
                totalMessages:
                (channel as any).totalMessages ?? channel.messages.length,
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
                ).sort((a, b) => b.timestamp - a.timestamp),
            },
            ])
        );
        return { channels };
        },
        providesTags: [{ type: "Chat", id: "LIST" }],
    }),
    getNodes: builder.query<INodesResponse, void | { status: "online" }>({
      query: () => "nodes",
      transformResponse: (response: INodesResponse) =>
        Object.fromEntries(
          Object.entries(response.nodes).map(([id, node]) => [
            id,
            transformNode(node),
          ])
        ),
      providesTags: [{ type: "Node", id: "LIST" }],
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
    getNodeTelemetry: builder.query<ITelemetryResponse[], string>({
      query: (nodeId) => `nodes/${nodeId}/telemetry`,
      transformResponse: (response: { telemetry: ITelemetryResponse[] }) => response.telemetry ?? [],
      providesTags: (_result, _err, id) => [{ type: "Telemetry", id }],
    }),
    getTraceroutes: builder.query<ITraceroutesResponse[], void>({
      query: () => "traceroutes",
      providesTags: [{ type: "Traceroutes", id: "LIST" }],
    }),
    getMessages: builder.query<
      IMessagesResponse[],
      { range?: string } | void
    >({
      query: (params) => {
        const sp = new URLSearchParams();
        if (params && params.range && params.range !== "all")
          sp.set("range", params.range);
        const qs = sp.toString();
        return qs ? `messages?${qs}` : "messages";
      },
      providesTags: [{ type: "Messages", id: "LIST" }],
    }),
    getMqttMessages: builder.query<
      IMqttMessagesResponse[],
      { range?: string } | void
    >({
      query: (params) => {
        const sp = new URLSearchParams();
        if (params && params.range && params.range !== "all")
          sp.set("range", params.range);
        const qs = sp.toString();
        return qs ? `mqtt_messages?${qs}` : "mqtt_messages";
      },
      providesTags: [{ type: "MqttMessages", id: "LIST" }],
    }),
    getNodePackets: builder.query<
      { packets: IMqttMessagesResponse[] },
      { nodeId: string; limit?: number }
    >({
      query: ({ nodeId, limit = 50 }) => `nodes/${nodeId}/packets?limit=${limit}`,
      providesTags: (_result, _error, { nodeId }) => [
        { type: "MqttMessages", id: nodeId },
      ],
    }),
    // Cursor-paginated packet archive — reaches the full mqtt_messages history.
    getPackets: builder.infiniteQuery<IPacketPage, IPacketsArg, string | undefined>({
      infiniteQueryOptions: {
        initialPageParam: undefined,
        getNextPageParam: (lastPage) => lastPage.next_cursor ?? undefined,
      },
      query: ({ queryArg, pageParam }) => {
        const sp = new URLSearchParams();
        if (queryArg.q) sp.set("q", queryArg.q);
        if (queryArg.topic) sp.set("topic", queryArg.topic);
        if (queryArg.range) sp.set("range", queryArg.range);
        if (queryArg.start) sp.set("start", String(queryArg.start));
        if (queryArg.end) sp.set("end", String(queryArg.end));
        sp.set("limit", String(queryArg.limit ?? 200));
        if (pageParam) sp.set("before", pageParam);
        return `packets?${sp.toString()}`;
      },
      providesTags: [{ type: "MqttMessages", id: "PACKETS" }],
    }),
    // Single packet by mqtt_row_id — backs per-packet deeplinks.
    getPacket: builder.query<{ packet: IPacketMessage }, number>({
      query: (id) => `packets/${id}`,
    }),
  }),
});

export const {
  useGetChatsQuery,
  useGetNodesQuery,
  useGetConfigQuery,
  useGetStatsQuery,
  useGetTelemetryQuery,
  useGetNodeTelemetryQuery,
  useGetTraceroutesQuery,
  useGetMessagesQuery,
  useGetMqttMessagesQuery,
  useGetNodePacketsQuery,
  useGetPacketsInfiniteQuery,
  useGetPacketQuery,
} = apiSlice;
