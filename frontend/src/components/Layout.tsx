import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";

import { Menu } from "./Menu";

export const Layout = ({ children }: { children: React.ReactNode }) => {
  const { pathname } = useLocation();
  const [isDark, setIsDark] = useState(false);

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
    <div>
      <Menu isDark={isDark} onDarkChange={(dark) => setIsDark(dark)} />

      <div
        className={`lg:pl-60 dark:bg-gray-950 dark:text-gray-100 ${pathname === "/map" ? "h-screen" : ""} pt-14 lg:pt-0`}
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
