import { HeardBy } from "../components/HeardBy";
import { useGetMqttMessagesQuery } from "../slices/apiSlice";

export const MqttLog = () => {
  const { data: messages } = useGetMqttMessagesQuery();

  if (!messages) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <h5 className="mb-2 text-gray-500">MQTT Messages</h5>
      <h1 className="mb-2 text-xl">MQTT Messages</h1>
      <p className="mb-2">
        All messages received by MQTT from the mesh as <HeardBy />. If multiple
        nodes are feeding this MQTT server, the messages will be from all of
        them. Only the messages received since this server was last restarted
        are shown.
      </p>

      <table className="w-full max-w-full table-auto border-collapse border border-gray-500 bg-gray-50 dark:bg-gray-300">
        <thead>
          <tr>
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900 ">
              Timestamp
            </th>
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Topic
            </th>
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Message
            </th>
          </tr>
        </thead>
        <tbody>
          {messages
            .slice()
            .reverse()
            .map((message, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <tr key={`mqtt-message-${index}`}>
                <td className="p-1 border border-gray-400 text-nowrap">
                  {message.timestamp
                    ? new Date(message.timestamp * 1000).toLocaleString()
                    : ""}
                </td>
                <td className="p-1 border border-gray-400 text-nowrap">
                  {message.topic}
                </td>
                <td className="p-1 border border-gray-400">
                  {JSON.stringify(message)}
                </td>
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
};
