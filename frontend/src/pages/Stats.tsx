import { HeardBy } from "../components/HeardBy";
import { useGetStatsQuery } from "../slices/apiSlice";

export const Stats = () => {
  const { data: stats } = useGetStatsQuery();

  if (!stats) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <h5 className="mb-2 text-gray-500">Stats</h5>
      <h1 className="mb-2 text-xl">Stats</h1>
      <p className="mb-2">
        Some revelations based on messages <HeardBy />
      </p>

      <h3 className="text-lg">Current</h3>
      <div className="mb-4">
        <h3>Active Nodes</h3>
        <div>
          <div>{stats.active_nodes}</div>
        </div>
      </div>

      <div className="mb-4">
        <h3 className="text-lg">Persisted</h3>
        <div className="mb-2">
          <h3>Known Nodes</h3>
          <div>
            <div>{stats.total_nodes}</div>
          </div>
        </div>
        <div className="mb-2">
          <h3>Chat Messages in Channel 0</h3>
          <div>
            <div>{stats.total_chat}</div>
          </div>
        </div>
        <div className="mb-2">
          <h3>Telemetry</h3>
          <div>
            <div>{stats.total_telemetry}</div>
          </div>
        </div>
        <div className="mb-2">
          <h3>Traceroutes</h3>
          <div>
            <div>{stats.total_traceroutes}</div>
          </div>
        </div>
      </div>

      <div className="mb-4">
        <h3 className="text-lg">Since Last Restart</h3>
        <div className="mb-2">
          <h3>Messages (Session Total)</h3>
          <div>
            <div>{stats.total_messages}</div>
          </div>
        </div>
        <div className="mb-2">
          <h3>Messages (Session MQTT)</h3>
          <div>
            <div>{stats.total_mqtt_messages}</div>
          </div>
        </div>
      </div>
    </div>
  );
};
