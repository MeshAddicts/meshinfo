import { useCallback, useRef } from "react";

/**
 * Mobile bottom-sheet gesture: swipe down to dismiss (or collapse if expanded),
 * swipe up to expand. Imperative DOM ops so React re-renders can't fight the
 * pointer.
 */
export function useBottomSheetGesture(onClose: () => void) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const startY = useRef(0);
  const dragging = useRef(false);
  const expandedRef = useRef(false);
  const preExpansionHeightRef = useRef<number | null>(null);

  const clearStyles = useCallback(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.style.transform = "";
    sheet.style.transition = "";
    sheet.style.height = "";
    sheet.style.maxHeight = "";
    expandedRef.current = false;
    preExpansionHeightRef.current = null;
  }, []);

  // Double-reflow pattern: lock starting px height with no transition, flush;
  // re-enable transition, flush again so the property is committed before the
  // value change. Single-flush variants get batched and skip the animation.
  const animateHeightTo = useCallback(
    (targetPx: number, targetTransform: string) => {
      const sheet = sheetRef.current;
      if (!sheet) return;
      const currentHeightPx = sheet.getBoundingClientRect().height;

      sheet.style.transition = "none";
      sheet.style.height = `${currentHeightPx}px`;
      sheet.style.maxHeight = `${currentHeightPx}px`;
      void sheet.offsetHeight;

      sheet.style.transition =
        "transform 200ms ease-out, height 200ms ease-out, max-height 200ms ease-out";
      void sheet.offsetHeight;

      sheet.style.transform = targetTransform;
      sheet.style.height = `${targetPx}px`;
      sheet.style.maxHeight = `${targetPx}px`;
    },
    [],
  );

  const expand = useCallback(() => {
    const sheet = sheetRef.current;
    if (!sheet || expandedRef.current) return;
    expandedRef.current = true;
    preExpansionHeightRef.current = sheet.getBoundingClientRect().height;
    // window.innerHeight (px) instead of 100dvh — some mobile browsers skip
    // the interpolation when animating between px and viewport-unit lengths.
    animateHeightTo(window.innerHeight, "translateY(0)");
  }, [animateHeightTo]);

  const collapseFromExpanded = useCallback(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    expandedRef.current = false;
    const targetPx = preExpansionHeightRef.current ?? sheet.getBoundingClientRect().height;
    animateHeightTo(targetPx, "translateY(0)");

    const onDone = () => {
      sheet.style.height = "";
      sheet.style.maxHeight = "";
      sheet.style.transition = "";
      preExpansionHeightRef.current = null;
    };
    const onTransitionEnd = (e: TransitionEvent) => {
      if (e.propertyName !== "height") return;
      sheet.removeEventListener("transitionend", onTransitionEnd);
      onDone();
    };
    sheet.addEventListener("transitionend", onTransitionEnd);
    window.setTimeout(() => {
      sheet.removeEventListener("transitionend", onTransitionEnd);
      onDone();
    }, 280);
  }, [animateHeightTo]);

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    dragging.current = true;
    startY.current = e.touches[0].clientY;
    if (sheetRef.current) {
      sheetRef.current.style.transition = "none";
    }
  }, []);

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (!dragging.current) return;
    const dy = e.touches[0].clientY - startY.current;
    // Up direction = rubber-band resistance (drag feels heavier).
    const visualDy = dy < 0 ? dy * 0.4 : dy;
    if (sheetRef.current) {
      sheetRef.current.style.transform = `translateY(${visualDy}px)`;
    }
  }, []);

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!dragging.current) return;
    dragging.current = false;
    const sheet = sheetRef.current;
    if (!sheet) return;

    const dy = e.changedTouches[0].clientY - startY.current;
    // Capped at 100px so a tall collapsed sheet still dismisses with a flick.
    const threshold = Math.min(sheet.offsetHeight * 0.2, 100);

    if (dy > threshold) {
      if (expandedRef.current) {
        collapseFromExpanded();
      } else {
        sheet.style.transition = "transform 200ms ease-in";
        sheet.style.transform = "translateY(100%)";
        sheet.addEventListener("transitionend", () => onClose(), { once: true });
      }
    } else if (dy < -40 && !expandedRef.current) {
      expand();
    } else {
      sheet.style.transition = "transform 200ms ease-out";
      sheet.style.transform = "translateY(0)";
    }
  }, [onClose, expand, collapseFromExpanded]);

  return { sheetRef, clearStyles, expand, onTouchStart, onTouchMove, onTouchEnd };
}
