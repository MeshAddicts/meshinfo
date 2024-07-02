import { useGetChatsQuery, useGetNodesQuery } from "../slices/apiSlice";

export const Chat = () => {
  const { data: chat } = useGetChatsQuery();
  const { data: nodes = {} } = useGetNodesQuery();

  return (
    <>
      <h1>Chat</h1>
      <p>
        There are <b>{chat?.channels[0].messages.length}</b> messages on channel
        0 that have been heard by the mesh by <b>KE-R</b> (!4355f528).
      </p>
      <p>Last updated: {new Date().toString()}</p>

      <h2>Channel 0</h2>
      <table border={1} cellPadding={4}>
        <tbody>
          <tr>
            <th>Time</th>
            <th>From</th>
            <th>Via</th>
            <th>Hops</th>
            <th>To</th>
            <th style={{ width: "65%" }}>Message</th>
          </tr>
          {chat?.channels[0].messages.map((message) => (
            <tr>
              <td>{message.timestamp}</td>
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
                <span
                  title={`${message.sender}/${
                    nodes[message.sender]?.longname ?? "Unknown"
                  }`}
                >
                  {nodes[message.sender].shortname ?? "UNK"}
                </span>
              </td>
              <td align="center">{message.hops_away}</td>
              <td>
                <span
                  title={`${message.to}/${
                    nodes[message.to]?.longname ?? "Unknown"
                  }`}
                >
                  {nodes[message.to].shortname ?? "UNK"}
                </span>
              </td>
              <td>{message.text}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
};
