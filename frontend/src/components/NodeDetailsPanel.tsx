import { Coordinate } from "ol/coordinate";

import { IMapNode } from "../pages/Map";
import { useGetNodeQuery, useGetReverseGeocodeQuery } from "../slices/apiSlice";
import { convertNodeIdFromHexToInt } from "../utils/convertNodeId";

const NeighborsTableRow = ({
  neighbor,
}: {
  neighbor: Required<IMapNode>["neighbors"][0];
}) => {
  const { data: node } = useGetNodeQuery(neighbor.id);

  return (
    <tr>
      <td align="left">{node?.shortname}</td>
      <td align="center">{neighbor.snr}</td>
      <td align="right">{neighbor.distance} km</td>
    </tr>
  );
};

const NeighborsTable = ({ neighbors }: { neighbors: IMapNode[] }) => (
  <table
    border={1}
    cellPadding="2"
    cellSpacing="0"
    width="100%"
    className="border border-gray-300"
  >
    <tbody>
      <tr>
        <th width="33%" align="left">
          Node
        </th>
        <th width="33%" align="center">
          SNR
        </th>
        <th width="33%" align="right">
          Distance
        </th>
      </tr>
      {neighbors.map((neighbor) => (
        <NeighborsTableRow key={neighbor.id} neighbor={neighbor} />
      ))}
    </tbody>
  </table>
);

export const NodeDetailsPanel = ({
  node,
}: {
  node: IMapNode & { position: Coordinate };
}) => {
  const { data: address } = useGetReverseGeocodeQuery({
    lon: node.position[0].toString(),
    lat: node.position[1].toString(),
  });

  return (
    <div
      id="details"
      className="p-4 bg-white dark:bg-black z-40 absolute top-2.5 right-2.5 max-h-full overflow-y-auto"
    >
      <div className="flex items-center w-full justify-items-stretch">
        <div id="details-title" className="flex-auto text-lg text-start">
          {node.longname}
        </div>
        <div id="details-subtitle" className="flex-auto ml-4 text-sm text-end">
          {node.shortname}
        </div>
      </div>
      <div id="details-content" className="align-items-center">
        <b>{node.longname}</b>
        <br />
        {node.shortname} / {node.id}
        <br />
        <br />
        <b>Position</b>
        <br />
        {node.position[0]}, {node.position[1]}
        <br />
        <br />
        <b>Location</b>
        <br />
        {address?.address?.town}, {address?.address?.county},{" "}
        {address?.address?.state}, {address?.address?.country}
        <br />
        <br />
        <b>Status</b>
        <br />
        Offline
        <br />
        <br />
        <b>Last Seen</b>
        <br />
        2024-09-16T23:23:07.183898-07:00
        <br />
        <br />
        <b>Neighbors Heard</b>
        <br />
        <NeighborsTable neighbors={node.neighbors ?? []} />
        <br />
        <br />
        <b>Heard By Neighbors</b>
        <br />
        {/* <NeighborsTable neighbors={[]} /> */}
        <br />
        <b>Elsewhere</b>
        <br />
        <a
          className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
          href={`https://meshview.armooo.net/packet_list/${convertNodeIdFromHexToInt(node.id)}`}
          target="_blank"
          rel="noreferrer"
        >
          Armooo&apos;s MeshView
        </a>
        <br />
        <a
          className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
          href={`https://app.bayme.sh/node/${node.id}`}
          target="_blank"
        >
          Bay Mesh Explorer
        </a>
        <br />
        <a
          className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
          href={`https://meshtastic.liamcottle.net/?node_id=${convertNodeIdFromHexToInt(node.id)}`}
          target="_blank"
        >
          Liam's Map
        </a>
        <br />
        <a
          className="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500"
          href={`https://meshmap.net/#${convertNodeIdFromHexToInt(node.id)}`}
          target="_blank"
        >
          MeshMap
        </a>
        <br />
      </div>
    </div>
  );
};

//       const address = await reverseGeocode(
//         node.position[0].toString(),
// //         node.position[1].toString()
// //       );
// //       const displayName = [
// //         address.address?.town,
// //         address.address?.city,
// //         address.address?.county,
// //         address.address?.state,
// //         address.address?.country,
// //       ]
// //         .filter(Boolean)
// //         .join(", ");

// //       let panel =
// //         `<b>${node.longname}</b><br/>${node.shortname} / ${
// //           node.id
// //         }<br/><br/>` +
// //         `<b>Position</b><br/>${node.position}<br/><br/>` +
// //         `<b>Location</b><br/>${displayName}<br/><br/>` +
// //         `<b>Status</b><br/>${
// //           node.online ? "Online" : "Offline"
// //         }<br/><br/>` +
// //         `<b>Last Seen</b><br/>${node.last_seen}<br/><br/>`;

// //       panel += "<b>Neighbors Heard</b><br/>";
// //       if (node.neighbors?.length === 0) {
// //         panel += "None";
// //       } else {
// //         panel +=
// //           "<table border=1 cellpadding=2 cellspacing=0 width=100% class='border border-gray-300'>";
// //         panel +=
// //           "<tr><th width=33% align=left>Node</th><th width=33% align=center>SNR</th><th width=33% align=right>Distance</th></tr>";
// //         panel += (node.neighbors ?? [])
// //           .map((neighbor) => {
// //             const nnode = nodes[neighbor.id];
// //             if (!nnode) {
// //               return `<tr><td class="text-gray-600">UNK</td><td align=center>${
// //                 neighbor.snr
// //               }</td><td></td></tr>`;
// //             }
// //             let distance;
// //             if (nnode.position) {
// //               distance =
// //                 Math.sqrt(
// //                   (node.position[0] - nnode.position[0]) ** 2 +
// //                     (node.position[1] - nnode.position[1]) ** 2
// //                 ) * 111.32;
// //             }
// //             return `<tr><td align=left>${
// //               nnode.shortname
// //             }</td><td align=center>${
// //               neighbor.snr
// //             }</td><td align=right>${distance ? distance.toFixed(2) : "unk"} km</td></tr>`;
// //           })
// //           .join("");
// //         panel += "</table>";

// //         node.neighbors?.forEach((neighbor) => {
// //           const nnode = nodes[neighbor.id];
// //           if (!nnode || !nnode.position) {
// //             return;
// //           }
// //           const points = [node.position, nnode.position];

// //           // eslint-disable-next-line no-plusplus
// //           for (let i = 0; i < points.length; i++) {
// //             points[i] = transform(points[i], "EPSG:4326", "EPSG:3857");
// //           }

// //           const featureLine = new Feature({
// //             geometry: new LineString(points),
// //           });

// //           const vectorLine = new Vector({});
// //           vectorLine.addFeature(featureLine);

// //           const vectorLineLayer = new VectorLayer({
// //             source: vectorLine,
// //             style: new Style({
// //               fill: new Fill({ color: "#66FF66" }),
// //               stroke: new Stroke({ color: "#66FF66", width: 4 }),
// //             }),
// //           });
// //           neighborLayers.push(vectorLineLayer);
// //           olMap.addLayer(vectorLineLayer);
// //         });
// //       }
// //       panel += "<br/><br/>";

// //       panel += "<b>Heard By Neighbors</b><br/>";
// //       const heardBy = Object.keys(nodes).filter((id) =>
// //         nodes[id].neighbors?.some((neighbor) => neighbor.id === node.id)
// //       );
// //       if (heardBy.length === 0) {
// //         panel += "None<br/>";
// //       } else {
// //         panel +=
// //           "<table border=1 cellpadding=2 cellspacing=0 width=100% class='border border-gray-300'>";
// //         panel +=
// //           "<tr><th width=33% align=left>Node</th><th width=33% align=center>SNR</th><th width=33% align=right>Distance</th></tr>";
// //         panel += heardBy
// //           .map((id) => {
// //             const nnode = nodes[id];
// //             const neighbor = nnode?.neighbors?.find(
// //               (n) => n.id === node.id
// //             );
// //             if (!nnode) {
// //               return `<tr><td class="text-gray-600">UNK</td><td align=center>${
// //                 neighbor?.snr
// //               }</td><td></td></tr>`;
// //             }
// //             let distance;

// //             if (nnode.position) {
// //               distance =
// //                 Math.sqrt(
// //                   (node.position[0] - nnode.position[0]) ** 2 +
// //                     (node.position[1] - nnode.position[1]) ** 2
// //                 ) * 111.32;
// //             }
// //             // calculate distance between two nodes without using ol.sphere
// //             return `<tr><td align=left>${
// //               nnode.shortname
// //             }</td><td align=center>${
// //               neighbor?.snr
// //             }</td><td align=right>${distance ? distance.toFixed(2) : "unk"} km</td></tr>`;
// //           })
// //           .join("");
// //         panel += "</table>";

// //         // add the heard_by lines
// //         heardBy.forEach((id) => {
// //           const nnode = nodes[id];
// //           if (!nnode || !nnode.position) {
// //             return;
// //           }
// //           const points = [node.position, nnode.position];

// //           // eslint-disable-next-line no-plusplus
// //           for (let i = 0; i < points.length; i++) {
// //             points[i] = transform(points[i], "EPSG:4326", "EPSG:3857");
// //           }

// //           const featureLine = new Feature({
// //             geometry: new LineString(points),
// //           });

// //           const vectorLine = new Vector({});
// //           vectorLine.addFeature(featureLine);

// //           let lineStyle = new Style({
// //             fill: new Fill({ color: "#6666FF" }),
// //             stroke: new Stroke({ color: "#6666FF", width: 4 }),
// //           });

// //           // if the nnode is also a neighbor of the node, make the line purple
// //           if (node.neighbors?.some((neighbor) => neighbor.id === id)) {
// //             lineStyle = new Style({
// //               fill: new Fill({ color: "#FF66FF" }),
// //               stroke: new Stroke({ color: "#FF66FF", width: 4 }),
// //             });
// //           }

// //           const vectorLineLayer = new VectorLayer({
// //             source: vectorLine,
// //             style: lineStyle,
// //           });
// //           neighborLayers.push(vectorLineLayer);
// //           olMap.addLayer(vectorLineLayer);
// //         });
// //       }

// //       panel += "<br/>";

// //       panel += "<b>Elsewhere</b><br/>";
// //       const nodeId = parseInt(node.id, 16);
// //       panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshview.armooo.net/packet_list/${
// //         nodeId
// //       }" target="_blank">Armooo's MeshView</a><br/>`;
// //       panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://app.bayme.sh/node/${
// //         node.id
// //       }" target="_blank">Bay Mesh Explorer</a><br/>`;
// //       panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://meshtastic.liamcottle.net/?node_id=${
// //         nodeId
// //       }" target="_blank">Liam's Map</a><br/>`;
// //       panel += `<a class="dark:text-indigo-400 dark:visited:text-indigo-400 dark:hover:text-indigo-500" href="https://mesholMapnet/#${
// //         nodeId
// //       }" target="_blank">MeshMap</a><br/>`;

// //       nodeTitle.innerHTML = node.longname;
// //       nodeSubtitle.innerHTML = node.shortname;
// //       nodeContent.innerHTML = panel;
// //       nodePanel.classList.remove("hidden");
// //     } else {
// //       // content.innerHTML = '<b>Unknown</b>';
// //       // overlay.setPosition(coordinate);

// //       nodeTitle.innerHTML = "Unknown";
// //       nodeSubtitle.innerHTML = "UNK";
// //       nodeContent.innerHTML = "";
// //       nodePanel.classList.remove("hidden");
// //     }
// //   } else {
// //     if (nodeTitle) {
// //       nodeTitle.innerHTML = "";
// //     }
// //     if (nodeSubtitle) {
// //       nodeSubtitle.innerHTML = "";
// //     }
// //     if (nodeContent) {
// //       nodeContent.innerHTML = "";
// //     }
// //   }
// // });
