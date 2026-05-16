import { useEffect, useMemo, useRef, useState } from "react";

// Size is applied via inline style — `w-${size}` is a runtime string Tailwind's
// JIT scanner can't tokenize, so it'd leave avatars unsized in prod builds.
const BASE_CLASSES = "object-cover";

export const Avatar = ({
  id,
  size,
  className,
}: {
  id: string;
  size: number;
  className?: string;
}) => {
  const classes = useMemo(
    () => (className ? `${BASE_CLASSES} ${className}` : BASE_CLASSES),
    [className],
  );

  // size matches Tailwind's --spacing (0.25rem default).
  const sizeStyle = useMemo(
    () => ({ width: `${size * 0.25}rem`, height: `${size * 0.25}rem` }),
    [size],
  );

  const [showBroken, setShowBroken] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Virtuoso rows mount/unmount frequently; cancel a pending broken-state timer.
  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const handleError = () => {
    setShowBroken(true);
    // onError can fire more than once for the same img; reset to avoid racing.
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
    }
    timerRef.current = window.setTimeout(
      () => {
        setShowBroken(false);
        timerRef.current = null;
      },
      Math.floor(Math.random() * (1000 - 250 + 1)) + 250, // 250–1500 ms jitter
    );
  };

  if (showBroken) {
    return <div style={sizeStyle} className={`${classes} animate-pulse bg-slate-300`} />;
  }

  return (
    <img
      src={`https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${id.replace("!", "")}`}
      onError={handleError}
      alt="Avatar"
      style={sizeStyle}
      className={classes}
    />
  );
};
