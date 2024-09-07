import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";

import { Avatar } from "../components/Avatar";
import { HardwareImg } from "../components/HardwareImg";
import { useGetConfigQuery, useGetNodesQuery } from "../slices/apiSlice";
import {
  convertNodeIdFromHexToInt,
  convertNodeIdFromIntToHex,
} from "../utils/convertNodeId";
import { calculateDistanceBetweenNodes } from "../utils/getDistanceBetweenTwoNodes";
import { NodeMap } from "./NodeMap";

export const Node = () => {
  const { id } = useParams<{ id: string }>();
  const { data: nodes } = useGetNodesQuery();
  const { data: config } = useGetConfigQuery();

  const node = useMemo(() => (nodes ?? {})[id!], [nodes, id]);

  if (!node || !nodes) {
    return <div>Loading...</div>;
  }

  return (
    <>
      <h5 className="mb-4 text-gray-500">
        <Link to="/nodes">Nodes</Link> &gt; {node.shortname}
      </h5>

      <div className="mb-4 flex flex-row">
        <div className="mr-2">
          <Avatar id={node.id} size={16} />
        </div>
        <div>
          <h1 className="mb-2 text-xl">{`${node.shortname} - ${node.longname}`}</h1>
          <div className="flex align-middle mb-4">
            {node.telemetry && (
              <>
                {node.telemetry.air_util_tx && (
                  <span className="mr-4 align-middle" title="Air Util TX">
                    <img
                      src={`${import.meta.env.BASE_URL}images/icons/up.svg`}
                      alt="Air Util TX"
                      className="w-4 h-4 inline-block align-middle"
                    />
                    {`${node.telemetry.air_util_tx.toFixed(1)}%`}
                  </span>
                )}
                {node.telemetry.channel_utilization && (
                  <span className="mr-4 align-middle" title="Channel Util">
                    <img
                      src={`${import.meta.env.BASE_URL}images/icons/down.svg`}
                      alt="Channel Util"
                      className="w-4 h-4 inline-block align-middle"
                    />
                    {`${node.telemetry.channel_utilization.toFixed(1)}%`}
                  </span>
                )}
                {node.telemetry.battery_level && (
                  <span className="mr-4 align-middle" title="Battery Level">
                    <img
                      src={`${import.meta.env.BASE_URL}images/icons/battery.svg`}
                      alt="Battery"
                      className="w-4 h-4 inline-block align-middle"
                    />
                    {`${Math.round(node.telemetry.battery_level)}%`}
                  </span>
                )}
                {node.telemetry.temperature && (
                  <span className="mr-4 align-middle" title="Temperature">
                    <img
                      src={`${import.meta.env.BASE_URL}images/icons/temperature.svg`}
                      alt="Temperature"
                      className="w-4 h-4 inline-block align-middle"
                    />
                    {`${node.telemetry.temperature.toFixed(1)}°C`}
                  </span>
                )}
                {node.telemetry.humidity && (
                  <span className="mr-4 align-middle" title="Humidity">
                    <img
                      src={`${import.meta.env.BASE_URL}images/icons/humidity.svg`}
                      alt="Humidity"
                      className="w-4 h-4 inline-block align-middle"
                    />
                    {`${node.telemetry.humidity}%`}
                  </span>
                )}
                {node.telemetry.voltage && (
                  <span className="mr-4 align-middle" title="Voltage">
                    <img
                      src={`${import.meta.env.BASE_URL}images/icons/voltage.svg`}
                      alt="Voltage"
                      className="w-4 h-4 inline-block align-middle"
                    />
                    {typeof node.telemetry.voltage === "number"
                      ? `${node.telemetry.voltage.toFixed(1)}V`
                      : node.telemetry.voltage}
                  </span>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-col-1 md:grid-flow-col md:auto-cols-max">
        <div className="w-auto sm:w-96 mb-4 md:mr-4">
          {node.position &&
            node.position.latitude_i &&
            node.position.longitude_i && (
              <div className="w-auto sm:w-96 mb-4 md:mr-4">
                <NodeMap node={node} />
              </div>
            )}

          <div>
            <h3 className="font-bold text-gray-600">Elsewhere</h3>
            <div>
              <a
                href={`https://meshview.armooo.net/packet_list/${convertNodeIdFromHexToInt(node.id)}`}
                target="_blank"
                rel="noreferrer"
              >
                Armooo&apos;s MeshView
              </a>
              <br />
              <a
                href={`https://app.bayme.sh/node/${node.id}`}
                target="_blank"
                rel="noreferrer"
              >
                Bay Mesh Explorer
              </a>
              <br />
              <a
                href={`https://meshtastic.liamcottle.net/?node_id=${convertNodeIdFromHexToInt(node.id)}`}
                target="_blank"
                rel="noreferrer"
              >
                Liam&apos;s Map
              </a>
              <br />
              <a
                href={`https://meshmap.net/#${convertNodeIdFromHexToInt(node.id)}`}
                target="_blank"
                rel="noreferrer"
              >
                MeshMap
              </a>
            </div>
          </div>
        </div>

        <div className="w-auto md:w-96">
          <div className="mb-4">
            <h3 className="mb-2 font-bold text-gray-600">Details</h3>
            <table className="table-auto min-w-full border border-gray-200 bg-gray-50">
              <tbody className="divide-y divide-dashed divide-gray-200">
                <tr>
                  <th className="p-1" align="left">
                    ID (hex)
                  </th>
                  <td className="p-1">{node.id}</td>
                </tr>
                <tr>
                  <th className="p-1" align="left">
                    ID (int)
                  </th>
                  <td className="p-1">
                    {node.id && convertNodeIdFromHexToInt(node.id)}
                  </td>
                </tr>
                <tr>
                  <th className="p-1" align="left">
                    Hardware
                  </th>
                  <td className="p-1">
                    {node.hardware ? (
                      <HardwareImg model={node.hardware} />
                    ) : (
                      "Unknown"
                    )}
                  </td>
                </tr>
                <tr>
                  <th className="p-1" align="left">
                    Role
                  </th>
                  <td className="p-1">
                    {node.role !== null
                      ? (() => {
                          switch (node.role) {
                            case 0:
                              return "Client";
                            case 1:
                              return "Client Mute";
                            case 2:
                              return "Router";
                            case 3:
                              return "Router Client";
                            case 4:
                              return "Repeater";
                            case 5:
                              return "Tracker";
                            case 6:
                              return "Sensor";
                            case 7:
                              return "ATAK";
                            case 8:
                              return "Client Hidden";
                            case 9:
                              return "Lost and Found";
                            case 10:
                              return "ATAK Tracker";
                            default:
                              return "Unknown";
                          }
                        })()
                      : "Unknown"}
                  </td>
                </tr>
                <tr>
                  <th className="p-1" align="left">
                    Position
                  </th>
                  <td className="p-1">
                    {node.position &&
                    node.position.latitude_i &&
                    node.position.longitude_i
                      ? `${node.position.longitude_i / 1e7}, ${node.position.latitude_i / 1e7}`
                      : "Unknown"}
                  </td>
                </tr>
                <tr>
                  <th className="p-1" align="left">
                    Location
                  </th>
                  <td className="p-1">
                    {node.position && node.position.geocoded
                      ? node.position.geocoded.display_name
                      : "Unknown"}
                  </td>
                </tr>
                <tr>
                  <th className="p-1" align="left">
                    Altitude
                  </th>
                  <td className="p-1">
                    {node.position && node.position.altitude
                      ? `${node.position.altitude} m`
                      : "Unknown"}
                  </td>
                </tr>
                <tr>
                  <th
                    className="p-1 text-nowrap whitespace-nowrap"
                    align="left"
                  >
                    Distance from{" "}
                    {nodes[config?.server?.node_id ?? ""].shortname}
                  </th>
                  <td className="p-1">
                    {calculateDistanceBetweenNodes(
                      nodes[config?.server?.node_id ?? ""],
                      node
                    ) !== null
                      ? `${calculateDistanceBetweenNodes(nodes[config?.server?.node_id ?? ""], node)} km`
                      : "Unknown"}
                  </td>
                </tr>
                <tr>
                  <th className="p-1" align="left">
                    Status
                  </th>
                  <td className="p-1">
                    {node.active ? (
                      <span className="text-green-500">Online</span>
                    ) : (
                      <span className="text-gray-700">Offline</span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th className="p-1" align="left">
                    Last Seen
                  </th>
                  <td
                    className="p-1 text-nowrap"
                    title={node.last_seen || "Unknown"}
                  >
                    {node.last_seen || "Unknown"}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div className="mb-4">
            <h3 className="mb-2 font-bold text-gray-600">Heard (zero hop)</h3>
            <table className="table-auto min-w-full border border-gray-200 bg-gray-50">
              <tbody className="divide-y divide-dashed divide-gray-200">
                {node.neighborinfo?.neighbors?.map((neighbor, index) => {
                  const nid = convertNodeIdFromIntToHex(neighbor.node_id);
                  const nnode = nodes[nid] || null;
                  return (
                    // eslint-disable-next-line react/no-array-index-key
                    <tr key={`neighbors-${index}`}>
                      <td className="w-1/3 p-1 text-nowrap">
                        {nnode ? (
                          <a href={`node_${nnode.id}.html`}>
                            {nnode.shortname}
                          </a>
                        ) : (
                          <span className="text-gray-500">UNK</span>
                        )}
                      </td>
                      <td className="p-1 text-nowrap">SNR: {neighbor.snr}</td>
                      <td className="p-1 text-nowrap" align="right">
                        {nnode && calculateDistanceBetweenNodes(nnode, node)
                          ? `${calculateDistanceBetweenNodes(nnode, node)} km`
                          : ""}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mb-4">
            <h3 className="mb-2 font-bold text-gray-600">
              Heard By (zero hop)
            </h3>
            <table className="table-auto min-w-full border border-gray-200 bg-gray-50">
              <tbody className="divide-y divide-dashed divide-gray-200">
                {Object.entries(nodes).map(
                  ([iid, nnode], index) =>
                    nnode.neighborinfo &&
                    nnode.neighborinfo?.neighbors?.map((neighbor, subIndex) => {
                      if (
                        convertNodeIdFromIntToHex(neighbor.node_id) === node.id
                      ) {
                        return (
                          // eslint-disable-next-line react/no-array-index-key
                          <tr key={`neighbors-heard-by-${index}-${subIndex}`}>
                            <td className="w-1/3 p-1 text-nowrap">
                              {iid in nodes ? (
                                <a href={`node_${iid}.html`}>
                                  {nodes[iid].shortname}
                                </a>
                              ) : (
                                <span className="text-gray-500">UNK</span>
                              )}
                            </td>
                            <td className="p-1 text-nowrap">
                              SNR: {neighbor.snr}
                            </td>
                            <td className="p-1 text-nowrap" align="right">
                              {calculateDistanceBetweenNodes(nodes[iid], node)
                                ? `${calculateDistanceBetweenNodes(nodes[iid], node)} km`
                                : ""}
                            </td>
                          </tr>
                        );
                      }
                      return null;
                    })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
};
