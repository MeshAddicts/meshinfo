import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { useGetConfigQuery } from "../slices/apiSlice";

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
  const [showMenu, setShowMenu] = useState(false);

  useEffect(() => {
    if (!showMenu) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowMenu(false);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showMenu]);

  const handleDarkChange = (dark: boolean) => {
    onDarkChange(dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  };

  return (
    <>
      {/* Mobile Hamburger Button */}
      <button
        type="button"
        className={`lg:hidden fixed z-50 top-4 right-4 left-auto p-2 rounded-lg shadow-lg backdrop-blur-sm border transition-all duration-200 ${
          showMenu 
            ? "bg-gray-800 dark:bg-gray-200 border-gray-600 dark:border-gray-400" 
            : "bg-white/90 dark:bg-gray-800/90 border-gray-200 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700"
        }`}
        onClick={() => setShowMenu(!showMenu)}
        aria-label="Toggle Menu"
        aria-expanded={showMenu}
      >
        <div className="w-5 h-5 flex flex-col justify-center items-center">
          {showMenu ? (
            <svg 
              className="w-4 h-4 text-white dark:text-gray-800" 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            <svg 
              className="w-4 h-4 text-gray-700 dark:text-gray-200" 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </div>
      </button>

      {/* Mobile Backdrop */}
      <div 
        className={`lg:hidden fixed inset-0 bg-black/20 backdrop-blur-sm z-40 transition-opacity duration-200 ${
          showMenu ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setShowMenu(false)}
      />

      {/* Navigation Panel */}
      <div
        className={`w-full lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-60 lg:flex-col ${
          showMenu ? "" : "hidden"
        } dark:text-gray-100 z-0 lg:z-50`}
      >
        {/* Mobile Drawer */}
        <div className="lg:hidden fixed inset-y-0 left-0 z-50 w-80 max-w-[80vw] bg-white dark:bg-gray-900 shadow-xl border-r border-gray-200 dark:border-gray-700">
          <div className="flex flex-col h-full overflow-hidden">
            {/* Mobile Header */}
            <div className="p-4 border-b border-gray-200 dark:border-gray-700">
              <div className="mb-2">
                {config?.mesh?.name?.split(" ").map((word, index) => (
                  <div
                    className="text-xl font-bold dark:text-gray-50"
                    key={`mobile-meshname-${index}`}
                  >
                    {word[0]}
                    <span className="text-gray-500 dark:text-gray-400 font-normal">
                      {word.slice(1)}
                    </span>
                  </div>
                ))}
              </div>
              {config?.mesh?.description && (
                <p className="text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                  {config.mesh.description}
                </p>
              )}
            </div>

            {/* Mobile Navigation */}
            <div className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
              <div className="space-y-1">
                <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-3 py-2">Mesh</h3>
                <Link to="/chat" onClick={() => setShowMenu(false)} className="block">
                  <div className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Chat</span>
                  </div>
                </Link>
                <Link to="/map" onClick={() => setShowMenu(false)} className="block">
                  <div className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Map</span>
                  </div>
                </Link>
                <Link to="/nodes" onClick={() => setShowMenu(false)} className="block">
                  <div className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Nodes</span>
                  </div>
                </Link>
                <Link to="/neighbors" onClick={() => setShowMenu(false)} className="block">
                  <div className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Node Neighbors</span>
                  </div>
                </Link>
                <Link to="/stats" onClick={() => setShowMenu(false)} className="block">
                  <div className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Stats</span>
                  </div>
                </Link>
                <Link to="/telemetry" onClick={() => setShowMenu(false)} className="block">
                  <div className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Telemetry</span>
                  </div>
                </Link>
                <Link to="/traceroutes" onClick={() => setShowMenu(false)} className="block">
                  <div className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-200">Traceroutes</span>
                  </div>
                </Link>
              </div>
            </div>

            {/* Mobile Footer */}
            <div className="p-4 border-t border-gray-200 dark:border-gray-700">
              <button
                onClick={() => handleDarkChange(!isDark)}
                className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
              >
                {isDark ? "🌞" : "🌙"}
              </button>
            </div>
          </div>
        </div>

        {/* Desktop Sidebar */}
        <div className="hidden lg:flex lg:flex-col px-6 pb-4 overflow-y-auto bg-gray-300 dark:bg-gray-800 border-r-2 grow gap-y-5 border-r-cyan-600">
          <div className="flex items-center h-24 mt-4 shrink-0">
            <div className="text-2xl">
              {config?.mesh?.name?.split(" ").map((word, index) => (
                <div
                  className="p-0 m-0 dark:text-gray-50"
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