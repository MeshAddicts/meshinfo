import { HeardBy } from "../components/HeardBy";
import { useGetMessagesQuery } from "../slices/apiSlice";

export const MeshLog = () => {
  const { data: messages } = useGetMessagesQuery();

  if (!messages) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <h5 className="mb-2 text-gray-500">Mesh Messages</h5>
      <h1 className="mb-2 text-xl">Mesh Messages</h1>
      <p className="mb-2">
        All messages from the mesh as <HeardBy />. Only the messages received
        since this server was last restarted are shown.
      </p>

      <table className="w-full max-w-full table-auto border-collapse border border-gray-500 bg-gray-50">
        <thead>
          <tr>
            <th className="border border-gray-500 bg-gray-400">Timestamp</th>
            <th className="border border-gray-500 bg-gray-400">Message</th>
          </tr>
        </thead>
        <tbody>
          {messages
            .slice()
            .reverse()
            .map((message, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <tr key={`messages-${index}`}>
                <td className="p-1 border border-gray-400">
                  {message.timestamp
                    ? new Date(message.timestamp * 1000).toLocaleString()
                    : ""}
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
