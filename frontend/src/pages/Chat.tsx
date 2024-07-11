import { format } from "date-fns";

import { useGetChatsQuery, useGetNodesQuery } from "../slices/apiSlice";
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

  return (
    <div className="pl-8">
      <h1>Chat</h1>
      <p>
        There are <b>{chat?.channels[0].totalMessages}</b> messages on channel 0
        that have been heard by the mesh by <b>KE-R</b> (!4355f528).
      </p>
      <p>Last updated: {new Date().toString()}</p>

      <h2>Channel 0</h2>
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
          {chat?.channels[0].messages.map((message, i) => (
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
              <td align="right">
                <Distance
                  node1={nodes[message.from]}
                  node2={nodes[message.to]}
                />
              </td>
              <td>{message.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
