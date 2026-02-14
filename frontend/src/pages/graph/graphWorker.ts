/**
 * graphWorker.ts — Force simulation with auto-stabilization.
 * Runs physics for up to maxTicks, progressively increasing damping.
 * Auto-stops when total kinetic energy drops below threshold.
 * After stopping, nodes stay put — no jittering.
 */

type WorkerNode = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned: boolean;
};

type WorkerEdge = { a: string; b: string; w: number };

type InMessage =
  | { type: "init"; nodes: WorkerNode[]; edges: WorkerEdge[] }
  | { type: "updateNode"; id: string; x: number; y: number; pinned?: boolean }
  | { type: "togglePin"; id: string }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "reheat" }
  | { type: "stop" };

let nodes: WorkerNode[] = [];
let nodeMap = new Map<string, WorkerNode>();
let edges: WorkerEdge[] = [];
let running = false;
let paused = false;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let tickCount = 0;
let settled = false;

const MAX_TICKS = 400;
const SETTLE_THRESHOLD = 0.3; // avg velocity per node below this = settled

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function tick() {
  if (!running || paused || settled) return;

  tickCount++;

  // Progressive cooling: damping increases as simulation runs
  const progress = Math.min(1, tickCount / MAX_TICKS);
  const damping = 0.85 + progress * 0.12; // 0.85 → 0.97
  const coolingFactor = Math.max(0.05, 1 - progress * 0.9); // 1.0 → 0.1

  const gridSize = 200;
  const grid = new Map<string, WorkerNode[]>();

  for (const n of nodes) {
    const gx = Math.floor(n.x / gridSize);
    const gy = Math.floor(n.y / gridSize);
    const k = `${gx},${gy}`;
    const arr = grid.get(k);
    if (arr) arr.push(n);
    else grid.set(k, [n]);
  }

  const repK = 18000 * coolingFactor;
  const springK = 0.003 * coolingFactor;
  const springLen = 220;
  const centerK = 0.0002;
  const maxV = 12 * coolingFactor;

  // Repulsion
  for (const n of nodes) {
    if (n.pinned) continue;

    const gx = Math.floor(n.x / gridSize);
    const gy = Math.floor(n.y / gridSize);
    let fx = 0, fy = 0;

    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        const cell = grid.get(`${gx + ox},${gy + oy}`);
        if (!cell) continue;
        for (const m of cell) {
          if (m === n) continue;
          const dx = n.x - m.x, dy = n.y - m.y;
          const d2 = dx * dx + dy * dy + 0.01;
          const f = repK / d2;
          fx += dx * f;
          fy += dy * f;
        }
      }
    }

    fx += -n.x * centerK;
    fy += -n.y * centerK;
    n.vx = clamp((n.vx + fx) * damping, -maxV, maxV);
    n.vy = clamp((n.vy + fy) * damping, -maxV, maxV);
  }

  // Springs
  for (const e of edges) {
    const a = nodeMap.get(e.a), b = nodeMap.get(e.b);
    if (!a || !b) continue;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.sqrt(dx * dx + dy * dy) + 1e-6;
    const t = (dist - springLen) * springK * (1 + Math.min(2, e.w * 0.15));
    const fx = (dx / dist) * t, fy = (dy / dist) * t;
    if (!a.pinned) { a.vx += fx; a.vy += fy; }
    if (!b.pinned) { b.vx -= fx; b.vy -= fy; }
  }

  // Integration
  let totalV = 0;
  for (const n of nodes) {
    if (n.pinned) continue;
    n.x += n.vx;
    n.y += n.vy;
    totalV += Math.abs(n.vx) + Math.abs(n.vy);
  }

  const avgV = nodes.length > 0 ? totalV / nodes.length : 0;

  // Send positions
  const positions = nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
  (self as unknown as Worker).postMessage({
    type: "tick",
    positions,
    tickCount,
    avgVelocity: avgV,
    settled: false,
  });

  // Check if settled
  if (tickCount >= MAX_TICKS || (tickCount > 50 && avgV < SETTLE_THRESHOLD)) {
    settled = true;
    // Send one final tick with settled flag
    (self as unknown as Worker).postMessage({
      type: "tick",
      positions,
      tickCount,
      avgVelocity: avgV,
      settled: true,
    });
    return; // Stop ticking
  }

  tickTimer = setTimeout(tick, tickCount < 50 ? 16 : 33); // faster at start, slower later
}

self.onmessage = (e: MessageEvent<InMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case "init":
      nodes = msg.nodes;
      edges = msg.edges;
      nodeMap = new Map(nodes.map((n) => [n.id, n]));
      running = true;
      paused = false;
      settled = false;
      tickCount = 0;
      if (tickTimer) clearTimeout(tickTimer);
      tick();
      break;

    case "updateNode": {
      const n = nodeMap.get(msg.id);
      if (n) {
        n.x = msg.x; n.y = msg.y; n.vx = 0; n.vy = 0;
        if (msg.pinned !== undefined) n.pinned = msg.pinned;
      }
      // If settled, send updated positions
      if (settled) {
        const positions = nodes.map((n) => ({ id: n.id, x: n.x, y: n.y }));
        (self as unknown as Worker).postMessage({ type: "tick", positions, tickCount, avgVelocity: 0, settled: true });
      }
      break;
    }

    case "togglePin": {
      const n = nodeMap.get(msg.id);
      if (n) { n.pinned = !n.pinned; if (n.pinned) { n.vx = 0; n.vy = 0; } }
      break;
    }

    case "reheat": {
      // Re-run simulation (e.g. after user drags a node and wants it to re-settle)
      settled = false;
      tickCount = Math.max(0, tickCount - 100); // partial reheat
      if (running && !paused && !tickTimer) tick();
      break;
    }

    case "pause":
      paused = true;
      if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
      break;

    case "resume":
      paused = false;
      if (running && !settled && !tickTimer) tick();
      break;

    case "stop":
      running = false;
      settled = true;
      if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
      break;
  }
};