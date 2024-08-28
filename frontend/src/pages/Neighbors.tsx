import { formatDuration, formatISO, intervalToDuration } from "date-fns";
import { useMemo } from "react";

import { HeardBy } from "../components/HeardBy";
import { useGetNodesQuery } from "../slices/apiSlice";
import { convertNodeIdFromIntToHex } from "../utils/convertNodeId";
import { calculateDistanceBetweenNodes } from "../utils/getDistanceBetweenTwoNodes";

export const Neighbors = () => {
  const { data: nodes } = useGetNodesQuery();
  const activeNodesWithNeighbors = useMemo(
    () =>
      Object.values(nodes ?? [])?.filter(
        (n) => n.active && n.neighborinfo && Object.keys(n.neighborinfo)
      ),
    [nodes]
  );

  if (!nodes) {
    return <div>Loading...</div>;
  }

  return (
    <div>
      <h5 className="mb-2 text-gray-500">Neighbors</h5>
      <h1 className="mb-2 text-xl">Neighbors</h1>
      <p className="mb-2">
        There are <b>{Object.keys(activeNodesWithNeighbors).length}</b> active
        nodes with neighbors <HeardBy />
      </p>

      <table className="w-full max-w-full table-auto border-collapse border border-gray-500 bg-gray-50">
        <thead>
          <tr>
            <th className="w-20 max-w-20 border border-gray-500 bg-gray-400">
              ID
            </th>
            <th className="border border-gray-500 bg-gray-400" colSpan={2}>
              Name
            </th>
            <th className="border border-gray-500 bg-gray-400" colSpan={3}>
              Neighbors
            </th>
            <th
              className="hidden xl:table-cell border border-gray-500 bg-gray-400"
              colSpan={2}
            >
              Seen
            </th>
          </tr>
          <tr>
            <th className="w-12 max-w-12 border border-gray-500 bg-gray-400" />
            <th className="w-12 max-w-12 border border-gray-500 bg-gray-400">
              Short
            </th>
            <th className="border border-gray-500 bg-gray-400">Long</th>
            <th className="border border-gray-500 bg-gray-400">Heard</th>
            <th className="border border-gray-500 bg-gray-400">Heard By</th>
            <th className="border border-gray-500 bg-gray-400">Interval</th>
            <th className="hidden xl:table-cell border border-gray-500 bg-gray-400">
              Last
            </th>
            <th className="hidden xl:table-cell w-20 max-w-20 border border-gray-500 bg-gray-400">
              Since
            </th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(activeNodesWithNeighbors).map(([id, node]) => {
            const sanitizedId = id.replace("!", "");
            return (
              <tr key={id}>
                <td
                  className="p-1 border border-gray-400"
                  align="center"
                  valign="middle"
                >
                  <a href={`node_${sanitizedId}.html`}>
                    <img
                      src={`https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${sanitizedId}`}
                      alt="Avatar"
                      className="w-16 h-16 mb-1 object-cover"
                    />
                  </a>
                </td>
                <td
                  className="p-1 border border-gray-400"
                  style={{ color: node.shortname === "UNK" ? "#777" : "#000" }}
                  align="center"
                >
                  <a href={`node_${sanitizedId}.html`}>{node.shortname}</a>
                </td>
                <td
                  className="p-1 border border-gray-400"
                  style={{ color: node.shortname === "UNK" ? "#777" : "#000" }}
                >
                  {node.longname}
                </td>
                {node.neighborinfo ? (
                  <>
                    <td className="p-0 border border-gray-400" valign="top">
                      <table className="table-auto min-w-full">
                        <tbody className="divide-y divide-dashed divide-gray-400">
                          {node.neighborinfo?.neighbors?.map(
                            (neighbor, index) => (
                              // eslint-disable-next-line react/no-array-index-key
                              <tr key={`neighbors-${index}`}>
                                <td className="w-1/3 p-1 text-nowrap">
                                  {nodes[neighbor.node_id] ? (
                                    <a
                                      href={`node_${nodes[neighbor.node_id].id}.html`}
                                    >
                                      {nodes[neighbor.node_id].shortname}
                                    </a>
                                  ) : (
                                    <span className="text-gray-500">UNK</span>
                                  )}
                                </td>
                                <td className="p-1 text-nowrap">
                                  SNR: {neighbor.snr}
                                </td>
                                <td className="p-1 text-nowrap" align="right">
                                  {neighbor.distance &&
                                    `${neighbor.distance} km`}
                                </td>
                              </tr>
                            )
                          )}
                        </tbody>
                      </table>
                    </td>
                    <td className="p-0 border border-gray-400" valign="top">
                      <table className="table-auto min-w-full">
                        <tbody className="divide-y divide-dashed divide-gray-400">
                          {Object.entries(nodes).map(([nid, nnode]) =>
                            nnode.neighborinfo?.neighbors?.map(
                              (neighbor, subIndex) =>
                                convertNodeIdFromIntToHex(neighbor.node_id) ===
                                id ? (
                                  // eslint-disable-next-line react/no-array-index-key
                                  <tr key={`${nid}-${subIndex}`}>
                                    <td className="w-1/3 p-1 text-nowrap">
                                      <a href={`node_${nid}.html`}>
                                        {nnode.shortname}
                                      </a>
                                    </td>
                                    <td className="p-1 text-nowrap">
                                      SNR: {neighbor.snr}
                                    </td>
                                    <td
                                      className="p-1 text-nowrap"
                                      align="right"
                                    >
                                      {calculateDistanceBetweenNodes(
                                        nodes[nid],
                                        nodes[id]
                                      ) &&
                                        `${calculateDistanceBetweenNodes(nodes[nid], nodes[id])} km`}
                                    </td>
                                  </tr>
                                ) : null
                            )
                          )}
                        </tbody>
                      </table>
                    </td>
                    <td className="p-1 border border-gray-400" align="right">
                      {node.neighborinfo.node_broadcast_interval_secs}s
                    </td>
                  </>
                ) : (
                  <td className="p-1 border border-gray-400" />
                )}
                <td className="hidden xl:table-cell p-1 border border-gray-400">
                  {formatISO(new Date(node.last_seen))}
                </td>
                <td
                  className="hidden xl:table-cell p-1 text-nowrap border border-gray-400"
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
                  secs
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <br />
      <br />
      <br />
      <br />
      <a href="nodes.json">Download JSON</a>
    </div>
  );
};
