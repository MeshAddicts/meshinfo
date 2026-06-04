import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation } from "react-router";

import { useGetConfigQuery } from "../slices/apiSlice";
import {
  ChevronDoubleLeftIcon,
  DEFAULT_TOOLS,
  type ExternalLinkDef,
  ExternalLinkIcon,
  GitHubIcon,
  MESH_NAV,
  MESHTASTIC_ADDONS,
  MoonIcon,
  type NavItemDef,
  SunIcon,
} from "./navConfig";

// Shared tokens — keep the rail and the drawer reading from one place.
const sectionHeader =
  "text-[10px] font-bold text-cyan-600 dark:text-cyan-500 uppercase tracking-widest";
const rowBase =
  "relative group flex items-center rounded-lg transition-colors";
const rowActive = "bg-cyan-500/15 text-cyan-700 dark:text-cyan-200";
const rowIdle =
  "text-gray-700 dark:text-gray-300 hover:bg-gray-500/10 dark:hover:bg-gray-700/50";
const GITHUB_URL = "https://github.com/MeshAddicts/meshinfo";

/** Mesh name with the first letter of each word emphasized, rest muted. */
function MeshName({ name, className }: { name?: string; className?: string }) {
  if (!name) return null;
  return (
    <div className={className}>
      {name.split(" ").map((word, i) => (
        <div key={i} className="leading-tight dark:text-gray-50">
          {word[0]}
          <span className="text-gray-500 dark:text-gray-400 font-normal">
            {word.slice(1)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Collapsed-rail brand: the deployer's logo (mesh.icon) if set, else the
 *  mesh name's first letter. */
function BrandMark({ icon, name }: { icon?: string; name?: string }) {
  if (icon)
    return (
      <img
        src={icon}
        alt={name ? `${name} logo` : "Logo"}
        className="w-7 h-7 object-contain"
      />
    );
  return <>{name?.[0] ?? "≡"}</>;
}

/** Brand header content shared by the rail and the drawer so their vertical
 *  metrics stay identical — no nav shift when moving between map and other pages. */
function BrandBlock({
  name,
  description,
  url,
}: {
  name?: string;
  description?: string;
  url?: string;
}) {
  return (
    <>
      <MeshName name={name} className="text-xl font-bold" />
      {description && (
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400 leading-relaxed line-clamp-3">
          {description}
        </p>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-1 inline-block text-xs text-cyan-600 dark:text-cyan-400 hover:underline"
        >
          Website
        </a>
      )}
    </>
  );
}

/** Internal route row — NavLink drives the cyan active state + aria-current. */
function NavRow({
  item,
  collapsed,
  onNavigate,
}: {
  item: NavItemDef;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <NavLink
      to={item.to}
      onClick={onNavigate}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `${rowBase} ${collapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5"} ${
          isActive ? rowActive : rowIdle
        }`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute left-0 top-1.5 bottom-1.5 w-0.75 rounded-full bg-cyan-500" />
          )}
          <span className="relative shrink-0">
            <item.Icon
              className={`w-5 h-5 ${
                isActive
                  ? "text-cyan-600 dark:text-cyan-300"
                  : "text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-200"
              }`}
            />
            {collapsed && item.badge && (
              <span className="absolute -right-1 -top-1 w-2 h-2 rounded-full bg-amber-500" />
            )}
          </span>
          {!collapsed && (
            <span className="text-sm font-medium">{item.label}</span>
          )}
          {!collapsed && item.badge && (
            <span className="ml-auto text-[10px] bg-amber-100 dark:bg-amber-900/50 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded-sm">
              {item.badge}
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

/** External (off-site) link row — opens in a new tab. */
function ExternalRow({
  link,
  collapsed,
  onNavigate,
}: {
  link: ExternalLinkDef;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onNavigate}
      title={collapsed ? link.name : undefined}
      className={`${rowBase} ${rowIdle} ${
        collapsed ? "justify-center p-2.5" : "gap-3 px-3 py-2.5"
      }`}
    >
      <ExternalLinkIcon className="w-5 h-5 shrink-0 text-gray-400 group-hover:text-gray-600 dark:group-hover:text-gray-200" />
      {!collapsed && (
        <span className="text-sm font-medium truncate">{link.name}</span>
      )}
    </a>
  );
}

function ThemeToggle({
  isDark,
  onToggle,
}: {
  isDark: boolean;
  onToggle: (dark: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!isDark)}
      title={isDark ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      className="flex items-center justify-center w-9 h-9 rounded-lg text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-500/10 dark:hover:bg-gray-700/50 transition-colors"
    >
      {isDark ? <SunIcon className="w-5 h-5" /> : <MoonIcon className="w-5 h-5" />}
    </button>
  );
}

export const Menu = ({
  isDark,
  onDarkChange,
  overlayMode = false,
}: {
  isDark: boolean;
  onDarkChange: (dark: boolean) => void;
  overlayMode?: boolean;
}) => {
  const { data: config } = useGetConfigQuery();
  const { pathname } = useLocation();
  const [showMenu, setShowMenu] = useState(false);
  // The desktop rail rests slim; expanding flies it out OVER the content as a
  // transient overlay (the page never reflows). Auto-retracts on navigate,
  // outside-click, or Escape, so it never lingers covering the page.
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded;
  const asideRef = useRef<HTMLElement>(null);

  const tools = config?.mesh?.tools?.length
    ? (config.mesh.tools as ExternalLinkDef[])
    : DEFAULT_TOOLS;
  const addons = MESHTASTIC_ADDONS;
  const closeDrawer = () => setShowMenu(false);
  const collapseRail = () => setExpanded(false);

  useEffect(() => {
    if (!showMenu) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShowMenu(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showMenu]);

  // Retract the expanded rail when the route changes (e.g. a nav click).
  useEffect(() => {
    setExpanded(false);
  }, [pathname]);

  // While expanded, retract on outside-click or Escape (flyout behavior).
  useEffect(() => {
    if (!expanded) return;
    const onDown = (e: MouseEvent) => {
      if (asideRef.current && !asideRef.current.contains(e.target as Node))
        setExpanded(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [expanded]);

  const handleDarkChange = (dark: boolean) => {
    onDarkChange(dark);
    localStorage.setItem("theme", dark ? "dark" : "light");
  };

  return (
    <>
      {/* Hamburger — small screens only (every page incl. map). At lg the
          persistent rail replaces it. Sits left on the map, right elsewhere. */}
      <button
        type="button"
        className={`lg:hidden fixed z-50 top-4 ${
          overlayMode ? "left-4" : "right-4 left-auto"
        } p-2 rounded-lg shadow-lg backdrop-blur-xs border transition-all duration-200 ${
          showMenu
            ? "bg-gray-800 dark:bg-gray-200 border-gray-600 dark:border-gray-400"
            : overlayMode
              ? "bg-gray-900/80 dark:bg-gray-900/80 backdrop-blur-xl border-white/10 hover:bg-gray-900/90"
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
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          ) : (
            <svg
              className="w-4 h-4 text-gray-700 dark:text-gray-200"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M4 6h16M4 12h16M4 18h16"
              />
            </svg>
          )}
        </div>
      </button>

      {/* Backdrop for the mobile drawer (small screens only). */}
      <div
        className={`lg:hidden fixed inset-0 bg-black/20 backdrop-blur-xs z-40 transition-opacity duration-200 ${
          showMenu ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setShowMenu(false)}
      />

      {/* Mobile drawer — small screens only, every page. At lg the persistent
          rail (below) takes over on every page, including the map. */}
      <div
        className={`lg:hidden fixed inset-y-0 left-0 z-50 w-80 max-w-[80vw] flex flex-col bg-white dark:bg-gray-900 shadow-xl border-r border-gray-200 dark:border-gray-700 ${
          showMenu ? "" : "hidden"
        }`}
      >
        <div className="px-4 pt-4 pb-3 border-b border-gray-200 dark:border-gray-700">
          <BrandBlock
            name={config?.mesh?.name}
            description={config?.mesh?.description}
            url={config?.mesh?.url}
          />
        </div>

        <nav
          className="flex-1 overflow-y-auto px-2 py-3 space-y-4"
          aria-label="Primary"
        >
          <div className="space-y-0.5">
            <h3 className={`${sectionHeader} px-3 pt-1 pb-1`}>Mesh</h3>
            {MESH_NAV.map((item) => (
              <NavRow
                key={item.to}
                item={item}
                collapsed={false}
                onNavigate={closeDrawer}
              />
            ))}
          </div>
          <div className="space-y-0.5">
            <h3 className={`${sectionHeader} px-3 pt-1 pb-1`}>Tools</h3>
            {tools.map((t, i) => (
              <ExternalRow
                key={`tool-${i}`}
                link={t}
                collapsed={false}
                onNavigate={closeDrawer}
              />
            ))}
          </div>
          <div className="space-y-0.5">
            <h3 className={`${sectionHeader} px-3 pt-1 pb-1`}>
              Meshtastic Addons
            </h3>
            {addons.map((t, i) => (
              <ExternalRow
                key={`addon-${i}`}
                link={t}
                collapsed={false}
                onNavigate={closeDrawer}
              />
            ))}
          </div>
        </nav>

        <div className="p-3 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <span className="text-xs text-gray-500 dark:text-gray-400">
            MeshInfo{" "}
            <span className="text-gray-400 dark:text-gray-500">
              {config?.server?.version_info?.refName}
            </span>
          </span>
          <ThemeToggle isDark={isDark} onToggle={handleDarkChange} />
        </div>
      </div>

      {/* Desktop rail (lg+) — rests slim in a fixed gutter on every page; when
          expanded it grows to w-60 OVER the content (overlay, z above the map
          panels) without moving the page. z-[1200] clears the map's z-1100 pills. */}
      <aside
        ref={asideRef}
        className={`hidden lg:flex lg:fixed lg:inset-y-0 lg:left-0 lg:z-1200 lg:flex-col overflow-hidden bg-gray-50 dark:bg-gray-900/80 dark:backdrop-blur-xl border-r border-gray-200 dark:border-white/10 transition-[width] duration-200 ${
          collapsed ? "lg:w-18" : "lg:w-60 lg:shadow-2xl"
        }`}
      >
          {/* Brand / collapse toggle */}
          <div className="shrink-0 border-b border-gray-200 dark:border-white/10">
            {collapsed ? (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                title="Expand sidebar"
                aria-label="Expand sidebar"
                className="flex items-center justify-center w-full h-16 text-lg font-bold text-gray-800 dark:text-gray-100 hover:bg-gray-500/10 dark:hover:bg-gray-700/50 transition-colors"
              >
                <BrandMark
                  icon={config?.mesh?.icon}
                  name={config?.mesh?.name}
                />
              </button>
            ) : (
              <div className="relative px-4 pt-4 pb-3">
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  title="Collapse sidebar"
                  aria-label="Collapse sidebar"
                  className="absolute top-3 right-3 p-1.5 rounded-lg text-gray-400 hover:text-gray-700 dark:hover:text-gray-100 hover:bg-gray-500/10 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <ChevronDoubleLeftIcon className="w-4 h-4" />
                </button>
                <BrandBlock
                  name={config?.mesh?.name}
                  description={config?.mesh?.description}
                  url={config?.mesh?.url}
                />
              </div>
            )}
          </div>

          {/* Nav */}
          <nav
            className="flex-1 overflow-y-auto no-scrollbar px-2 py-3"
            aria-label="Primary"
          >
            {collapsed ? (
              <div className="space-y-1">
                {MESH_NAV.map((item) => (
                  <NavRow
                    key={item.to}
                    item={item}
                    collapsed
                    onNavigate={collapseRail}
                  />
                ))}
              </div>
            ) : (
              <div className="space-y-4">
                <div className="space-y-0.5">
                  <h3 className={`${sectionHeader} px-3 pt-1 pb-1`}>Mesh</h3>
                  {MESH_NAV.map((item) => (
                    <NavRow
                      key={item.to}
                      item={item}
                      collapsed={false}
                      onNavigate={collapseRail}
                    />
                  ))}
                </div>
                <div className="space-y-0.5">
                  <h3 className={`${sectionHeader} px-3 pt-1 pb-1`}>Tools</h3>
                  {tools.map((t, i) => (
                    <ExternalRow
                      key={`tool-${i}`}
                      link={t}
                      collapsed={false}
                      onNavigate={collapseRail}
                    />
                  ))}
                </div>
                <div className="space-y-0.5">
                  <h3 className={`${sectionHeader} px-3 pt-1 pb-1`}>
                    Meshtastic Addons
                  </h3>
                  {addons.map((t, i) => (
                    <ExternalRow
                      key={`addon-${i}`}
                      link={t}
                      collapsed={false}
                      onNavigate={collapseRail}
                    />
                  ))}
                </div>
              </div>
            )}
          </nav>

          {/* Footer — version, GitHub stars, theme toggle */}
          <div className="shrink-0 border-t border-gray-200 dark:border-white/10 p-3">
            {collapsed ? (
              <div className="flex flex-col items-center gap-1">
                <ThemeToggle isDark={isDark} onToggle={handleDarkChange} />
                <a
                  href={GITHUB_URL}
                  target="_blank"
                  rel="noreferrer"
                  title="MeshInfo on GitHub"
                  aria-label="MeshInfo on GitHub"
                  className="flex items-center justify-center w-9 h-9 rounded-lg text-gray-500 hover:text-gray-800 dark:text-gray-400 dark:hover:text-gray-100 hover:bg-gray-500/10 dark:hover:bg-gray-700/50 transition-colors"
                >
                  <GitHubIcon className="w-5 h-5" />
                </a>
              </div>
            ) : (
              <div className="flex items-end justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    Powered by MeshInfo{" "}
                    <span className="text-gray-400 dark:text-gray-500">
                      {config?.server?.version_info?.refName}
                    </span>
                  </div>
                  <a
                    href={GITHUB_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1.5 inline-block"
                  >
                    <img
                      src="https://img.shields.io/github/stars/MeshAddicts/meshinfo?style=social"
                      alt="GitHub Stars"
                    />
                  </a>
                </div>
                <ThemeToggle isDark={isDark} onToggle={handleDarkChange} />
              </div>
            )}
          </div>
        </aside>
    </>
  );
};
