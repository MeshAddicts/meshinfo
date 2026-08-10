import React, { useCallback,useEffect, useMemo, useRef, useState } from "react";

import { clamp,type GraphEdge, type GraphNode, roleColor } from "./graphUtils";

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export const ArcDiagram: React.FC<Props> = ({ nodes, edges, nodeById, selectedId, onSelect }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });
  const panRef = useRef({ offsetX: 0, dragging: false, lastX: 0 });

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

  // Sorted nodes with x positions
  const { sortedNodes, posById, nodeSpacing } = useMemo(() => {
    const sorted = [...nodes]; // already sorted by degree desc from useGraphData
    const spacing = Math.max(14, Math.min(40, (dims.w - 80) / Math.max(1, sorted.length)));
    const totalW = sorted.length * spacing;
    const startX = Math.max(40, (dims.w - totalW) / 2);

    const positions = new Map<string, number>();
    sorted.forEach((n, i) => {
      positions.set(n.id, startX + i * spacing);
    });

    return { sortedNodes: sorted, posById: positions, nodeSpacing: spacing };
  }, [nodes, dims]);

  // Edge index for node lookup
  const edgeIndex = useMemo(() => {
    const idx = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      if (!idx.has(e.a)) idx.set(e.a, []);
      if (!idx.has(e.b)) idx.set(e.b, []);
      idx.get(e.a)!.push(e);
      idx.get(e.b)!.push(e);
    }
    return idx;
  }, [edges]);

  const baseY = dims.h * 0.65;

  // Draw
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || sortedNodes.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dims.w, dims.h);

    const ox = panRef.current.offsetX;

    // Baseline
    ctx.globalAlpha = 0.08;
    ctx.strokeStyle = "#94a3b8";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, baseY); ctx.lineTo(dims.w, baseY); ctx.stroke();

    // Arcs
    const activeEdges = selectedId ? edgeIndex.get(selectedId) ?? [] : hoverId ? edgeIndex.get(hoverId) ?? [] : [];
    const activeEdgeSet = new Set(activeEdges);

    for (const e of edges) {
      const xa = (posById.get(e.a) ?? 0) + ox;
      const xb = (posById.get(e.b) ?? 0) + ox;
      if (Math.max(xa, xb) < -50 || Math.min(xa, xb) > dims.w + 50) continue;

      const isActive = activeEdgeSet.has(e);
      if (!isActive && (selectedId || hoverId)) {
        ctx.globalAlpha = 0.015;
      } else if (isActive) {
        ctx.globalAlpha = e.kind === "neighbor" ? 0.5 : 0.3;
      } else {
        ctx.globalAlpha = e.kind === "neighbor" ? 0.08 : 0.03;
      }

      ctx.strokeStyle = isActive ? "#ffffff" : e.kind === "neighbor" ? roleColor(nodeById.get(e.a)?.role) : "#60a5fa";
      ctx.lineWidth = isActive ? 1.2 : 0.5;

      const midX = (xa + xb) / 2;
      const span = Math.abs(xb - xa);
      const arcH = Math.min(baseY - 20, span * 0.4 + 15);

      ctx.beginPath();
      ctx.moveTo(xa, baseY);
      ctx.quadraticCurveTo(midX, baseY - arcH, xb, baseY);
      ctx.stroke();
    }

    // Nodes
    for (const n of sortedNodes) {
      const x = (posById.get(n.id) ?? 0) + ox;
      if (x < -20 || x > dims.w + 20) continue;

      const isSel = n.id === selectedId;
      const isHov = n.id === hoverId;
      const r = clamp(2 + n.degree * 0.08, 2, 8);

      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(x, baseY, isSel ? r + 2 : isHov ? r + 1.5 : r, 0, Math.PI * 2);
      ctx.fillStyle = isSel ? "#ffffff" : isHov ? "#e2e8f0" : roleColor(n.role);
      ctx.fill();

      // Degree bar below
      const barH = clamp(n.degree * 0.4, 1, 40);
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = roleColor(n.role);
      ctx.fillRect(x - 1.5, baseY + r + 3, 3, barH);

      // Labels for top nodes or hovered/selected
      if (isSel || isHov || n.degree >= (sortedNodes[7]?.degree ?? 999)) {
        ctx.globalAlpha = isSel ? 1 : isHov ? 0.9 : 0.6;
        ctx.font = `${isSel || isHov ? "bold " : ""}10px ui-sans-serif, system-ui, sans-serif`;
        ctx.fillStyle = "#e2e8f0";
        ctx.textAlign = "center";
        ctx.save();
        ctx.translate(x, baseY - r - 6);
        ctx.rotate(-Math.PI / 4);
        ctx.fillText(n.label, 0, 0);
        ctx.restore();
      }
    }

    // Hover tooltip
    if (hoverId) {
      const gn = nodeById.get(hoverId);
      const x = (posById.get(hoverId) ?? 0) + ox;
      if (gn) {
        const linkedEdges = edgeIndex.get(hoverId) ?? [];
        const nbrCount = linkedEdges.filter((e) => e.kind === "neighbor").length;
        const trCount = linkedEdges.filter((e) => e.kind === "traceroute").length;
        const text = `${gn.label} \u2022 ${nbrCount} RF + ${trCount} trace`;
        ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
        const tw = ctx.measureText(text).width;
        const bx = clamp(x - tw / 2 - 6, 4, dims.w - tw - 16);
        const by = 12;
        ctx.globalAlpha = 0.92; ctx.fillStyle = "rgba(15,23,42,0.92)";
        ctx.fillRect(bx, by, tw + 12, 22);
        ctx.globalAlpha = 1; ctx.fillStyle = "#e2e8f0"; ctx.textAlign = "left";
        ctx.fillText(text, bx + 6, by + 16);
      }
    }
  }, [sortedNodes, edges, posById, edgeIndex, nodeById, dims, baseY, selectedId, hoverId]);

  useEffect(() => { draw(); }, [draw]);

  // Pan + interact
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const pick = (sx: number): string | null => {
      const ox = panRef.current.offsetX;
      let best: { id: string; d: number } | null = null;
      for (const n of sortedNodes) {
        const x = (posById.get(n.id) ?? 0) + ox;
        const d = Math.abs(sx - x) + Math.abs(baseY - (baseY)); // just horizontal
        const hitR = Math.max(8, nodeSpacing / 2);
        if (Math.abs(sx - x) <= hitR && (!best || d < best.d)) best = { id: n.id, d };
      }
      return best?.id ?? null;
    };

    const onDown = (e: MouseEvent) => {
      panRef.current.dragging = true;
      panRef.current.lastX = e.clientX;
    };
    const onUp = () => { panRef.current.dragging = false; };
    const onMove = (e: MouseEvent) => {
      if (panRef.current.dragging) {
        panRef.current.offsetX += e.clientX - panRef.current.lastX;
        panRef.current.lastX = e.clientX;
        draw();
        return;
      }
      const rect = canvas.getBoundingClientRect();
      setHoverId(pick(e.clientX - rect.left));
    };
    const onClick = (e: MouseEvent) => {
      if (panRef.current.dragging) return;
      const rect = canvas.getBoundingClientRect();
      onSelect(pick(e.clientX - rect.left));
    };

    canvas.addEventListener("mousedown", onDown);
    window.addEventListener("mouseup", onUp);
    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);
    return () => {
      canvas.removeEventListener("mousedown", onDown);
      window.removeEventListener("mouseup", onUp);
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("click", onClick);
    };
  }, [sortedNodes, posById, nodeSpacing, baseY, draw, onSelect]);

  return (
    <div ref={wrapRef} className="h-full w-full">
      <canvas ref={canvasRef} className="h-full w-full block cursor-grab active:cursor-grabbing" />
    </div>
  );
};
