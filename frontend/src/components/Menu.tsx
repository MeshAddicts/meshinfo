import { useState } from "react";
import { Link, useLocation } from "react-router-dom";

import { useGetConfigQuery } from "../slices/apiSlice";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const defaultTools = [
  { name: "Armooo's MeshView", url: "https://meshview.armooo.net" },
  { name: "Liam's Meshtastic Map", url: "https://meshtastic.liamcottle.net" },
  { name: "MeshMap", url: "https://meshmap.net" },
  { name: "Bay Mesh Explorer", url: "https://app.bayme.sh" },
  { name: "HWT Path Profiler", url: "https://heywhatsthat.com/profiler.html" },
];

export const Menu = ({
  isDark,
  onDarkChange,
}: {
  isDark: boolean;
  onDarkChange: (dark: boolean) => void;
}) => {
  const { data: config } = useGetConfigQuery();
  const location = useLocation();

  const [showMenu, setShowMenu] = useState(false);

  const handleDarkChange = (dark: boolean) => {
    onDarkChange(dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  };

  const handleLinkClick = () => {
    setShowMenu(false);
  };

  const getLinkClassName = (path: string) => {
    const isActive = location.pathname.endsWith(path);
    return `mb-1 p-2 w-full rounded overflow-hidden ${
      isActive
        ? "bg-indigo-200 dark:bg-indigo-800 text-indigo-800 dark:text-indigo-200"
        : "hover:bg-indigo-100 dark:hover:bg-indigo-700 dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-300"
    }`;
  };

  return (
    <>
      <button
        type="button"
        className={`fixed z-50 top-4 left-4 p-2 rounded-full lg:hidden  hover:scale-110 transform transition-all duration-300 ${showMenu ? "bg-gray-100 dark:bg-gray-700" : "bg-gray-300 dark:bg-gray-800"}`}
        onClick={() => setShowMenu(!showMenu)}
        aria-label="Show/Hide Menu"
      >
        {showMenu ? (
          <img
            width="10"
            height="14"
            src={`${import.meta.env.BASE_URL}images/icons/close.svg`}
            className="dark:invert"
            alt="Close"
          />
        ) : (
          <img
            width="14"
            src={`${import.meta.env.BASE_URL}images/icons/menu.svg`}
            className="dark:invert"
            alt="Menu"
          />
        )}
      </button>

      <div
        className={`w-full fixed top-0 left-0 right-0 z-40 lg:inset-y-0 lg:flex lg:w-60 lg:flex-col ${
          showMenu ? "" : "hidden"
        } dark:text-gray-100`}
      >
        <div className="flex flex-col px-6 pb-4 overflow-y-auto bg-gray-300 dark:bg-gray-800 border-r-2 grow gap-y-5 border-r-cyan-600 pt-14 lg:pt-0 h-screen">
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

          <div>
            <a
              href="/"
              className="text-xs text-gray-900 dark:text-gray-50 dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
            >
              Back to the old UI
            </a>
          </div>

          <nav className="flex flex-col flex-1">
            <h3 className="mb-1 font-bold">Mesh</h3>
            <Link
              to="chat"
              relative="path"
              className={getLinkClassName("chat")}
              onClick={handleLinkClick}
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
            <Link
              to="map"
              className={getLinkClassName("map")}
              onClick={handleLinkClick}
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
            <Link
              to="nodes"
              className={getLinkClassName("nodes")}
              onClick={handleLinkClick}
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
            <Link
              to="neighbors"
              className={getLinkClassName("neighbors")}
              onClick={handleLinkClick}
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
            <Link
              to="stats"
              className={getLinkClassName("stats")}
              onClick={handleLinkClick}
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
            <Link
              to="telemetry"
              className={getLinkClassName("telemetry")}
              onClick={handleLinkClick}
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
            <Link
              to="traceroutes"
              className={getLinkClassName("traceroutes")}
              onClick={handleLinkClick}
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
          </nav>

          <nav className="flex flex-col flex-1">
            <h3 className="mb-1 font-bold">Logs</h3>
            <Link
              to="mesh-log"
              className={getLinkClassName("mesh-log")}
              onClick={handleLinkClick}
            >
              Mesh Messages
            </Link>
            <Link
              to="mqtt-log"
              className={getLinkClassName("mqtt-log")}
              onClick={handleLinkClick}
            >
              MQTT Messages
            </Link>
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
            <div className="flex">
              <a
                href="https://github.com/MeshAddicts/meshinfo"
                className="text-xs text-gray-500"
              >
                <img
                  src="https://img.shields.io/github/stars/MeshAddicts/meshinfo?style=social"
                  alt="GitHub Stars"
                />
              </a>
              {isDark ? (
                <div
                  role="button"
                  onClick={() => handleDarkChange(false)}
                  onKeyDown={() => handleDarkChange(false)}
                  tabIndex={0}
                >
                  <img
                    src={`${import.meta.env.BASE_URL}images/icons/light-mode.svg`}
                    width="20"
                    height="20"
                    className="inline-block ml-2 dark:invert cursor-pointer"
                    alt="light mode icon"
                    title="Switch to Light Mode"
                  />
                </div>
              ) : (
                <div
                  role="button"
                  onClick={() => handleDarkChange(true)}
                  onKeyDown={() => handleDarkChange(true)}
                  tabIndex={0}
                >
                  <img
                    src={`${import.meta.env.BASE_URL}images/icons/dark-mode.svg`}
                    width="20"
                    height="20"
                    className="inline-block ml-2 dark:invert cursor-pointer"
                    alt="light mode icon"
                    title="Switch to Dark Mode"
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
