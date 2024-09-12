import { formatISO } from "date-fns";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Avatar } from "../components/Avatar";
import { DateToSince } from "../components/DateSince";
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

  const [currentDate, setCurrentDate] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentDate(new Date());
    }, 3000);
    return () => clearInterval(interval);
  }, []);

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
            <th className="w-20 max-w-20 border border-gray-500 bg-gray-400 dark:bg-gray-900">
              ID
            </th>
            <th
              className="border border-gray-500 bg-gray-400 dark:bg-gray-900"
              colSpan={2}
            >
              Name
            </th>
            <th
              className="border border-gray-500 bg-gray-400 dark:bg-gray-900"
              colSpan={3}
            >
              Neighbors
            </th>
            <th
              className="hidden xl:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900"
              colSpan={2}
            >
              Seen
            </th>
          </tr>
          <tr>
            <th className="w-12 max-w-12 border border-gray-500 bg-gray-400 dark:bg-gray-900" />
            <th className="w-12 max-w-12 border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Short
            </th>
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Long
            </th>
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Heard
            </th>
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Heard By
            </th>
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Interval
            </th>
            <th className="hidden xl:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Last
            </th>
            <th className="hidden xl:table-cell w-20 max-w-20 border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Since
            </th>
          </tr>
        </thead>
        <tbody>
          {activeNodesWithNeighbors.map((node) => {
            const id = node.id.replace("!", "");
            return (
              <tr key={`neighbors-${id}`} className="dark:bg-gray-800">
                <td
                  className="p-1 border border-gray-400"
                  align="center"
                  valign="middle"
                >
                  <Link
                    to={`/nodes/${id}`}
                    className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
                  >
                    <Avatar id={id} size={16} className="mb-1" />
                  </Link>
                </td>
                <td
                  className="p-1 border border-gray-400"
                  style={{ color: node.shortname === "UNK" ? "#777" : "#000" }}
                  align="center"
                >
                  <Link
                    to={`/nodes/${id}`}
                    className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
                  >
                    {node.shortname}
                  </Link>
                </td>
                <td
                  className={`p-1 border border-gray-400 ${node.shortname === "UNK" && "text-neutral-700 dark:text-neutral-500"}`}
                >
                  {node.longname}
                </td>
                {node.neighborinfo ? (
                  <>
                    <td className="p-0 border border-gray-400" valign="top">
                      <table className="table-auto min-w-full">
                        <tbody className="divide-y divide-dashed divide-gray-400">
                          {node.neighborinfo?.neighbors?.map((neighbor) => {
                            const neighborIdHex = convertNodeIdFromIntToHex(
                              neighbor.node_id
                            );
                            return (
                              <tr key={`neighbors-${node.id}-${neighborIdHex}`}>
                                <td className="w-1/3 p-1 text-nowrap">
                                  {nodes[neighborIdHex] ? (
                                    <Link
                                      to={`/nodes/${id}`}
                                      className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
                                    >
                                      {nodes[neighborIdHex].shortname}
                                    </Link>
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
                            );
                          })}
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
                                      <Link
                                        to={`/nodes/${nid}`}
                                        className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
                                      >
                                        {nnode.shortname}
                                      </Link>
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
                  <DateToSince
                    date={node.last_seen}
                    currentDate={currentDate}
                  />
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
      <a
        href="nodes.json"
        className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
      >
        Download JSON
      </a>
    </div>
  );
};
