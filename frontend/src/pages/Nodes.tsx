import { formatDuration, intervalToDuration } from "date-fns";
import { useMemo } from "react";
import { Link } from "react-router-dom";

import { HardwareImg } from "../components/HardwareImg";
import { HeardBy } from "../components/HeardBy";
import { Role } from "../components/Role";
import { useGetNodesQuery } from "../slices/apiSlice";
import { HardwareModel } from "../types";
import { getDistanceBetweenTwoPoints } from "../utils/getDistanceBetweenPoints";

export const Nodes = () => {
  const { data: nodes } = useGetNodesQuery();

  const activeNodes = useMemo(
    () => Object.values(nodes ?? [])?.filter((n) => n.active),
    [nodes]
  );

  const serverNode = useMemo(() => nodes && nodes["4355f528"], [nodes]);

  if (!nodes || !activeNodes) return <div>Loading...</div>;

  return (
    <div>
      <h5 className="mb-2 text-gray-500">Nodes</h5>
      <h1 className="mb-2 text-xl">Nodes</h1>

      <p>
        There are <b>{Object.keys(activeNodes).length}</b> active out of a total
        of <b>{Object.entries(nodes).length}</b> seen nodes <HeardBy />
      </p>
      <p>Last updated: {new Date().toString()}</p>
      <table className="w-full max-w-full table-auto border-collapse border border-gray-500 bg-gray-50">
        <thead>
          <tr>
            <th className="border border-gray-500 bg-gray-400" colSpan={2}>
              ID
            </th>
            <th className="border border-gray-500 bg-gray-400" colSpan={2}>
              Name
            </th>
            <th className="hidden sm:table-cell border border-gray-500 bg-gray-400">
              HW
            </th>
            <th className="border border-gray-500 bg-gray-400">Role</th>
            <th
              className="hidden xl:table-cell border border-gray-500 bg-gray-400"
              colSpan={4}
            >
              Last Position
            </th>
            <th className="hidden md:table-cell border border-gray-500 bg-gray-400">
              Neighbors
            </th>
            <th
              className="hidden 2xl:table-cell border border-gray-500 bg-gray-400"
              colSpan={4}
            >
              Telemetry
            </th>
            <th className="border border-gray-500 bg-gray-400" colSpan={1}>
              Seen
            </th>
          </tr>
          <tr>
            <th className="w-8 min-w-8 max-w-8 h-8 min-h-8 max-h-8 border border-gray-500 bg-gray-400" />
            <th className="border border-gray-500 bg-gray-400" />
            <th className="border border-gray-500 bg-gray-400">Short</th>
            <th className="border border-gray-500 bg-gray-400">Long</th>
            <th className="hidden sm:table-cell border border-gray-500 bg-gray-400" />
            <th className="border border-gray-500 bg-gray-400" />
            <th className="hidden xl:table-cell border border-gray-500 bg-gray-400">
              Altitude
            </th>
            <th className="hidden xl:table-cell border border-gray-500 bg-gray-400">
              Latitude
            </th>
            <th className="hidden xl:table-cell border border-gray-500 bg-gray-400">
              Longitude
            </th>
            <th className="hidden xl:table-cell border border-gray-500 bg-gray-400">
              DX
            </th>
            <th className="hidden md:table-cell border border-gray-500 bg-gray-400">
              Count
            </th>
            <th className="hidden 2xl:table-cell border border-gray-500 bg-gray-400">
              <img
                src="/next/images/icons/battery.svg"
                className="w-4 h-4 inline-block"
                alt="Battery"
                title="Battery"
              />
            </th>
            <th className="hidden 2xl:table-cell border border-gray-500 bg-gray-400">
              <img
                src="/next/images/icons/voltage.svg"
                className="w-4 h-4 inline-block"
                alt="Voltage"
                title="Voltage"
              />
            </th>
            <th className="hidden 2xl:table-cell border border-gray-500 bg-gray-400">
              <img
                src="/next/images/icons/up.svg"
                alt="Air Util TX"
                className="w-4 h-4 inline-block"
                title="Air Util TX"
              />
            </th>
            <th className="hidden 2xl:table-cell border border-gray-500 bg-gray-400">
              <img
                src="/next/images/icons/down.svg"
                className="w-4 h-4 inline-block"
                alt="Channel Util"
                title="Channel Util"
              />
            </th>
            <th className="border border-gray-500 bg-gray-400">Since</th>
          </tr>
        </thead>
        <tbody>
          {activeNodes.map(({ id, ...node }) => (
            <tr key={id}>
              <td
                className="w-8 min-w-8 max-w-8 h-8 min-h-8 max-h-8 p-0 box-border border border-gray-400"
                align="center"
                valign="middle"
              >
                <img
                  src={`https://api.dicebear.com/9.x/bottts-neutral/svg?seed=$${id}`}
                  alt="Avatar"
                  className="w-8 h-8 object-cover"
                />
              </td>
              <td className="p-1 border border-gray-400">
                {id ? (
                  <Link to={id.replace("!", "")}>{id.replace("!", "")}</Link>
                ) : (
                  id
                )}
              </td>
              <td
                className="p-1 border border-gray-400"
                style={{ color: node.shortname === "UNK" ? "#777" : "#000" }}
              >
                {id ? (
                  <Link to={id.replace("!", "")}>{node.shortname}</Link>
                ) : (
                  node.shortname
                )}
              </td>
              <td
                className="p-1 border border-gray-400 text-nowrap truncate"
                style={{ color: node.shortname === "UNK" ? "#777" : "#000" }}
              >
                {node.longname}
              </td>
              <td className="hidden sm:table-cell w-8 min-w-8 max-w-8 h-8 min-h-8 max-h-8 p-0 box-border border-gray-400 text-center text-nowrap truncate">
                {node.hardware && HardwareModel[node.hardware] ? (
                  <HardwareImg model={node.hardware} />
                ) : (
                  ""
                )}
              </td>
              <td
                className="p-1 border border-gray-400 text-nowrap"
                align="center"
              >
                {node.role && <Role role={node.role} />}
              </td>
              {node.position && Object.keys(node.position).length ? (
                <>
                  <td className="hidden xl:table-cell p-1 border border-gray-400">
                    {node.position.altitude || ""}
                  </td>
                  <td className="hidden xl:table-cell p-1 border border-gray-400">
                    {node.position.latitude || ""}
                  </td>
                  <td className="hidden xl:table-cell p-1 border border-gray-400">
                    {node.position.longitude || ""}
                  </td>
                  <td
                    className="hidden xl:table-cell p-1 border border-gray-400 text-nowrap"
                    align="right"
                  >
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
                  <td className="hidden xl:table-cell p-1 border border-gray-400" />
                  <td className="hidden xl:table-cell p-1 border border-gray-400" />
                  <td className="hidden xl:table-cell p-1 border border-gray-400" />
                  <td className="hidden xl:table-cell p-1 border border-gray-400" />
                </>
              )}
              <td
                align="center"
                className="hidden md:table-cell p-1 border border-gray-400"
              >
                {node.neighborinfo ? node.neighborinfo.neighbors_count : ""}
              </td>
              {node.telemetry ? (
                <>
                  <td
                    align="center"
                    className="hidden md:table-cell p-1 border border-gray-400"
                  >
                    {node.telemetry.battery_level
                      ? `${node.telemetry.battery_level}%`
                      : ""}
                  </td>
                  <td
                    align="center"
                    className="hidden md:table-cell p-1 border border-gray-400"
                  >
                    {node.telemetry.voltage
                      ? `${node.telemetry.voltage.toFixed(2)}V`
                      : ""}
                  </td>
                  <td
                    align="center"
                    className="hidden md:table-cell p-1 border border-gray-400"
                  >
                    {node.telemetry.air_utilization_tx
                      ? `${node.telemetry.air_utilization_tx.toFixed(1)}%`
                      : ""}
                  </td>
                  <td
                    align="center"
                    className="hidden md:table-cell p-1 border border-gray-400"
                  >
                    {node.telemetry.channel_utilization
                      ? `${node.telemetry.channel_utilization.toFixed(1)}%`
                      : ""}
                  </td>
                </>
              ) : (
                <>
                  <td className="hidden 2xl:table-cell p-1 border border-gray-400" />
                  <td className="hidden 2xl:table-cell p-1 border border-gray-400" />
                  <td className="hidden 2xl:table-cell p-1 border border-gray-400" />
                  <td className="hidden 2xl:table-cell p-1 border border-gray-400" />
                </>
              )}
              <td
                className="p-1 border border-gray-400 text-nowrap"
                align="right"
              >
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
