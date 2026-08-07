/** Document-level keyboard nav: arrows pan, +/- zoom, Esc walks the dismiss
 *  chain (flyover → tool → spiderfy/selection). Reads everything through refs
 *  so it binds once. */
import type { Map as MlMap } from "maplibre-gl";
import { useEffect } from "react";

import { toast } from "../../../components/toastStore";
import { dismissClusterSpiderfy, dismissPlainSpiderfy } from "../layers/spiderfy";

type MapTool = "los" | "traceroute" | "coverage" | "scan" | null;

export type KeyboardNavParams = {
  mbMapRef: { current: MlMap | null };
  mapContainerRef: { current: HTMLDivElement | null };
  flyoverCancelRef: { current: () => boolean };
  flyoverFlyingRef: { current: boolean };
  activeToolRef: { current: MapTool };
  toolStepRef: { current: "pickFrom" | "pickTo" | "result" };
  pickingMergeOriginRef: { current: boolean };
  keepCoveragePaintRef: { current: boolean };
  coverageEscArmedAtRef: { current: number };
  clusterEnabledRef: { current: boolean };
  handleScanCloseRef: { current: () => void };
  resetToolRef: { current: () => void };
  clearSelectionRef: { current: () => void };
};

export function useMapKeyboardNav(params: KeyboardNavParams): void {
  const {
    mbMapRef, mapContainerRef, flyoverCancelRef, flyoverFlyingRef,
    activeToolRef, toolStepRef, pickingMergeOriginRef, keepCoveragePaintRef,
    coverageEscArmedAtRef, clusterEnabledRef, handleScanCloseRef,
    resetToolRef, clearSelectionRef,
  } = params;

  useEffect(() => {
    const handleKeydown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const map = mbMapRef.current;

      // Escape works from anywhere; pan/zoom only when focus is on the map
      // itself (or nothing), so arrowing a focused panel control isn't hijacked.
      if (e.key !== "Escape") {
        if (!map) return;
        const ae = document.activeElement as HTMLElement | null;
        const navOk =
          !ae ||
          ae === document.body ||
          ae === map.getCanvas() ||
          ae === mapContainerRef.current ||
          ae.classList?.contains("maplibregl-canvas");
        if (!navOk) return;
        // Keyboard pan/zoom is user camera input — it takes the wheel back
        // from a running flyover (panBy/zoomIn carry no originalEvent, so
        // the hook's own movestart gate can't see them). Gated on flying so
        // camera nudges match pointer input during the label linger: they
        // leave the breadcrumbs alone (Esc dismisses, the timer tidies).
        if (flyoverFlyingRef.current && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "=", "+", "-", "_"].includes(e.key)) {
          flyoverCancelRef.current();
        }
      }

      const PAN_PX = 100;
      switch (e.key) {
        case "Escape":
          // A running flyover consumes Esc — stop the tour, keep the tool.
          if (flyoverCancelRef.current()) break;
          if (activeToolRef.current) {
            // Merge-origin picking consumes Esc (the pick hook's own
            // listener cancels it) — don't also arm/close the tool.
            if (pickingMergeOriginRef.current) break;
            // Scan opened as a coverage overlay: Esc returns to coverage (paint
            // preserved), matching the panel's close button — not a teardown of both.
            // Coverage's own guard then governs the final close.
            if (keepCoveragePaintRef.current && activeToolRef.current === "scan") {
              handleScanCloseRef.current();
              break;
            }
            // Coverage and a standalone scan each carry state (paint/pins/settings,
            // and scan's ~800-tile DEM) — one stray Esc shouldn't destroy it. Require
            // a confirming Esc, worded for the tool on screen.
            if (
              (activeToolRef.current === "coverage" || activeToolRef.current === "scan") &&
              toolStepRef.current === "result"
            ) {
              const now = Date.now();
              const toolName = activeToolRef.current === "scan" ? "Scan" : "Coverage";
              if (now - coverageEscArmedAtRef.current > 3000) {
                coverageEscArmedAtRef.current = now;
                toast(`Press Esc again to close ${toolName}.`);
                break;
              }
              coverageEscArmedAtRef.current = 0;
            }
            resetToolRef.current();
            break;
          }
          // Same dismiss-and-remember as the empty-click path, per mode.
          if (map) {
            if (clusterEnabledRef.current) dismissClusterSpiderfy(map);
            else dismissPlainSpiderfy(map);
          }
          clearSelectionRef.current();
          break;
        case "ArrowLeft":
          e.preventDefault();
          map?.panBy([-PAN_PX, 0], { duration: 200 });
          break;
        case "ArrowRight":
          e.preventDefault();
          map?.panBy([PAN_PX, 0], { duration: 200 });
          break;
        case "ArrowUp":
          e.preventDefault();
          map?.panBy([0, -PAN_PX], { duration: 200 });
          break;
        case "ArrowDown":
          e.preventDefault();
          map?.panBy([0, PAN_PX], { duration: 200 });
          break;
        case "=":
        case "+":
          e.preventDefault();
          map?.zoomIn({ duration: 200 });
          break;
        case "-":
          e.preventDefault();
          map?.zoomOut({ duration: 200 });
          break;
      }
    };
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
    // All params are refs — identity-stable, bind once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
