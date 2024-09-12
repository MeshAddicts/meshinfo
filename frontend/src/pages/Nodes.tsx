import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { Avatar } from "../components/Avatar";
import { DateToSince } from "../components/DateSince";
import { HardwareImg } from "../components/HardwareImg";
import { HeardBy } from "../components/HeardBy";
import { Role } from "../components/Role";
import { useGetNodesQuery } from "../slices/apiSlice";
import { HardwareModel, INode } from "../types";
import { getDistanceBetweenTwoPoints } from "../utils/getDistanceBetweenPoints";

export const Nodes = () => {
  const { data: nodes } = useGetNodesQuery(
    { status: "online" },
    {
      pollingInterval: 3000,
      skipPollingIfUnfocused: true,
    }
  );

  const [sort, setSort] = useState({ by: "last_seen", dir: "asc" });

  const [currentDate, setCurrentDate] = useState(new Date());

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentDate(new Date());
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  const activeNodes = useMemo(
    () => Object.values(nodes ?? [])?.filter((n) => n.active),
    [nodes]
  );

  const sortedNodes = useMemo(
    () =>
      Object.values(activeNodes ?? []).sort((a: INode, b: INode) => {
        let order = [];
        if (sort.dir === "asc") {
          order = [-1, 1];
        } else {
          order = [1, -1];
        }

        if (sort.by === "altitude" && a.position && b.position) {
          return (a.position.altitude || -1) > (b.position.altitude || -1)
            ? order[0]
            : order[1];
        }
        if (sort.by === "shortname") {
          return a.shortname > b.shortname ? order[0] : order[1];
        }
        if (sort.by === "last_seen") {
          // sort by last seen
          return (new Date(a.last_seen).getTime() ?? 0) >
            (new Date(b.last_seen).getTime() ?? 0)
            ? order[0]
            : order[1];

          // const dateA =
          //   a.last_seen != null ? new Date(a.last_seen).getTime() : 0;
          // const dateB =
          //   b.last_seen != null ? new Date(b.last_seen).getTime() : 0;
          // console.log("dateA / dateB = %s / %s", dateA, dateB);
          // return dateA > dateB ? order[0] : order[1];
        }
        if (sort.by === "longname") {
          return a.longname > b.longname ? order[0] : order[1];
        }

        return 0;
      }),
    [activeNodes, sort]
  );

  const serverNode = useMemo(() => nodes && nodes["4355f528"], [nodes]);

  if (!nodes || !activeNodes) return <div>Loading...</div>;

  function invertSortDir() {
    if (sort.dir === "asc") {
      setSort({ ...sort, dir: "desc" });
    } else {
      setSort({ ...sort, dir: "asc" });
    }
  }

  function clickSort(column: string) {
    if (sort.by === column) {
      invertSortDir();
    } else {
      setSort({ by: column, dir: "asc" });
    }
  }

  return (
    <div>
      <h5 className="mb-2 text-gray-500">Nodes</h5>
      <h1 className="mb-2 text-xl">Nodes</h1>
      <div className="mb-4">
        There are <b>{Object.keys(sortedNodes).length}</b> active out of a total
        of <b>{Object.entries(nodes).length}</b> seen nodes <HeardBy />
      </div>

      <table className="w-full max-w-full table-auto border-collapse border border-gray-500 bg-gray-50 dark:bg-gray-800">
        <thead>
          <tr>
            <th
              className="border border-gray-500 bg-gray-400 dark:bg-gray-900"
              colSpan={2}
            >
              ID
            </th>
            <th
              className="border border-gray-500 bg-gray-400 dark:bg-gray-900"
              colSpan={2}
            >
              Name
            </th>
            <th className="hidden sm:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900">
              HW
            </th>
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Role
            </th>
            <th
              className="hidden xl:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900"
              colSpan={3}
            >
              Last Position
            </th>
            <th className="hidden md:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Neighbors
            </th>
            <th
              className="hidden 2xl:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900"
              colSpan={4}
            >
              Telemetry
            </th>
            <th
              className="border border-gray-500 bg-gray-400 dark:bg-gray-900"
              colSpan={1}
            >
              Seen
            </th>
          </tr>
          <tr>
            <th className="w-8 min-w-8 max-w-8 h-8 min-h-8 max-h-8 border border-gray-500 bg-gray-400 dark:bg-gray-900" />
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Hex
            </th>
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900">
              <button type="button" onClick={() => clickSort("shortname")}>
                Short
              </button>
            </th>
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900">
              <button type="button" onClick={() => clickSort("longname")}>
                Long
              </button>
            </th>
            <th className="hidden sm:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900" />
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900" />
            <th className="hidden xl:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900">
              <button type="button" onClick={() => clickSort("altitude")}>
                Altitude
              </button>
            </th>
            <th className="hidden xl:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Coordinates
            </th>
            <th className="hidden xl:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900">
              DX
            </th>
            <th className="hidden md:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900">
              Count
            </th>
            <th className="hidden 2xl:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900">
              <img
                src={`${import.meta.env.BASE_URL}images/icons/battery.svg`}
                className="w-4 h-4 inline-block dark:invert"
                alt="Battery"
                title="Battery"
              />
            </th>
            <th className="hidden 2xl:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900">
              <img
                src={`${import.meta.env.BASE_URL}images/icons/voltage.svg`}
                className="w-4 h-4 inline-block dark:invert"
                alt="Voltage"
                title="Voltage"
              />
            </th>
            <th className="hidden 2xl:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900">
              <img
                src={`${import.meta.env.BASE_URL}images/icons/up.svg`}
                alt="Air Util TX"
                className="w-4 h-4 inline-block dark:invert"
                title="Air Util TX"
              />
            </th>
            <th className="hidden 2xl:table-cell border border-gray-500 bg-gray-400 dark:bg-gray-900">
              <img
                src={`${import.meta.env.BASE_URL}images/icons/down.svg`}
                className="w-4 h-4 inline-block dark:invert"
                alt="Channel Util"
                title="Channel Util"
              />
            </th>
            <th className="border border-gray-500 bg-gray-400 dark:bg-gray-900">
              <button type="button" onClick={() => clickSort("last_seen")}>
                Since
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {sortedNodes.map(({ id, ...node }) => (
            <tr key={id}>
              <td
                className="w-8 min-w-8 max-w-8 h-8 min-h-8 max-h-8 p-0 box-border border border-gray-400"
                align="center"
                valign="middle"
              >
                <Avatar id={id} size={8} />
              </td>
              <td className="p-1 border border-gray-400">
                {id ? (
                  <Link
                    to={id.replace("!", "")}
                    className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
                  >
                    {id.replace("!", "")}
                  </Link>
                ) : (
                  id
                )}
              </td>
              <td
                className="p-1 border border-gray-400"
                style={{ color: node.shortname === "UNK" ? "#777" : "#000" }}
              >
                {id ? (
                  <Link
                    to={id.replace("!", "")}
                    className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
                  >
                    {node.shortname}
                  </Link>
                ) : (
                  node.shortname
                )}
              </td>
              <td
                className={`p-1 border border-gray-400 text-nowrap truncate ${node.shortname === "UNK" && "text-neutral-700 dark:text-neutral-500"}`}
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
                  <td className="hidden xl:table-cell p-1 border border-gray-400 text-center">
                    {node.position &&
                    node.position.latitude &&
                    node.position.longitude ? (
                      <span
                        title={`${node.position.latitude}, ${node.position.longitude}`}
                      >
                        Yes
                      </span>
                    ) : (
                      <></>
                    )}
                  </td>
                  <td
                    className="hidden xl:table-cell p-1 border border-gray-400 text-nowrap"
                    align="right"
                  >
                    {serverNode?.position &&
                      serverNode.position.latitude &&
                      serverNode.position.longitude &&
                      node.position &&
                      node.position.latitude &&
                      node.position.latitude !== 0 &&
                      node.position.longitude &&
                      node.position.longitude !== 0 &&
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
                <DateToSince date={node.last_seen} currentDate={currentDate} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
