import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { type NodeRole,roleTitles } from "../../types";
import type { IMapNode } from "./types";
import { DEFAULT_NODE_COLOR,ROLE_COLORS } from "./utils";

export function MapSearchBar({
  nodes,
  onSelect,
}: {
  nodes: Record<string, IMapNode>;
  onSelect: (nodeId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    const q = query.toLowerCase();
    return Object.entries(nodes)
      .filter(([id, n]) => {
        if (!n.map_position) return false;
        return (
          id.toLowerCase().includes(q) ||
          n.shortname?.toLowerCase().includes(q) ||
          n.longname?.toLowerCase().includes(q)
        );
      })
      .slice(0, 20)
      .map(([id, n]) => ({ id, node: n }));
  }, [query, nodes]);

  useEffect(() => setHighlightIdx(0), [results]);

  useEffect(() => {
    const el = listRef.current?.children[highlightIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [highlightIdx]);

  const selectNode = useCallback(
    (id: string) => {
      onSelect(id);
      setQuery("");
      setOpen(false);
      inputRef.current?.blur();
    },
    [onSelect],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightIdx((i) => Math.min(i + 1, results.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlightIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter" && results[highlightIdx]) {
        e.preventDefault();
        selectNode(results[highlightIdx].id);
      } else if (e.key === "Escape") {
        setOpen(false);
        inputRef.current?.blur();
      }
    },
    [results, highlightIdx, selectNode],
  );

  // Global "/" focuses search
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && !e.ctrlKey && !e.metaKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  return (
    <div
      className="fixed top-3 left-[calc(var(--map-pad)+1rem)] z-30 transition-[left,width] duration-200
        w-36 sm:w-64
        focus-within:w-[calc(100vw-2rem)] focus-within:z-50
        sm:focus-within:w-64 sm:focus-within:z-30"
    >
      <div className="relative">
        <svg
          className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-500 pointer-events-none"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
          />
        </svg>
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
          placeholder="Search nodes… (press /)"
          aria-label="Search nodes"
          className="w-full pl-8 pr-3 py-1.5 rounded-xl text-xs
            bg-gray-900/80 backdrop-blur-xl border border-white/10 shadow-2xl
            text-gray-200 placeholder-gray-500
            focus:outline-none focus:border-cyan-500/50 focus:ring-1 focus:ring-cyan-500/50"
        />
      </div>

      {open && query.trim() !== "" && (
        <div
          ref={listRef}
          className="mt-1 max-h-64 overflow-y-auto rounded-xl
            bg-gray-900/90 backdrop-blur-xl border border-white/10 shadow-2xl"
        >
          {results.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-500">No matching nodes</div>
          )}
          {results.map(({ id, node }, i) => {
            const roleVal = (node as any).role as number | undefined;
            const roleName = roleVal != null ? roleTitles[roleVal as NodeRole]?.title : null;
            const roleColor = roleVal != null ? ROLE_COLORS[roleVal] : DEFAULT_NODE_COLOR;
            return (
              <button
                key={id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => selectNode(id)}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                  i === highlightIdx
                    ? "bg-white/10 text-gray-100"
                    : "text-gray-400 hover:bg-white/5"
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{
                    backgroundColor: node.online ? roleColor : "rgba(107,114,128,0.5)",
                  }}
                />
                <span className="truncate font-medium text-gray-200">
                  {node.shortname || id}
                </span>
                {node.longname && node.longname !== node.shortname && (
                  <span className="truncate text-gray-500">{node.longname}</span>
                )}
                {roleName && (
                  <span className="ml-auto shrink-0 text-[10px] text-gray-500">{roleName}</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
