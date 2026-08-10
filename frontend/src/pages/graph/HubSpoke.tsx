import React, { useEffect, useMemo,useRef, useState } from "react";

import { clamp,type GraphEdge, type GraphNode, roleColor } from "./graphUtils";

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

type LayoutNode = {
  id: string;
  x: number;
  y: number;
  ring: number; // 0=hub, 1=direct, 2=outer
};

export const HubSpoke: React.FC<Props> = ({ nodes, edges, nodeById, selectedId, onSelect }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });

  // Resize
  useEffect(() => {
    const wrap = wrapRef.current, canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ro = new ResizeObserver(() => {
      const r = wrap.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(r.width * dpr);
      canvas.height = Math.floor(r.height * dpr);
      canvas.style.width = `${r.width}px`;
      canvas.style.height = `${r.height}px`;
      setDims({ w: r.width, h: r.height });
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Compute layout
  const { layoutNodes, layoutById } = useMemo(() => {
    if (nodes.length === 0) return { layoutNodes: [], layoutById: new Map<string, LayoutNode>() };

    const cx = dims.w / 2, cy = dims.h / 2;
    const maxR = Math.min(cx, cy) - 10;

    // Pick top hubs (degree > median, max 12)
    const medianDeg = nodes.length > 2 ? nodes[Math.floor(nodes.length / 2)].degree : 0;
    const hubThreshold = Math.max(medianDeg + 1, 5);
    const hubs = nodes.filter((n) => n.degree >= hubThreshold).slice(0, 12);
    const hubIds = new Set(hubs.map((h) => h.id));

    // Find direct connections of hubs
    const directIds = new Set<string>();
    for (const e of edges) {
      if (hubIds.has(e.a) && !hubIds.has(e.b)) directIds.add(e.b);
      if (hubIds.has(e.b) && !hubIds.has(e.a)) directIds.add(e.a);
    }

    // Everyone else
    const outerIds = new Set<string>();
    for (const n of nodes) {
      if (!hubIds.has(n.id) && !directIds.has(n.id)) outerIds.add(n.id);
    }

    const result: LayoutNode[] = [];

    // Ring 0: Hubs in a circle
    const hubR = maxR * 0.22;
    hubs.forEach((h, i) => {
      const ang = (i / Math.max(1, hubs.length)) * Math.PI * 2 - Math.PI / 2;
      result.push({ id: h.id, x: cx + Math.cos(ang) * hubR, y: cy + Math.sin(ang) * hubR, ring: 0 });
    });

    // Ring 1: Direct connections
    const directArr = Array.from(directIds).map((id) => nodeById.get(id)!).filter(Boolean);
    directArr.sort((a, b) => b.degree - a.degree);
    const ring1R = maxR * 0.58;
    directArr.forEach((n, i) => {
      const ang = (i / Math.max(1, directArr.length)) * Math.PI * 2 - Math.PI / 2;
      result.push({ id: n.id, x: cx + Math.cos(ang) * ring1R, y: cy + Math.sin(ang) * ring1R, ring: 1 });
    });

    // Ring 2: Outer nodes
    const outerArr = Array.from(outerIds).map((id) => nodeById.get(id)!).filter(Boolean);
    outerArr.sort((a, b) => b.degree - a.degree);
    const ring2R = maxR * 0.92;
    outerArr.forEach((n, i) => {
      const ang = (i / Math.max(1, outerArr.length)) * Math.PI * 2 - Math.PI / 2;
      result.push({ id: n.id, x: cx + Math.cos(ang) * ring2R, y: cy + Math.sin(ang) * ring2R, ring: 2 });
    });

    const byId = new Map(result.map((ln) => [ln.id, ln]));
    return { layoutNodes: result, layoutById: byId };
  }, [nodes, edges, nodeById, dims]);

  // Draw
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || layoutNodes.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dims.w, dims.h);

    const cx = dims.w / 2, cy = dims.h / 2;
    const maxR = Math.min(cx, cy) - 10;

    // Ring guides
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1;
    for (const r of [0.22, 0.58, 0.92]) {
      ctx.beginPath(); ctx.arc(cx, cy, maxR * r, 0, Math.PI * 2); ctx.stroke();
    }

    // Edges
    for (const e of edges) {
      const la = layoutById.get(e.a), lb = layoutById.get(e.b);
      if (!la || !lb) continue;

      const isSel = selectedId && (e.a === selectedId || e.b === selectedId);
      const isHov = hoverId && (e.a === hoverId || e.b === hoverId);

      ctx.globalAlpha = isSel ? 0.6 : isHov ? 0.4 : 0.04;
      ctx.strokeStyle = isSel ? "#ffffff" : isHov ? "#e2e8f0" : e.kind === "neighbor" ? "#94a3b8" : "#60a5fa";
      ctx.lineWidth = isSel ? 1.5 : 0.5;
      ctx.setLineDash(e.kind === "traceroute" && !isSel && !isHov ? [3, 3] : []);

      ctx.beginPath(); ctx.moveTo(la.x, la.y); ctx.lineTo(lb.x, lb.y); ctx.stroke();
    }
    ctx.setLineDash([]);

    // Nodes
    for (const ln of layoutNodes) {
      const gn = nodeById.get(ln.id);
      if (!gn) continue;

      const isSel = ln.id === selectedId;
      const isHov = ln.id === hoverId;
      const r = ln.ring === 0 ? clamp(5 + gn.degree * 0.12, 6, 20) : ln.ring === 1 ? clamp(3 + gn.degree * 0.08, 3, 10) : 2.5;

      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(ln.x, ln.y, isSel ? r + 2 : isHov ? r + 1 : r, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? "#ffffff" : isHov ? "#e2e8f0" : roleColor(gn.role);
      ctx.fill();

      if (isSel || isHov) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "rgba(255,255,255,0.5)";
        ctx.stroke();
      }

      // Label for hubs
      if (ln.ring === 0) {
        ctx.globalAlpha = 0.9;
        ctx.font = "bold 11px ui-sans-serif, system-ui, sans-serif";
        ctx.fillStyle = "#e2e8f0";
        ctx.textAlign = "center";
        ctx.fillText(gn.label, ln.x, ln.y - r - 5);
      }
    }

    // Hover label
    if (hoverId && hoverId !== selectedId) {
      const ln = layoutById.get(hoverId);
      const gn = nodeById.get(hoverId);
      if (ln && gn) {
        const text = `${gn.label} \u2022 ${gn.degree} links`;
        ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
        const tw = ctx.measureText(text).width;
        const bx = clamp(ln.x - tw / 2 - 6, 4, dims.w - tw - 16);
        const by = ln.y - 24;
        ctx.globalAlpha = 0.9; ctx.fillStyle = "rgba(15,23,42,0.92)";
        ctx.fillRect(bx, by, tw + 12, 20);
        ctx.globalAlpha = 1; ctx.fillStyle = "#e2e8f0";
        ctx.textAlign = "left";
        ctx.fillText(text, bx + 6, by + 14);
      }
    }
  }, [layoutNodes, layoutById, edges, nodeById, dims, selectedId, hoverId]);

  // Interaction
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pick = (sx: number, sy: number): string | null => {
      let best: { id: string; d2: number } | null = null;
      for (const ln of layoutNodes) {
        const dx = ln.x - sx, dy = ln.y - sy;
        const d2 = dx * dx + dy * dy;
        const r = ln.ring === 0 ? 20 : ln.ring === 1 ? 12 : 8;
        if (d2 <= r * r && (!best || d2 < best.d2)) best = { id: ln.id, d2 };
      }
      return best?.id ?? null;
    };

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      setHoverId(pick(e.clientX - rect.left, e.clientY - rect.top));
    };
    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      onSelect(pick(e.clientX - rect.left, e.clientY - rect.top));
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);
    return () => { canvas.removeEventListener("mousemove", onMove); canvas.removeEventListener("click", onClick); };
  }, [layoutNodes, onSelect]);

  return (
    <div ref={wrapRef} className="h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full block cursor-crosshair" />
    </div>
  );
};
