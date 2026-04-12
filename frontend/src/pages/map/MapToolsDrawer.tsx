import { useEffect, useRef, useState } from "react";

export type ToolId = "los" | "traceroute" | "coverage" | "scan";

export interface ToolDef {
  id: ToolId;
  label: string;
  description: string;
  icon: React.ReactNode;
  /** Whether this tool needs 3D terrain (LoS-based tools). */
  requiresTerrain?: boolean;
}

const TOOLS: ToolDef[] = [
  {
    id: "los",
    label: "LOS",
    description: "Line-of-sight + Fresnel zone between two nodes",
    requiresTerrain: true,
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 19l6-6 4 4 8-8m0 0h-5m5 0v5" />
      </svg>
    ),
  },
  {
    id: "traceroute",
    label: "Traceroute",
    description: "Observed mesh routing between two nodes",
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
      </svg>
    ),
  },
  {
    id: "coverage",
    label: "Coverage",
    description: "Paint reachable area from a node (or anywhere)",
    requiresTerrain: true,
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" strokeWidth={2} strokeDasharray="3 3" />
        <circle cx="12" cy="12" r="5" strokeWidth={2} strokeDasharray="2 2" />
        <circle cx="12" cy="12" r="1.5" strokeWidth={2} fill="currentColor" />
      </svg>
    ),
  },
  {
    id: "scan",
    label: "Scan",
    description: "Best neighbors — rank LoS to every node in view",
    requiresTerrain: true,
    icon: (
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M7 12h10M10 18h4" />
      </svg>
    ),
  },
];

/**
 * Tools drawer pill — sits at top-left next to the search bar.
 * Dropdown opens down listing all global map tools.
 */
export function MapToolsDrawer({
  activeTool,
  onSelect,
  terrainEnabled,
}: {
  activeTool: ToolId | null;
  onSelect: (tool: ToolId | null) => void;
  terrainEnabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const currentTool = TOOLS.find((t) => t.id === activeTool);

  const pillBase =
    "shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer select-none shadow-2xl backdrop-blur-xl";
  const pillActive = "bg-cyan-500/20 border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/30";
  const pillIdle = "bg-gray-900/80 border-white/10 text-gray-300 hover:bg-gray-900/90 hover:border-white/20 hover:text-gray-100";

  return (
    <div ref={ref} className="fixed top-3 left-[292px] sm:left-[324px] z-30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`${pillBase} ${activeTool ? pillActive : pillIdle} flex items-center gap-1.5`}
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        </svg>
        <span>{currentTool ? currentTool.label : "Tools"}</span>
        <svg className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 min-w-[240px] rounded-xl overflow-hidden
          bg-gray-900/95 backdrop-blur-xl border border-white/10 shadow-2xl">
          {activeTool && (
            <button
              type="button"
              onClick={() => {
                onSelect(null);
                setOpen(false);
              }}
              className="w-full px-3 py-2 text-left text-xs text-red-400 hover:bg-white/5 hover:text-red-300 transition-colors border-b border-white/5 flex items-center gap-2"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
              Exit current tool
            </button>
          )}
          {TOOLS.map((tool) => {
            const isActive = tool.id === activeTool;
            const disabled = tool.requiresTerrain && !terrainEnabled;
            return (
              <button
                key={tool.id}
                type="button"
                disabled={disabled}
                onClick={() => {
                  if (disabled) return;
                  onSelect(tool.id);
                  setOpen(false);
                }}
                className={`w-full px-3 py-2 text-left transition-colors flex items-start gap-2.5 ${
                  isActive
                    ? "bg-cyan-500/20 text-cyan-200"
                    : disabled
                    ? "text-gray-600 cursor-not-allowed"
                    : "text-gray-300 hover:bg-white/5 hover:text-gray-100"
                }`}
              >
                <div className={`shrink-0 mt-0.5 ${isActive ? "text-cyan-400" : disabled ? "text-gray-700" : "text-gray-500"}`}>
                  {tool.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium flex items-center gap-1.5">
                    {tool.label}
                    {tool.requiresTerrain && (
                      <span className="text-[9px] px-1 rounded bg-white/5 text-gray-500 font-normal">
                        3D terrain
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-gray-500 mt-0.5 leading-snug">
                    {disabled ? "Enable 3D terrain to use this tool." : tool.description}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Small floating prompt that guides the user through tool steps.
 * E.g. "Click a node to start", "Pick the second node".
 */
export function MapToolPrompt({
  message,
  hint,
  onCancel,
}: {
  message: string;
  hint?: string;
  onCancel: () => void;
}) {
  return (
    <div className="fixed top-14 left-1/2 -translate-x-1/2 z-40
      rounded-xl shadow-2xl border border-cyan-500/40 bg-gray-900/90 backdrop-blur-xl
      px-4 py-2 flex items-center gap-3
      animate-[slideInUp_200ms_ease-out]">
      <svg className="w-4 h-4 text-cyan-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
      </svg>
      <div className="min-w-0">
        <div className="text-xs text-cyan-200 font-medium">{message}</div>
        {hint && <div className="text-[10px] text-gray-400 mt-0.5">{hint}</div>}
      </div>
      <button
        type="button"
        onClick={onCancel}
        className="p-1 rounded-md text-gray-500 hover:text-gray-300 hover:bg-white/10 transition-colors shrink-0"
        aria-label="Cancel"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}
