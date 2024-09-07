import { useMemo, useState } from "react";

const defaultClasses = ["w-16", "h-16", "object-cover"];
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
    () =>
      Array.from(
        new Set(
          (className
            ? defaultClasses.concat(className.split(" "))
            : defaultClasses
          ).concat([`w-${size}`, `h-${size}`])
        )
      ).join(" "),
    [className, size]
  );

  const [showBroken, setShowBroken] = useState(false);

  const handleError = () => {
    setShowBroken(true);
    setTimeout(
      () => setShowBroken(false),
      Math.floor(Math.random() * (1000 - 250 + 1)) + 250 // Random time between 250 and 1500 ms
    );
  };

  if (showBroken) {
    return <div className={`${classes} animate-pulse bg-slate-300`} />;
  }

  return (
    <img
      src={`https://api.dicebear.com/9.x/bottts-neutral/svg?seed=${id.replace("!", "")}`}
      //   src="https://meshinfo.cvme.sh/broken.png"
      onError={handleError}
      alt="Avatar"
      className={classes}
    />
  );
};
