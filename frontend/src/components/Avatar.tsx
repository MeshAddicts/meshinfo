import { useEffect, useMemo, useRef, useState } from "react";

// Static base classes Tailwind JIT can see literally. Size is applied via inline
// style because `w-${size}` is a runtime string the JIT scanner cannot tokenize,
// which previously left avatars unsized in production builds.
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

  // size is in Tailwind spacing units (default --spacing = 0.25rem).
  const sizeStyle = useMemo(
    () => ({ width: `${size * 0.25}rem`, height: `${size * 0.25}rem` }),
    [size],
  );

  const [showBroken, setShowBroken] = useState(false);
  const timerRef = useRef<number | null>(null);

  // Clear any pending broken-state timer if the component unmounts (rows in
  // Virtuoso mount/unmount frequently while scrolling).
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
    // Reset any previous in-flight timer so we don't race (onError can fire
    // more than once for the same img element).
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
