/** Packet `type` → RGB 0..1, shared by the arc shader and the legend. */
export const PACKET_TYPE_COLORS: Record<string, [number, number, number]> = {
  text: [0.196, 0.941, 0.196], // green
  text_binary: [0.4, 0.78, 0.4],
  position: [0.23, 0.6, 0.98], // blue
  telemetry: [0.95, 0.66, 0.13], // amber
  nodeinfo: [0.66, 0.33, 0.97], // purple
  neighborinfo: [0.08, 0.72, 0.65], // teal
  traceroute: [0.93, 0.27, 0.27], // red
  routing: [0.85, 0.82, 0.3], // yellow
  mapreport: [0.35, 0.8, 0.92], // cyan
};

/** Unknown/unhandled portnums. */
export const PACKET_TYPE_FALLBACK: [number, number, number] = [0.6, 0.62, 0.7];

export function packetColor(type: string | undefined): [number, number, number] {
  return (type != null && PACKET_TYPE_COLORS[type]) || PACKET_TYPE_FALLBACK;
}

/** Same color as the arc shader, as a CSS string for the legend swatches. */
export function packetColorCss(type: string | undefined): string {
  const [r, g, b] = packetColor(type);
  return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

/** Packet types shown in the legend key (order = legend order). */
export const PACKET_TYPE_LABELS: { type: string; label: string }[] = [
  { type: "text", label: "Text" },
  { type: "position", label: "Position" },
  { type: "telemetry", label: "Telemetry" },
  { type: "nodeinfo", label: "Node info" },
  { type: "neighborinfo", label: "Neighbor" },
  { type: "traceroute", label: "Traceroute" },
  { type: "routing", label: "Routing" },
  { type: "mapreport", label: "Map report" },
];
