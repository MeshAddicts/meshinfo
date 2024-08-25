import { format } from "date-fns";
import { useEffect, useMemo, useState } from "react";

import { HeardBy } from "../components/HeardBy";
import {
  useGetChatsQuery,
  useGetConfigQuery,
  useGetNodesQuery,
} from "../slices/apiSlice";
import { INode } from "../types";
import { getDistanceBetweenTwoPoints } from "../utils/getDistanceBetweenPoints";

// eslint-disable-next-line react/require-default-props
const Distance = ({ node1, node2 }: { node1?: INode; node2?: INode }) => {
  if (node1 && node2 && node1.position && node2.position) {
    return (
      <>
        {getDistanceBetweenTwoPoints(
          [node1?.position?.longitude, node1?.position?.latitude],
          [node2?.position?.longitude, node2?.position?.latitude]
        )}
      </>
    );
  }

  return <span />;
};

export const Chat = () => {
  const { data: chat } = useGetChatsQuery();
  const { data: nodes = {} } = useGetNodesQuery();
  const { data: config } = useGetConfigQuery();

  const channels = useMemo(
    () =>
      Object.entries(chat?.channels ?? {}).filter(([id]) =>
        config?.broker.channels.display.includes(id)
      ),
    [chat?.channels, config?.broker.channels.display]
  );

  const [selectedChannel, setSelectedChannel] = useState<string>();

  useEffect(() => {
    if (Object.keys(channels).length > 0 && !selectedChannel) {
      setSelectedChannel(Object.keys(channels)[0]);
    }

    // only on channels change, not on selectedChannel
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels]);

  return (
    <div className="pl-8">
      <h1>Chat</h1>
      {channels.map(([id, channel]) => (
        <p className="mb-2" key={id}>
          There are <b>{channel.totalMessages}</b> messages on channel {id}
          <HeardBy />
        </p>
      ))}
      <p>Last updated: {new Date().toString()}</p>

      <div>
        <div className="sm:hidden">
          {/* eslint-disable-next-line jsx-a11y/label-has-associated-control */}
          <label htmlFor="tabs" className="sr-only">
            Select a tab
          </label>
          <select
            id="tabs"
            name="tabs"
            value={selectedChannel}
            className="block w-full rounded-md border-gray-300 py-2 pl-3 pr-10 text-base focus:border-indigo-500 focus:outline-none focus:ring-indigo-500 sm:text-sm"
          >
            {channels.map(([id]) => (
              <option>Channel {id}</option>
            ))}
          </select>
        </div>
        <div className="hidden sm:block">
          <div className="border-b border-gray-200">
            <nav className="-mb-px flex space-x-8" aria-label="Tabs">
              {channels.map(([id, channel]) => (
                // eslint-disable-next-line jsx-a11y/click-events-have-key-events
                <div
                  className={`flex whitespace-nowrap border-solid border-0 border-b-2 px-1 py-4 text-sm font-medium cursor-pointer ${
                    selectedChannel === id
                      ? "border-indigo-500 text-indigo-600 hover:border-indigo-800 hover:text-indigo-800"
                      : "border-transparent text-gray-500 hover:border-gray-200 hover:text-gray-700 "
                  }`}
                  onClick={() => setSelectedChannel(id)}
                  role="button"
                  tabIndex={0}
                >
                  Channel {id}
                  <span className="ml-3 hidden rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-900 md:inline-block">
                    {channel.totalMessages}
                  </span>
                </div>
              ))}
            </nav>
          </div>
        </div>
      </div>

      <h2>Channel {selectedChannel}</h2>
      <table border={1} cellPadding={4}>
        <tbody>
          <tr>
            <th>Time</th>
            <th>From</th>
            <th>Via</th>
            <th>To</th>
            <th>Hops</th>
            <th>DX</th>
            <th style={{ width: "60%" }}>Message</th>
          </tr>
          {selectedChannel
            ? chat?.channels[selectedChannel].messages.map((message, i) => (
                // eslint-disable-next-line react/no-array-index-key
                <tr key={`chat-message-${message.id}-${i}`}>
                  <td>
                    {format(
                      new Date(message.timestamp * 1000),
                      "yyyy-MM-dd HH:MM:SS xx"
                    )}
                  </td>
                  <td>
                    {/* {{ message.from + " / " + nodes[message.from].longname if message.from in nodes else (message.from + ' / Unknown') }} */}
                    <span
                      title={`${message.from}/${
                        nodes[message.from]?.longname ?? "Unknown"
                      }`}
                    >
                      {nodes[message.from]?.shortname ?? "UNK"}
                    </span>
                  </td>
                  <td>
                    {message.sender.map((sender, x) => (
                      <span
                        title={`${sender}/${nodes[sender]?.longname ?? "Unknown"}`}
                      >
                        {nodes[sender]?.shortname ?? "UNK"}
                        {x < message.sender.length - 1 ? "/" : ""}
                      </span>
                    ))}
                  </td>
                  <td>
                    <span
                      title={`${message.to}/${
                        nodes[message.to]?.longname ?? "Unknown"
                      }`}
                    >
                      {nodes[message.to]?.shortname ?? "UNK"}
                    </span>
                  </td>
                  <td align="center">{message.hops_away}</td>
                  {/* eslint-disable-next-line jsx-a11y/control-has-associated-label */}
                  <td align="right">
                    <Distance
                      node1={nodes[message.from]}
                      node2={nodes[message.to]}
                    />
                  </td>
                  <td>{message.text}</td>
                </tr>
              ))
            : ""}
        </tbody>
      </table>
    </div>
  );
};
