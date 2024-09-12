import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import { Menu } from "./Menu";

export const Layout = ({ children }: { children: React.ReactNode }) => {
  const { pathname } = useLocation();
  const [isDark, setIsDark] = useState(false);

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
    <div className={isDark ? "dark" : ""}>
      <Menu isDark={isDark} onDarkChange={(dark) => setIsDark(dark)} />

      <div
        className={`lg:pl-60 dark:bg-gray-950 dark:text-gray-100 ${pathname === "/map" ? "h-screen" : ""} sm:pt-14 md:pt-14 lg:pt-0`}
      >
        <main className={`${pathname === "/map" ? "h-screen" : "py-1 "}`}>
          <div
            className={`w-full ${pathname === "/map" ? "h-screen" : "px-4 py-2 sm:px-6 sm:py-2 lg:px-6 lg:py-2"}`}
          >
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};
