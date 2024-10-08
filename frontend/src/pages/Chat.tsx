import { format } from "date-fns-tz";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { HeardBy } from "../components/HeardBy";
import {
  useGetChatsQuery,
  useGetConfigQuery,
  useGetNodesQuery,
} from "../slices/apiSlice";
import { calculateDistanceBetweenNodes } from "../utils/getDistanceBetweenTwoNodes";

export const Chat = () => {
  const { data: chat } = useGetChatsQuery();
  const { data: nodes = {} } = useGetNodesQuery();
  const { data: config } = useGetConfigQuery();

  const channels = useMemo(
    () =>
      Object.entries(chat?.channels ?? {}).filter(([id]) =>
        config?.broker?.channels?.display?.includes(id)
      ),
    [chat?.channels, config?.broker?.channels?.display]
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
    <div className="">
      <h5 className="mb-2 text-gray-500 dark:text-gray-400">Chat</h5>
      <h1 className="mb-2 text-xl">Chat</h1>

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
              <option key={`channel-${id}`}>Channel {id}</option>
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
                  key={`channel-selector-${id}`}
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
      <table className="w-full max-w-full table-auto border-collapse border border-gray-500 bg-gray-50 dark:bg-gray-800">
        <thead>
          <tr>
            <th className="w-48 max-w-48 border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Time
            </th>
            <th className="w-12 max-w-12 border border-gray-500 bg-gray-400 dark:bg-gray-900">
              From
            </th>
            <th className=" border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Via
            </th>
            <th className="w-12 max-w-12 border border-gray-500 bg-gray-400 dark:bg-gray-900">
              To
            </th>
            <th className="w-12 max-w-12 border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Hops
            </th>
            <th className="w-20 max-w-20 border border-gray-500 bg-gray-400 dark:bg-gray-900">
              DX
            </th>
            <th className="p-1 text-wrap border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Message
            </th>
          </tr>
        </thead>
        <tbody>
          {selectedChannel
            ? chat?.channels[selectedChannel].messages.map((message, i) => {
                const nodeFrom = nodes[message.from] || null;
                const senders = message.sender
                  .map((s) => nodes[s])
                  .filter(Boolean);
                const nodeTo = nodes[message.to] || null;
                const distanceFromSender =
                  nodeFrom && senders.length
                    ? senders
                        .filter((s) => s.position)
                        .map((s) => calculateDistanceBetweenNodes(nodeFrom, s))
                        .filter(Boolean)
                    : null;

                return (
                  <tr
                    // eslint-disable-next-line react/no-array-index-key
                    key={`chat-message-${message.id}-${i}`}
                  >
                    <td className="p-1 border border-gray-400 text-nowrap">
                      {format(
                        new Date(message.timestamp * 1000),
                        "yyyy-MM-dd HH:MM:SS xx",
                        { timeZone: config?.server?.timezone }
                      )}
                    </td>
                    <td className="p-1 text-center border border-gray-400">
                      <Link
                        to={`/nodes/${nodeFrom?.id}`}
                        className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
                        title={
                          message.from in nodes
                            ? `${message.from} / ${nodes[message.from].longname}`
                            : `${message.from} / Unknown`
                        }
                      >
                        {nodes[message.from]
                          ? nodes[message.from].shortname
                          : "UNK"}
                      </Link>
                    </td>
                    <td className="p-1 text-center border border-gray-400">
                      {senders.length ? (
                        senders.map((s, idx) => (
                          <Link
                            to={`/nodes/${s.id}`}
                            title={`${message.sender} / ${s.longname}`}
                            className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
                          >
                            {s.shortname ?? "UNK"}
                            {idx < senders.length - 1 ? ", " : ""}
                          </Link>
                        ))
                      ) : (
                        <span
                          className="text-gray-500"
                          title={`${message.sender}`}
                        >
                          UNK
                        </span>
                      )}
                    </td>
                    <td className="p-1 text-center border border-gray-400">
                      {nodeTo && nodeTo.id !== "ffffffff" ? (
                        <Link
                          to={`/nodes/${nodeTo.id}`}
                          title={
                            message.to in nodes
                              ? `${message.to} / ${nodes[message.to].longname}`
                              : `${message.to} / Unknown`
                          }
                          className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
                        >
                          {nodes[message.to]
                            ? nodes[message.to].shortname
                            : "UNK"}
                        </Link>
                      ) : (
                        <span className="text-gray-500">ALL</span>
                      )}
                    </td>
                    <td className="p-1 border border-gray-400" align="center">
                      {message.hops_away}
                    </td>
                    <td
                      className="p-1 text-nowrap border border-gray-400"
                      align="right"
                    >
                      {distanceFromSender?.length
                        ? distanceFromSender.map((d) => `${d} km`).join(", ")
                        : ""}
                    </td>
                    <td className="p-1 text-wrap border border-gray-400">
                      {message.text}
                    </td>
                  </tr>
                );
              })
            : ""}
        </tbody>
      </table>
    </div>
  );
};
