import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";

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
  const navigate = useNavigate();
  const menuRef = useRef<HTMLDivElement>(null);
  const [showMenu, setShowMenu] = useState(false);

  const handleDarkChange = (dark: boolean) => {
    onDarkChange(dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  };

  const closeMenu = () => setShowMenu(false);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        closeMenu();
      }
    };

    if (showMenu) {
      document.addEventListener("mousedown", handleClickOutside);
      document.addEventListener("touchstart", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("touchstart", handleClickOutside);
    };
  }, [showMenu]);

  // Close menu on escape key
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeMenu();
      }
    };

    if (showMenu) {
      document.addEventListener("keydown", handleEscape);
    }

    return () => {
      document.removeEventListener("keydown", handleEscape);
    };
  }, [showMenu]);

  // Prevent body scroll when menu is open on mobile
  useEffect(() => {
    if (showMenu && window.innerWidth < 1024) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "auto";
    }

    return () => {
      document.body.style.overflow = "auto";
    };
  }, [showMenu]);

  const handleNavigation = (to: string) => {
    navigate(to);
    closeMenu();
  };

  const NavigationLink = ({ 
    to, 
    children, 
    icon,
    onClick 
  }: { 
    to?: string; 
    children: React.ReactNode; 
    icon?: string;
    onClick?: () => void;
  }) => {
    const content = (
      <div className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50 active:bg-gray-200 dark:active:bg-gray-600 cursor-pointer">
        {icon && (
          <img
            src={`${import.meta.env.BASE_URL}images/icons/${icon}`}
            width="18"
            height="18"
            className="dark:invert opacity-75"
            alt=""
          />
        )}
        <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {children}
        </span>
      </div>
    );

    if (to) {
      return (
        <Link 
          to={to} 
          className="block text-decoration-none" 
          onClick={closeMenu}
        >
          {content}
        </Link>
      );
    }

    return <div onClick={onClick}>{content}</div>;
  };

  const SectionHeader = ({ children }: { children: React.ReactNode }) => (
    <h3 className="text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider px-3 py-2">
      {children}
    </h3>
  );

  return (
    <>
      {/* Hamburger Button */}
      <button
        type="button"
        className={`fixed z-50 top-4 left-4 p-2 rounded-lg shadow-lg backdrop-blur-sm border transition-all duration-200 ${
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

      {/* Backdrop */}
      <div 
        className={`fixed inset-0 bg-black/20 backdrop-blur-sm z-40 transition-opacity duration-200 lg:hidden ${
          showMenu ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={closeMenu}
      />

      {/* Navigation Panel */}
      <div
        ref={menuRef}
        className={`fixed inset-y-0 left-0 z-50 transition-transform duration-300 ease-in-out ${
          showMenu ? "translate-x-0" : "-translate-x-full"
        } lg:translate-x-0 lg:static lg:inset-y-auto`}
      >
        {/* Mobile/Tablet Drawer */}
        <div className="lg:hidden w-80 max-w-[80vw] h-full bg-white dark:bg-gray-900 shadow-xl border-r border-gray-200 dark:border-gray-700">
          <div className="flex flex-col h-full overflow-hidden">
            {/* Header */}
            <div className="p-4 border-b border-gray-200 dark:border-gray-700">
              <div className="mb-2">
                {config?.mesh?.name?.split(" ").map((word, index) => (
                  <div
                    className="text-xl font-bold dark:text-gray-50"
                    key={`meshname-${index}`}
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
              {config?.mesh?.url && (
                <a
                  href={config.mesh.url}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Visit Website →
                </a>
              )}
            </div>

            {/* Scrollable Content */}
            <div className="flex-1 overflow-y-auto px-2 py-3 space-y-1">
              <SectionHeader>Mesh</SectionHeader>
              <NavigationLink to="/chat" icon="chat.svg">
                Chat
              </NavigationLink>
              <NavigationLink to="/map" icon="map.svg">
                Map
              </NavigationLink>
              <NavigationLink to="/nodes" icon="node.svg">
                Nodes
              </NavigationLink>
              <NavigationLink to="/neighbors" icon="neighbors.svg">
                Node Neighbors
              </NavigationLink>
              <NavigationLink to="/stats" icon="stats.svg">
                Stats
              </NavigationLink>
              <NavigationLink to="/telemetry" icon="telemetry.svg">
                Telemetry
              </NavigationLink>
              <NavigationLink to="/traceroutes" icon="route2.svg">
                Traceroutes
              </NavigationLink>

              <div className="pt-3">
                <SectionHeader>Logs</SectionHeader>
                <NavigationLink to="/mesh-log">
                  Mesh Messages
                </NavigationLink>
                <NavigationLink to="/mqtt-log">
                  MQTT Messages
                </NavigationLink>
              </div>

              <div className="pt-3">
                <SectionHeader>Tools</SectionHeader>
                {(config?.mesh?.tools ?? defaultTools).map((tool, index) => (
                  <a
                    key={`tools-${index}`}
                    href={tool.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block"
                    onClick={closeMenu}
                  >
                    <div className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50 active:bg-gray-200 dark:active:bg-gray-600">
                      <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                      </svg>
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                        {tool.name}
                      </span>
                    </div>
                  </a>
                ))}
              </div>

              <div className="pt-3">
                <SectionHeader>Add-ons</SectionHeader>
                <a
                  href="https://github.com/armooo/meshtastic_dopewars"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                  onClick={closeMenu}
                >
                  <div className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50">
                    <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                      DopeWars
                    </span>
                  </div>
                </a>
                <a
                  href="https://github.com/TheCommsChannel/TC2-BBS-mesh"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                  onClick={closeMenu}
                >
                  <div className="flex items-center gap-3 p-3 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-gray-700/50">
                    <svg className="w-4 h-4 text-gray-500 dark:text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                      TheCommsChannel BBS
                    </span>
                  </div>
                </a>
              </div>
            </div>

            {/* Footer */}
            <div className="p-4 border-t border-gray-200 dark:border-gray-700">
              <div className="flex items-center justify-between mb-3">
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  MeshInfo {config?.server?.version_info?.refName && (
                    <span className="font-mono">
                      {config.server.version_info.refName}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDarkChange(!isDark)}
                    className="p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                    aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
                  >
                    {isDark ? (
                      <svg className="w-4 h-4 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                      </svg>
                    ) : (
                      <svg className="w-4 h-4 text-gray-600 dark:text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
              <a
                href="https://github.com/MeshAddicts/meshinfo"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
                onClick={closeMenu}
              >
                ⭐ Star on GitHub
              </a>
            </div>
          </div>
        </div>

        {/* Desktop Sidebar (unchanged for large screens) */}
        <div className="hidden lg:flex lg:w-60 lg:flex-col">
          <div className="flex flex-col px-6 pb-4 overflow-y-auto bg-gray-300 dark:bg-gray-800 border-r-2 grow gap-y-5 border-r-cyan-600">
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
      </div>
    </>
  );
};