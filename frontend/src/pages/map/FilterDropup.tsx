import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface DropupOption<T> {
  value: T;
  label: string;
  color?: string;
  description?: string;
}

/** Dropup menu anchored to a pill button; portal-rendered to escape parent overflow. */
export function FilterDropup<T extends string | number | null>({
  label,
  value,
  options,
  onChange,
  isActive,
  maxHeight = 280,
}: {
  label: string;
  value: T;
  options: DropupOption<T>[];
  onChange: (value: T) => void;
  isActive: boolean;
  maxHeight?: number;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ left: number; bottom: number } | null>(null);
  const pillRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !pillRef.current) return;
    const rect = pillRef.current.getBoundingClientRect();
    setMenuPos({
      left: rect.left,
      bottom: window.innerHeight - rect.top + 8, // gap
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (pillRef.current?.contains(e.target as Node)) return;
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const pillBase =
    "shrink-0 px-3 py-1.5 rounded-full text-xs font-medium border transition-colors cursor-pointer select-none shadow-2xl backdrop-blur-xl";
  const pillActive = "bg-cyan-500/20 border-cyan-500/40 text-cyan-300 hover:bg-cyan-500/30";
  const pillIdle = "bg-gray-900/80 border-white/10 text-gray-300 hover:bg-gray-900/90 hover:border-white/20 hover:text-gray-100";

  const currentOpt = options.find((o) => o.value === value);

  return (
    <>
      <div ref={pillRef} className="shrink-0">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={`${pillBase} ${isActive ? pillActive : pillIdle} flex items-center gap-1.5`}
        >
          {currentOpt?.color && (
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: currentOpt.color }}
            />
          )}
          <span>{label}</span>
          <svg className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" />
          </svg>
        </button>
      </div>

      {open && menuPos && createPortal(
        <div
          ref={menuRef}
          style={{
            position: "fixed",
            left: menuPos.left,
            bottom: menuPos.bottom,
            maxHeight,
            zIndex: 2000,
          }}
          className="min-w-[160px] max-w-[280px] rounded-xl overflow-y-auto
            bg-gray-900/95 backdrop-blur-xl border border-white/10 shadow-2xl py-1"
        >
          {options.map((opt) => {
            const selected = opt.value === value;
            return (
              <button
                key={String(opt.value ?? "__null")}
                type="button"
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
                  selected ? "bg-cyan-500/20 text-cyan-200" : "text-gray-300 hover:bg-white/5 hover:text-gray-100"
                }`}
              >
                {opt.color && (
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ backgroundColor: opt.color }}
                  />
                )}
                <span className="flex-1 truncate">{opt.label}</span>
                {opt.description && (
                  <span className="text-[10px] text-gray-500">{opt.description}</span>
                )}
                {selected && (
                  <svg className="w-3 h-3 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}
