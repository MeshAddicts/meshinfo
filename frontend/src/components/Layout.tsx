import { Link, useLocation } from "react-router-dom";

import { useGetConfigQuery } from "../slices/apiSlice";

export const Layout = ({ children }: { children: React.ReactNode }) => {
  const { pathname } = useLocation();
  const { data: config } = useGetConfigQuery();

  return (
    <>
      <div className="hidden lg:fixed lg:inset-y-0 lg:z-50 lg:flex lg:w-60 lg:flex-col">
        <div className="flex flex-col px-6 pb-4 overflow-y-auto bg-gray-300 border-r-2 grow gap-y-5 border-r-cyan-600">
          <div className="flex items-center h-24 mt-4 shrink-0">
            <div className="text-2xl">
              <div className="p-0 m-0">
                S<span className="text-gray-500">ACRAMENTO</span>
              </div>
              <div className="p-0 m-0">
                V<span className="text-gray-500">ALLEY</span>
              </div>
              <div className="p-0 m-0">
                M<span className="text-gray-500">ESH</span>
              </div>
            </div>
          </div>

          <div>{config?.mesh.description}</div>

          <div>
            <a href={config?.mesh.url} className="text-xs text-gray-900">
              Website
            </a>
          </div>

          <nav className="flex flex-col flex-1">
            <h3 className="font-bold">Mesh</h3>
            <div className="mb-1">
              <Link to="chat" relative="path">
                <img
                  src="/next/images/icons/chat.svg"
                  width="20"
                  height="20"
                  className="inline-block"
                  alt="chat icon"
                  style={{ verticalAlign: "middle" }}
                />
                Chat
              </Link>
            </div>
            {/* TODO <div className="mb-1">
              <Link to="graph" relative="path">
                <img
                  src="/next/images/icons/map.svg"
                  width="20"
                  height="20"
                  className="inline-block"
                  alt="graph icon"
                  style={{ verticalAlign: "middle" }}
                />
                Graph
              </Link>
            </div> */}
            <div className="mb-1">
              <Link to="map">
                <img
                  src="/next/images/icons/map.svg"
                  width="20"
                  height="20"
                  className="inline-block"
                  alt="map icon"
                  style={{ verticalAlign: "middle" }}
                />
                Map
              </Link>
            </div>
            <div className="mb-1">
              <Link to="nodes">
                <img
                  src="/next/images/icons/node.svg"
                  width="20"
                  height="20"
                  className="inline-block"
                  alt="node icon"
                  style={{ verticalAlign: "middle" }}
                />
                Nodes
              </Link>
            </div>
            <div className="mb-1">
              <Link to="neighbors" relative="path">
                <img
                  src="/next/images/icons/neighbors.svg"
                  width="20"
                  height="20"
                  className="inline-block"
                  alt="neighbors icon"
                  style={{ verticalAlign: "middle" }}
                />
                Node Neighbors
              </Link>
            </div>
            <div className="mb-1">
              <Link to="stats" relative="path">
                <img
                  src="/next/images/icons/stats.svg"
                  width="20"
                  height="20"
                  className="inline-block"
                  alt="stats icon"
                  style={{ verticalAlign: "middle" }}
                />
                Stats
              </Link>
            </div>
            <div className="mb-1">
              <Link to="telemetry" relative="path">
                <img
                  src="/next/images/icons/telemetry.svg"
                  width="20"
                  height="20"
                  className="inline-block"
                  alt="telemetry icon"
                  style={{ verticalAlign: "middle" }}
                />
                Telemetry
              </Link>
            </div>
            <div className="mb-1">
              <Link to="traceroutes">
                <img
                  src="/next/images/icons/route2.svg"
                  width="20"
                  height="20"
                  className="inline-block"
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
              <Link to="mesh-log">Mesh Messages</Link>
            </div>
            <div className="mb-1">
              <Link to="mqtt-log">MQTT Messages</Link>
            </div>
          </nav>

          <nav className="flex flex-col flex-1">
            <h3 className="font-bold">Tools</h3>
            {config?.mesh.tools.map((tool, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <div key={`tools-${index}`} className="mb-1">
                <a href={tool.url} target="_blank" rel="noopener noreferrer">
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
              >
                DopeWars
              </a>
            </div>
            <div className="mb-1">
              <a
                href="https://github.com/TheCommsChannel/TC2-BBS-mesh"
                target="_blank"
                rel="noreferrer"
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
              {/* TODO <span className="text-xs text-gray-500">
                {config?.server.version_info.ref_name}
              </span> */}
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

      <div className={`lg:pl-60 ${pathname === "/map" ? "h-screen" : ""} `}>
        <main className={`py-1 ${pathname === "/map" ? "h-screen" : ""} `}>
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
