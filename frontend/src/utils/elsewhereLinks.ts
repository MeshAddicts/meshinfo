import type { ElsewhereLink } from "../types/config";

export const defaultElsewhereLinks: ElsewhereLink[] = [
  { name: "Armooo's MeshView", url: "https://meshview.armooo.net/packet_list/{node_id_int}" },
  { name: "Bay Mesh Explorer", url: "https://app.bayme.sh/node/{node_id_hex}" },
  { name: "Liam's Map", url: "https://meshtastic.liamcottle.net/?node_id={node_id_int}" },
  { name: "MeshMap", url: "https://meshmap.net/#{node_id_int}" },
];

export function resolveElsewhereUrl(
  urlTemplate: string,
  nodeIdHex: string,
  nodeIdInt: number
): string {
  return urlTemplate
    .replace("{node_id_hex}", nodeIdHex)
    .replace("{node_id_int}", String(nodeIdInt));
}
