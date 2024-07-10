import { formatDuration, intervalToDuration } from "date-fns";
import { useMemo } from "react";

import { useGetNodesQuery } from "../slices/apiSlice";
import { HardwareModel } from "../types";
import { getDistanceBetweenTwoPoints } from "../utils/getDistanceBetweenPoints";

export const Nodes = () => {
  const { data: nodes } = useGetNodesQuery();
  const { data: activeNodes } = useGetNodesQuery();

  const serverNode = useMemo(() => nodes && nodes["4355f528"], [nodes]);

  if (!nodes || !activeNodes) return <div>Loading...</div>;

  return (
    <div className="pl-8">
      <h1>Nodes</h1>
      <p>
        There are <b>{Object.keys(activeNodes).length}</b> active out of a total
        of <b>{Object.entries(nodes).length}</b> seen nodes that have been heard
        by the mesh by <b>KE-R</b> (!4355f528).
      </p>
      <p>Last updated: {new Date().toString()}</p>
      <table border={1} cellSpacing={2} cellPadding={4}>
        <thead>
          <tr style={{ backgroundColor: "lightgray" }}>
            <th>ID</th>
            <th colSpan={2}>Name</th>
            <th>Hardware</th>
            <th colSpan={4}>Last Position</th>
            <th>Neighbors</th>
            <th colSpan={3}>Telemetry</th>
            <th colSpan={2}>Seen</th>
          </tr>
          <tr style={{ backgroundColor: "lightgray" }}>
            <th />
            <th>Short</th>
            <th>Long</th>
            <th />
            <th>Altitude</th>
            <th>Latitude</th>
            <th>Longitude</th>
            <th>DX</th>
            <th>Count</th>
            <th>Battery</th>
            <th>Voltage</th>
            <th>Chan Util</th>
            <th>Last</th>
            <th>Since</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(activeNodes).map(([id, node]) => (
            <tr key={id}>
              <td>
                {id ? (
                  <a href={`node_${id.replace("!", "")}.html`}>
                    {id.replace("!", "")}
                  </a>
                ) : (
                  id
                )}
              </td>
              <td style={{ color: node.shortname === "UNK" ? "#777" : "#000" }}>
                {id ? (
                  <a href={`node_${id.replace("!", "")}.html`}>
                    {node.shortname}
                  </a>
                ) : (
                  node.shortname
                )}
              </td>
              <td style={{ color: node.shortname === "UNK" ? "#777" : "#000" }}>
                {node.longname}
              </td>
              <td>{node.hardware ? HardwareModel[node.hardware] : ""}</td>
              {node.position ? (
                <>
                  <td>{node.position.altitude || ""}</td>
                  <td>{node.position.latitude}</td>
                  <td>{node.position.longitude}</td>
                  <td align="right">
                    {serverNode?.position &&
                      getDistanceBetweenTwoPoints(
                        [node.position.longitude, node.position.latitude],
                        [
                          serverNode?.position?.longitude,
                          serverNode?.position?.latitude,
                        ]
                      )}{" "}
                    km
                  </td>
                </>
              ) : (
                <>
                  <td />
                  <td />
                  <td />
                  <td />
                </>
              )}
              <td align="center">
                {node.neighborinfo ? node.neighborinfo.neighbors_count : ""}
              </td>
              {node.telemetry ? (
                <>
                  <td align="center">
                    {node.telemetry.battery_level
                      ? `${node.telemetry.battery_level}%`
                      : ""}
                  </td>
                  <td align="center">
                    {node.telemetry.voltage
                      ? `${node.telemetry.voltage.toFixed(2)}V`
                      : ""}
                  </td>
                  <td align="center">
                    {node.telemetry.channel_utilization
                      ? `${node.telemetry.channel_utilization.toFixed(1)}%`
                      : ""}
                  </td>
                </>
              ) : (
                <>
                  <td />
                  <td />
                  <td />
                </>
              )}
              <td>{node.last_seen}</td>
              <td align="right">
                {formatDuration(
                  intervalToDuration({
                    start: new Date(node.last_seen),
                    end: new Date(),
                  }),
                  {
                    format: ["seconds"],
                  }
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <br />
      <br />
      <a href="nodes.json">Download JSON</a>
    </div>
  );
};
