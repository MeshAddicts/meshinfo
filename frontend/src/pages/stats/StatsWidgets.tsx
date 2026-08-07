import type { ReactNode } from "react";

function formatInt(n: any) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "0";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(v);
}

function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={
        "rounded-2xl border border-gray-800/60 bg-gray-950/35 p-5 shadow-xs backdrop-blur-sm " +
        className
      }
    >
      {children}
    </div>
  );
}

export function KpiCard({
  title,
  value,
  subtitle,
  hint,
  icon,
  compact,
}: {
  title: string;
  value: ReactNode;
  subtitle?: string;
  hint?: string;
  icon?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={
        "group rounded-2xl border border-gray-800/60 bg-gray-950/35 p-4 shadow-xs backdrop-blur-sm transition " +
        "hover:bg-gray-950/55 hover:border-gray-700/70"
      }
      title={hint}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-gray-400">{title}</div>
          <div
            className={
              (compact ? "mt-1 text-xl " : "mt-2 text-2xl ") +
              "font-semibold text-gray-100"
            }
          >
            {typeof value === "number" ? formatInt(value) : value}
          </div>
          {subtitle && (
            <div className="mt-1 text-xs text-gray-500">{subtitle}</div>
          )}
        </div>

        {icon && (
          <div className="shrink-0 rounded-xl border border-gray-800 bg-gray-950/40 p-2 text-gray-300">
            {icon}
          </div>
        )}
      </div>
    </div>
  );
}

export function SkeletonKpiCard() {
  return (
    <div className="rounded-2xl border border-gray-800/50 bg-gray-950/25 p-4">
      <div className="h-3 w-32 rounded-sm bg-gray-800/30" />
      <div className="mt-3 h-6 w-24 rounded-sm bg-gray-800/40" />
      <div className="mt-2 h-3 w-40 rounded-sm bg-gray-800/20" />
    </div>
  );
}

export function BarMeter({
  label,
  value,
  leftValue,
  rightHint,
  showPercent = true,
}: {
  label: string;
  value: number;
  leftValue: ReactNode;
  rightHint?: string;
  showPercent?: boolean;
}) {
  const pct = Math.round(clamp01(value) * 100);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-xs text-gray-600 dark:text-gray-400">
        <div>
          {label}{" "}
          {showPercent && <span className="text-gray-500">({pct}%)</span>}
        </div>

        <div>
          <span className="tabular-nums text-gray-900 dark:text-gray-100">
            {typeof leftValue === "number" ? formatInt(leftValue) : leftValue}
          </span>{" "}
          {rightHint ? <span className="text-gray-500">{rightHint}</span> : null}
        </div>
      </div>

      <div className="h-2 rounded-full bg-gray-200/70 dark:bg-gray-800 overflow-hidden">
        <div
          className="h-full bg-indigo-600/80 transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export function RingProgress({
  label,
  value,
  centerTop,
  centerBottom,
  footerLeft,
  footerRight,
  footerLeftValue,
  footerRightValue,
}: {
  label: string;
  value: number;
  centerTop: ReactNode;
  centerBottom?: ReactNode;
  footerLeft?: ReactNode;
  footerRight?: ReactNode;
  footerLeftValue?: ReactNode;
  footerRightValue?: ReactNode;
}) {
  const r = 56;
  const c = 2 * Math.PI * r;
  const pct = clamp01(value);
  const dash = c * pct;

  return (
    <div className="flex flex-col items-center">
      <div className="text-xs text-gray-400">{label}</div>

      <div className="relative mt-2">
        <svg width="152" height="152" viewBox="0 0 152 152" aria-hidden="true">
          <g transform="translate(76,76)">
            <circle
              r={r}
              fill="none"
              stroke="rgba(148,163,184,0.15)"
              strokeWidth="12"
            />
            <circle
              r={r}
              fill="none"
              stroke="rgba(99,102,241,0.65)"
              strokeWidth="12"
              strokeLinecap="round"
              strokeDasharray={`${dash} ${c - dash}`}
              transform="rotate(-90)"
              style={{ transition: "stroke-dasharray 700ms ease-out" }}
            />
          </g>
        </svg>

        <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
          <div className="text-3xl font-semibold text-gray-100">{centerTop}</div>
          {centerBottom && (
            <div className="mt-0.5 text-xs text-gray-500">{centerBottom}</div>
          )}
        </div>
      </div>

      {(footerLeft || footerRight) && (
        <div className="mt-3 grid w-full grid-cols-2 gap-3">
          <div className="rounded-xl border border-gray-800/60 bg-gray-950/25 p-3 text-center">
            <div className="text-[11px] text-gray-500">{footerLeft}</div>
            <div className="mt-1 text-sm font-medium text-gray-100">
              {typeof footerLeftValue === "number"
                ? formatInt(footerLeftValue)
                : footerLeftValue}
            </div>
          </div>
          <div className="rounded-xl border border-gray-800/60 bg-gray-950/25 p-3 text-center">
            <div className="text-[11px] text-gray-500">{footerRight}</div>
            <div className="mt-1 text-sm font-medium text-gray-100">
              {typeof footerRightValue === "number"
                ? formatInt(footerRightValue)
                : footerRightValue}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function InsightRow({
  title,
  detail,
  tone = "info",
}: {
  title: string;
  detail: string;
  tone?: "good" | "warn" | "info";
}) {
  const dot =
    tone === "good"
      ? "bg-emerald-500/60"
      : tone === "warn"
      ? "bg-amber-500/70"
      : "bg-sky-500/60";

  return (
    <div className="rounded-xl border border-gray-800/60 bg-gray-950/25 p-3">
      <div className="flex items-start gap-3">
        <div className={"mt-1 h-2.5 w-2.5 rounded-full " + dot} />
        <div className="min-w-0">
          <div className="text-sm font-medium text-gray-100">{title}</div>
          <div className="mt-0.5 text-xs text-gray-400">{detail}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------- tiny inline icon set ----------------------

export function Icon({ name }: { name: string }) {
  const common = "h-4 w-4";

  switch (name) {
    case "check":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <path
            d="M20 6L9 17l-5-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "link":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <path
            d="M10 13a5 5 0 0 0 7.07 0l1.41-1.41a5 5 0 0 0-7.07-7.07L10 5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M14 11a5 5 0 0 0-7.07 0L5.52 12.4a5 5 0 0 0 7.07 7.07L14 19"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "download":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <path d="M12 3v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path
            d="M8 11l4 4 4-4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path d="M5 21h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "pulse":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <path
            d="M3 12h4l2-6 4 12 2-6h6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "spark":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <path
            d="M12 2l1.3 4.6L18 8l-4.7 1.4L12 14l-1.3-4.6L6 8l4.7-1.4L12 2z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M19 13l.8 2.7L22 16l-2.2.3L19 19l-.8-2.7L16 16l2.2-.3L19 13z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "signal":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <path d="M2 20h2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M6 20h2v-4H6v4z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M10 20h2v-7h-2v7z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M14 20h2v-10h-2v10z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M18 20h2V4h-2v16z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
        </svg>
      );
    case "nodes":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <path d="M7 7h10v10H7V7z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
          <path d="M12 7V4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M12 20v-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M7 12H4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M20 12h-3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case "chat":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <path
            d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4v8z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "thermo":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <path
            d="M14 14.76V5a2 2 0 0 0-4 0v9.76a4 4 0 1 0 4 0z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "route":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <path d="M6 7a3 3 0 1 0 0 .001V7z" stroke="currentColor" strokeWidth="2" />
          <path d="M18 17a3 3 0 1 0 0 .001V17z" stroke="currentColor" strokeWidth="2" />
          <path
            d="M8.5 8.5c2.5 2.5 4.5 1 7 3.5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M9 16c1.6-1.6 2.7-2 4.2-2.4"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      );
    case "database":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <ellipse cx="12" cy="5" rx="8" ry="3" stroke="currentColor" strokeWidth="2" />
          <path
            d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      );
    case "inbox":
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <path
            d="M4 4h16v10l-4 6H8l-4-6V4z"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
          <path
            d="M4 14h5l1 2h4l1-2h5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinejoin="round"
          />
        </svg>
      );
    default:
      return (
        <svg className={common} viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
        </svg>
      );
  }
}
