import React, { useCallback,useEffect, useMemo, useRef, useState } from "react";

import { clamp,type GraphEdge, type GraphNode, roleColor } from "./graphUtils";

interface Props {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeById: Map<string, GraphNode>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}

export const AdjacencyHeatmap: React.FC<Props> = ({ nodes, edges, nodeById: _nodeById, selectedId, onSelect }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [hoverCell, setHoverCell] = useState<{ row: number; col: number } | null>(null);
  const [dims, setDims] = useState({ w: 800, h: 600 });

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

  // Limit to top N connected nodes for readability
  const maxNodes = useMemo(() => {
    const minDim = Math.min(dims.w, dims.h);
    return clamp(Math.floor((minDim - 120) / 8), 10, 80);
  }, [dims]);

  const matrixNodes = useMemo(() => {
    return nodes.filter((n) => n.degree > 0).slice(0, maxNodes);
  }, [nodes, maxNodes]);

  // Edge lookup
  const edgeMap = useMemo(() => {
    const m = new Map<string, GraphEdge>();
    for (const e of edges) {
      m.set(`${e.a}~${e.b}`, e);
      m.set(`${e.b}~${e.a}`, e);
    }
    return m;
  }, [edges]);

  const labelW = 60;
  const labelH = 60;

  const cellSize = useMemo(() => {
    if (matrixNodes.length === 0) return 10;
    const available = Math.min(dims.w - labelW - 20, dims.h - labelH - 20);
    return clamp(Math.floor(available / matrixNodes.length), 3, 24);
  }, [matrixNodes, dims]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || matrixNodes.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, dims.w, dims.h);

    const n = matrixNodes.length;
    const gridW = n * cellSize;
    const startX = labelW + 10;
    const startY = labelH + 10;

    // Row/column labels
    ctx.font = `${Math.min(cellSize - 1, 10)}px ui-monospace, monospace`;
    ctx.textAlign = "right";

    for (let i = 0; i < n; i++) {
      const node = matrixNodes[i];
      const isSel = node.id === selectedId;
      const isHov = node.id === hoverId || hoverCell?.row === i || hoverCell?.col === i;

      // Row label
      ctx.globalAlpha = isSel ? 1 : isHov ? 0.9 : 0.5;
      ctx.fillStyle = isSel ? "#ffffff" : isHov ? "#e2e8f0" : roleColor(node.role);
      ctx.fillText(node.label.slice(0, 6), startX - 4, startY + i * cellSize + cellSize * 0.75);

      // Column label (rotated)
      ctx.save();
      ctx.translate(startX + i * cellSize + cellSize * 0.75, startY - 4);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "left";
      ctx.fillText(node.label.slice(0, 6), 0, 0);
      ctx.restore();
      ctx.textAlign = "right";
    }

    // Grid cells
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        const x = startX + col * cellSize;
        const y = startY + row * cellSize;

        if (row === col) {
          // Diagonal — self
          ctx.globalAlpha = 0.15;
          ctx.fillStyle = roleColor(matrixNodes[row].role);
          ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
          continue;
        }

        const nodeA = matrixNodes[row];
        const nodeB = matrixNodes[col];
        const edge = edgeMap.get(`${nodeA.id}~${nodeB.id}`);

        if (!edge) {
          // No connection
          ctx.globalAlpha = 0.02;
          ctx.fillStyle = "#334155";
          ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
          continue;
        }

        const isActiveRow = selectedId === nodeA.id || hoverId === nodeA.id;
        const isActiveCol = selectedId === nodeB.id || hoverId === nodeB.id;
        const isHovCell = hoverCell?.row === row && hoverCell?.col === col;

        // Color by edge type and SNR
        if (edge.kind === "neighbor" && edge.snr != null) {
          // SNR coloring: -20dB (red) → 0 (yellow) → +10dB (green)
          const snrNorm = clamp((edge.snr + 20) / 30, 0, 1);
          const hue = snrNorm * 120; // 0=red → 120=green
          ctx.fillStyle = `hsl(${hue} 70% 45%)`;
          ctx.globalAlpha = isHovCell ? 1 : isActiveRow || isActiveCol ? 0.85 : 0.65;
        } else if (edge.kind === "neighbor") {
          ctx.fillStyle = "#22c55e";
          ctx.globalAlpha = isHovCell ? 0.9 : isActiveRow || isActiveCol ? 0.7 : 0.45;
        } else {
          ctx.fillStyle = "#3b82f6";
          ctx.globalAlpha = isHovCell ? 0.8 : isActiveRow || isActiveCol ? 0.5 : 0.25;
        }

        ctx.fillRect(x, y, cellSize - 1, cellSize - 1);

        // Weight indicator (brighter for more connections)
        if (edge.w > 1) {
          ctx.globalAlpha = Math.min(0.5, edge.w * 0.08);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(x, y, cellSize - 1, cellSize - 1);
        }
      }
    }

    // Highlight row/col for selection or hover
    const highlightIdx = matrixNodes.findIndex((n) => n.id === (selectedId ?? hoverId));
    if (highlightIdx >= 0) {
      ctx.globalAlpha = 0.08;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(startX, startY + highlightIdx * cellSize, gridW, cellSize);
      ctx.fillRect(startX + highlightIdx * cellSize, startY, cellSize, n * cellSize);
    }

    // Hover cell tooltip
    if (hoverCell && hoverCell.row < n && hoverCell.col < n) {
      const nodeA = matrixNodes[hoverCell.row];
      const nodeB = matrixNodes[hoverCell.col];
      const edge = edgeMap.get(`${nodeA.id}~${nodeB.id}`);
      const text = edge
        ? `${nodeA.label} \u2194 ${nodeB.label}: ${edge.kind}${edge.snr != null ? ` (${edge.snr}dB)` : ""} w=${edge.w}`
        : `${nodeA.label} \u2194 ${nodeB.label}: no link`;

      ctx.font = "12px ui-sans-serif, system-ui, sans-serif";
      const tw = ctx.measureText(text).width;
      const tx = clamp(startX + hoverCell.col * cellSize, 4, dims.w - tw - 16);
      const ty = Math.max(4, startY + hoverCell.row * cellSize - 26);
      ctx.globalAlpha = 0.95; ctx.fillStyle = "rgba(15,23,42,0.95)";
      ctx.fillRect(tx, ty, tw + 12, 22);
      ctx.globalAlpha = 1; ctx.fillStyle = "#e2e8f0"; ctx.textAlign = "left";
      ctx.fillText(text, tx + 6, ty + 16);
    }
  }, [matrixNodes, edgeMap, dims, cellSize, selectedId, hoverId, hoverCell]);

  useEffect(() => { draw(); }, [draw]);

  // Interaction
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const startX = labelW + 10, startY = labelH + 10;
    const n = matrixNodes.length;

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - startX;
      const my = e.clientY - rect.top - startY;
      const col = Math.floor(mx / cellSize);
      const row = Math.floor(my / cellSize);

      if (row >= 0 && row < n && col >= 0 && col < n) {
        setHoverCell({ row, col });
        setHoverId(matrixNodes[row].id);
      } else {
        setHoverCell(null);
        setHoverId(null);
      }
    };

    const onClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const my = e.clientY - rect.top - startY;
      const row = Math.floor(my / cellSize);
      if (row >= 0 && row < n) {
        onSelect(matrixNodes[row].id);
      } else {
        onSelect(null);
      }
    };

    canvas.addEventListener("mousemove", onMove);
    canvas.addEventListener("click", onClick);
    canvas.addEventListener("mouseleave", () => { setHoverCell(null); setHoverId(null); });
    return () => {
      canvas.removeEventListener("mousemove", onMove);
      canvas.removeEventListener("click", onClick);
    };
  }, [matrixNodes, cellSize, onSelect]);

  return (
    <div ref={wrapRef} className="h-full w-full">
      {matrixNodes.length === 0 ? (
        <div className="h-full flex items-center justify-center text-sm text-gray-500">No connected nodes to display</div>
      ) : (
        <canvas ref={canvasRef} className="h-full w-full block cursor-crosshair" />
      )}
    </div>
  );
};
