import { useLocation } from "react-router-dom";

import { Menu } from "./Menu";

export const Layout = ({ children }: { children: React.ReactNode }) => {
  const { pathname } = useLocation();

  return (
    <>
      <Menu />

      <div
        className={`lg:pl-60 ${pathname === "/map" ? "h-screen" : ""} sm:pt-14 md:pt-14 lg:pt-0`}
      >
        <main className={`${pathname === "/map" ? "h-screen" : "py-1 "}`}>
          <div
            className={`w-full ${pathname === "/map" ? "h-screen" : "px-4 py-2 sm:px-6 sm:py-2 lg:px-6 lg:py-2"}`}
          >
            {children}
          </div>
        </main>
      </div>
    </>
  );
};
