import { useEffect, useId, useRef, useState } from "react";

import { toast } from "../../../components/toastStore";
import { copyTextToClipboard } from "../../../utils/clipboard";
import { formatLatLng, parseLatLng } from "../lib/helpers";

/** Imperative feed for the pill's per-frame values — held here (not in
 *  Map.tsx) so cursor movement re-renders only the pill. */
export interface CoordPillSink {
  /** Cursor [lng, lat] + terrain elevation (MSL m); nulls on mouse-out. */
  setHover: (coord: [number, number] | null, elevationM: number | null) => void;
  /** Map-center fallback, updated on moveend. */
  setCenter: (coord: [number, number]) => void;
}

/**
 * Live-coordinate pill: shows the lat/lng under the cursor (plus terrain
 * elevation when 3D is on), or the map center when not hovering. Click to paste
 * a "lat, lng" and jump-to-center with a pin, without disturbing the active tool.
 */
export function MapCoordinatePill({
  sinkRef,
  hasPin,
  onJump,
  onClearPin,
}: {
  /** Registration point for the map's hover/center publishers. */
  sinkRef: React.MutableRefObject<CoordPillSink | null>;
  /** Whether a jump-to pin is currently dropped. */
  hasPin: boolean;
  onJump: (lngLat: [number, number]) => void;
  onClearPin: () => void;
}) {
  const [coord, setCoord] = useState<[number, number] | null>(null);
  const [elevationM, setElevationM] = useState<number | null>(null);
  const [centerCoord, setCenterCoord] = useState<[number, number] | null>(null);
  useEffect(() => {
    sinkRef.current = {
      setHover: (c, e) => {
        setCoord(c);
        setElevationM(e);
      },
      setCenter: setCenterCoord,
    };
    return () => {
      sinkRef.current = null;
    };
  }, [sinkRef]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  const isLive = coord != null;
  const display = coord ?? centerCoord;

  // Close the editor on outside pointerdown (pointer, so touch dismisses too).
  useEffect(() => {
    if (!editing) return;
    const onDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setEditing(false);
        setError(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [editing]);

  const openEditor = () => {
    setDraft(display ? formatLatLng(display[0], display[1]) : "");
    setError(false);
    setEditing(true);
    // Focus + select after the input mounts.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  };

  const submit = () => {
    const parsed = parseLatLng(draft);
    if (!parsed) {
      setError(true);
      return;
    }
    onJump(parsed);
    setEditing(false);
    setError(false);
  };

  const copyCoords = async () => {
    if (!display) return;
    const text = formatLatLng(display[0], display[1]);
    const ok = await copyTextToClipboard(text);
    toast(ok ? `Copied ${text}` : "Couldn't copy coordinates", { kind: ok ? "success" : "error" });
  };

  return (
    <div
      ref={containerRef}
      // lg+ only: at ≥1024px --map-pad gains the nav-rail width, so this offset
      // clears the tools drawer.
      className="hidden lg:block fixed top-3 z-40 left-[calc(var(--map-pad)+33.75rem)]"
    >
      {editing ? (
        <div className="flex flex-col gap-1 rounded-xl border border-cyan-500/40 bg-gray-900/95 shadow-2xl px-2.5 py-1.5 max-w-[calc(100vw-var(--map-pad)-35rem)]">
          <div className="flex items-center gap-1.5">
            <svg className="w-3.5 h-3.5 text-cyan-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={draft}
              placeholder="lat, lng"
              aria-label="Jump to coordinates (lat, lng)"
              aria-invalid={error}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => {
                setDraft(e.target.value);
                if (error) setError(false);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  setEditing(false);
                  setError(false);
                }
              }}
              className={`w-44 rounded-md bg-white/10 border px-1.5 py-0.5 text-[11px] font-mono text-gray-100 placeholder-gray-500
                focus:outline-hidden focus:ring-1 ${
                  error
                    ? "border-red-500/60 focus:border-red-500/80 focus:ring-red-500/40"
                    : "border-cyan-500/40 focus:border-cyan-500/70 focus:ring-cyan-500/40"
                }`}
            />
            <button
              type="button"
              onClick={submit}
              aria-label="Go to coordinates"
              className="shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-cyan-300 hover:text-cyan-200 hover:bg-cyan-500/15 transition-colors"
            >
              Go
            </button>
          </div>
          {error ? (
            <span id={errorId} role="alert" className="text-[10px] text-red-400 pl-5">
              Enter coordinates as <span className="font-mono">lat, lng</span>
            </span>
          ) : (
            <span className="text-[10px] text-gray-500 pl-5">
              Paste a <span className="font-mono">lat, lng</span> — centers the map &amp; drops a pin
            </span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-0.5 rounded-full border border-white/10 bg-gray-900/95 text-gray-300 shadow-2xl">
          <button
            type="button"
            onClick={openEditor}
            title="Click to jump to coordinates"
            aria-label="Live coordinates — click to jump to a location"
            className="flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-l-full hover:bg-white/5 transition-colors"
          >
            <svg className={`w-3 h-3 ${isLive ? "text-cyan-400" : "text-gray-500"}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {display ? (
              <span className="tabular-nums text-[11px] font-medium">{formatLatLng(display[0], display[1])}</span>
            ) : (
              <span className="text-[11px] text-gray-500">—</span>
            )}
            {isLive && elevationM != null && (
              <>
                <span className="text-gray-600">·</span>
                <span className="tabular-nums text-[11px]">{Math.round(elevationM)} m</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={copyCoords}
            disabled={!display}
            title="Copy coordinates"
            aria-label="Copy coordinates"
            className="shrink-0 p-1 text-gray-500 hover:text-gray-200 hover:bg-white/5 transition-colors disabled:opacity-40 disabled:hover:bg-transparent"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </button>

          {hasPin && (
            <button
              type="button"
              onClick={onClearPin}
              title="Clear dropped pin"
              aria-label="Clear dropped pin"
              className="shrink-0 p-1 pr-1.5 rounded-r-full text-fuchsia-400 hover:text-fuchsia-300 hover:bg-white/5 transition-colors"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
      )}
    </div>
  );
}
