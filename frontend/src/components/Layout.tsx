import { useEffect, useState } from "react";
import { useLocation } from "react-router";

import { Menu } from "./Menu";

export const Layout = ({ children }: { children: React.ReactNode }) => {
  const { pathname } = useLocation();
  const [isDark, setIsDark] = useState(false);
  const [navCollapsed, setNavCollapsed] = useState(() => {
    try {
      return localStorage.getItem("meshinfo.nav.collapsed") === "1";
    } catch {
      return false;
    }
  });

  const toggleNav = () =>
    setNavCollapsed((c) => {
      const next = !c;
      try {
        localStorage.setItem("meshinfo.nav.collapsed", next ? "1" : "0");
      } catch {
        // ignore storage failures (private mode, etc.)
      }
      return next;
    });

  // Single source of truth for the rail width + content offset (see index.css
  // .nav-offset). The rail reads the same var so the two never drift.
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--nav-w",
      navCollapsed ? "4.5rem" : "15rem",
    );
  }, [navCollapsed]);

  const isMap = pathname === "/map";
  const isChat = pathname === "/chat";
  const isLog = pathname === "/log" || pathname === "/logs";
  const isTraceroutes = pathname === "/traceroutes";
  const isTelemetry = pathname === "/telemetry";
  const isNodes = pathname === "/nodes";
  const isNeighbors = pathname === "/neighbors";
  const isStats = pathname === "/stats";

const isFullBleed = isMap || isChat || isLog || isTraceroutes || isTelemetry || isNodes || isNeighbors || isStats;

  // make sure the root element is updated with the dark class
  //  move this out eventually
  useEffect(() => {
    if (isDark) {
      document.documentElement.classList.add("dark", "bg-gray-950");
    } else {
      document.documentElement.classList.remove("dark", "bg-gray-950");
    }
  }, [isDark]);

  useEffect(() => {
    // set the initial state of the theme based on the user's preference
    if (
      window.matchMedia &&
      window.matchMedia("(prefers-color-scheme: dark)").matches &&
      localStorage.getItem("theme") !== "light"
    ) {
      setIsDark(true);
    }

    const handleColorSchemeChange = (event: MediaQueryListEvent) => {
      // if there is a theme set in local storage, don't change the theme
      if (
        localStorage.getItem("theme") === "light" ||
        localStorage.getItem("theme") === "dark"
      )
        return;

      // else set the theme based on the event change
      if (event.matches) {
        setIsDark(true);
      } else {
        setIsDark(false);
      }
    };

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", handleColorSchemeChange);

    // Clean up the event listener
    return () => {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .removeEventListener("change", handleColorSchemeChange);
    };
  }, []);

  return (
    <div className={isFullBleed ? "h-dvh overflow-hidden" : ""}>
      <Menu
        isDark={isDark}
        onDarkChange={(dark) => setIsDark(dark)}
        overlayMode={isMap}
        collapsed={navCollapsed}
        onCollapseToggle={toggleNav}
      />

      <div
        className={`${isMap ? "" : "nav-offset"} dark:bg-gray-950 dark:text-gray-100 lg:pt-0
          ${isFullBleed ? "pt-0 h-full overflow-hidden" : "pt-14"}`}
      >
        <main className={isFullBleed ? "h-full" : "py-1"}>
          <div
            className={`w-full ${
              isFullBleed ? "h-full" : "px-4 py-2 sm:px-6 sm:py-2 lg:px-6 lg:py-2"
            }`}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};