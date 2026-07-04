import { type ReactNode, useRef } from "react";

export interface SegmentedOption<T> {
  value: T;
  label: ReactNode;
  sub?: ReactNode;
  title?: string;
}

/** Segmented button group with proper radiogroup semantics: roving tabindex,
 *  arrow-key navigation, aria-checked. Used for Reliability / Detail / Aggression. */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  options: SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeIdx = Math.max(0, options.findIndex((o) => o.value === value));

  const move = (dir: 1 | -1) => {
    const next = (activeIdx + dir + options.length) % options.length;
    onChange(options[next].value);
    btnRefs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={`flex gap-1 rounded-lg border border-white/10 bg-white/5 p-0.5 text-[10px] font-medium ${
        disabled ? "opacity-40 pointer-events-none" : ""
      }`}
    >
      {options.map((opt, i) => {
        const active = opt.value === value;
        return (
          <button
            key={String(opt.value)}
            ref={(el) => { btnRefs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowDown") { e.preventDefault(); move(1); }
              else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { e.preventDefault(); move(-1); }
            }}
            title={opt.title}
            className={`flex-1 rounded-md px-1.5 py-1 transition-colors ${
              active ? "bg-cyan-500/20 text-cyan-200" : "text-gray-400 hover:text-gray-200 hover:bg-white/5"
            }`}
          >
            <div>{opt.label}</div>
            {opt.sub != null && <div className="text-[9px] text-gray-500 font-normal">{opt.sub}</div>}
          </button>
        );
      })}
    </div>
  );
}
