import { useState } from "react";
import { Link } from "react-router-dom";

import { useGetConfigQuery } from "../slices/apiSlice";

const defaultTools = [
  { name: "Armooo's MeshView", url: "https://meshview.armooo.net" },
  { name: "Liam's Meshtastic Map", url: "https://meshtastic.liamcottle.net" },
  { name: "MeshMap", url: "https://meshmap.net" },
  { name: "Bay Mesh Explorer", url: "https://app.bayme.sh" },
  { name: "HWT Path Profiler", url: "https://heywhatsthat.com/profiler.html" },
];

export const Menu = () => {
  const { data: config } = useGetConfigQuery();

  const [showMenu, setShowMenu] = useState(false);

  return (
    <>
      <button
        type="button"
        className={`fixed z-50 top-4 left-4 p-2 rounded-full hover:scale-110 transform transition-all duration-300 ${showMenu ? "bg-gray-100" : "bg-gray-300"}`}
        onClick={() => setShowMenu(!showMenu)}
        aria-label="Show/Hide Menu"
      >
        {showMenu ? (
          <img
            width="10"
            height="14"
            src={`${import.meta.env.BASE_URL}images/icons/close.svg`}
            alt="Close"
          />
        ) : (
          <img
            width="14"
            src={`${import.meta.env.BASE_URL}images/icons/menu.svg`}
            alt="Menu"
          />
        )}
      </button>

      <div
        className={`lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-60 lg:flex-col ${showMenu ? "" : "hidden"} dark:text-gray-100`}
      >
        <div className="flex flex-col px-6 pb-4 overflow-y-auto bg-gray-300 dark:bg-gray-800 border-r-2 grow gap-y-5 border-r-cyan-600 sm:pt-14 md:pt-14 lg:pt-0">
          <div className="flex items-center h-24 mt-4 shrink-0">
            <div className="text-2xl">
              {config?.mesh?.name?.split(" ").map((word, index) => (
                <div
                  className="p-0 m-0 dark:text-gray-50"
                  // eslint-disable-next-line react/no-array-index-key
                  key={`meshname-${index}`}
                >
                  {word[0]}
                  <span className="text-gray-500 dark:text-gray-400">
                    {word.slice(1)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div>{config?.mesh?.description}</div>

          <div>
            <a
              href={config?.mesh?.url}
              className="text-xs text-gray-900 dark:text-gray-50"
            >
              Website
            </a>
          </div>

          <nav className="flex flex-col flex-1">
            <h3 className="font-bold">Mesh</h3>
            <div className="mb-1">
              <Link
                to="chat"
                relative="path"
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
              >
                <img
                  src={`${import.meta.env.BASE_URL}images/icons/chat.svg`}
                  width="20"
                  height="20"
                  className="inline-block mr-2 dark:invert"
                  alt="chat icon"
                  style={{ verticalAlign: "middle" }}
                />
                Chat
              </Link>
            </div>
            {/* TODO <div className="mb-1">
              <Link to="graph" relative="path">
                <img
                  src={`${import.meta.env.BASE_URL}images/icons/map.svg`}
                  width="20"
                  height="20"
                  className="inline-block mr-2 dark:invert"
                  alt="graph icon"
                  style={{ verticalAlign: "middle" }}
                />
                Graph
              </Link>
            </div> */}
            <div className="mb-1">
              <Link
                to="map"
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
              >
                <img
                  src={`${import.meta.env.BASE_URL}images/icons/map.svg`}
                  width="20"
                  height="20"
                  className="inline-block mr-2 dark:invert"
                  alt="map icon"
                  style={{ verticalAlign: "middle" }}
                />
                Map
              </Link>
            </div>
            <div className="mb-1">
              <Link
                to="nodes"
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
              >
                <img
                  src={`${import.meta.env.BASE_URL}images/icons/node.svg`}
                  width="20"
                  height="20"
                  className="inline-block mr-2 dark:invert"
                  alt="node icon"
                  style={{ verticalAlign: "middle" }}
                />
                Nodes
              </Link>
            </div>
            <div className="mb-1">
              <Link
                to="neighbors"
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
              >
                <img
                  src={`${import.meta.env.BASE_URL}images/icons/neighbors.svg`}
                  width="20"
                  height="20"
                  className="inline-block mr-2 dark:invert"
                  alt="neighbors icon"
                  style={{ verticalAlign: "middle" }}
                />
                Node Neighbors
              </Link>
            </div>
            <div className="mb-1">
              <Link
                to="stats"
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
              >
                <img
                  src={`${import.meta.env.BASE_URL}images/icons/stats.svg`}
                  width="20"
                  height="20"
                  className="inline-block mr-2 dark:invert"
                  alt="stats icon"
                  style={{ verticalAlign: "middle" }}
                />
                Stats
              </Link>
            </div>
            <div className="mb-1">
              <Link
                to="telemetry"
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
              >
                <img
                  src={`${import.meta.env.BASE_URL}images/icons/telemetry.svg`}
                  width="20"
                  height="20"
                  className="inline-block mr-2 dark:invert"
                  alt="telemetry icon"
                  style={{ verticalAlign: "middle" }}
                />
                Telemetry
              </Link>
            </div>
            <div className="mb-1">
              <Link
                to="traceroutes"
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
              >
                <img
                  src={`${import.meta.env.BASE_URL}images/icons/route2.svg`}
                  width="20"
                  height="20"
                  className="inline-block mr-2 dark:invert"
                  alt="traceroutes icon"
                  style={{ verticalAlign: "middle" }}
                />
                Traceroutes
              </Link>
            </div>
          </nav>

          <nav className="flex flex-col flex-1">
            <h3 className="font-bold">Logs</h3>
            <div className="mb-1">
              <Link
                to="mesh-log"
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
              >
                Mesh Messages
              </Link>
            </div>
            <div className="mb-1">
              <Link
                to="mqtt-log"
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
              >
                MQTT Messages
              </Link>
            </div>
          </nav>

          <nav className="flex flex-col flex-1">
            <h3 className="font-bold">Tools</h3>
            {(config?.mesh?.tools ?? defaultTools).map((tool, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={`tools-${index}`} className="mb-1">
                <a
                  href={tool.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
                >
                  {tool.name}
                </a>
              </div>
            ))}
          </nav>

          <nav className="flex flex-col flex-1">
            <h3 className="font-bold">Meshtastic Addons</h3>
            <div className="mb-1">
              <a
                href="https://github.com/armooo/meshtastic_dopewars"
                target="_blank"
                rel="noreferrer"
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
              >
                DopeWars
              </a>
            </div>
            <div className="mb-1">
              <a
                href="https://github.com/TheCommsChannel/TC2-BBS-mesh"
                target="_blank"
                rel="noreferrer"
                className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
              >
                TheCommsChannel BBS
              </a>
            </div>
          </nav>

          <div className="flex-grow" />

          {/*
          TODO <div className="flex flex-col">
            <div className="font-bold">Data Updated</div>
            <div></div>
          </div> */}

          <div className="flex-grow" />

          <div className="flex flex-col">
            <h5 className="mb-2">
              Powered by MeshInfo{" "}
              <span className="text-xs text-gray-500">
                {config?.server?.version_info?.refName}
              </span>
            </h5>
            <a
              href="https://github.com/MeshAddicts/meshinfo"
              className="text-xs text-gray-500"
            >
              <img
                src="https://img.shields.io/github/stars/MeshAddicts/meshinfo?style=social"
                alt="GitHub Stars"
              />
            </a>
          </div>
        </div>
      </div>
    </>
  );
};
