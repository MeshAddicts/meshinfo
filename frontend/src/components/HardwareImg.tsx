import { useMemo } from "react";

import { HARDWARE_PHOTOS, HardwareModel } from "../types";

export const HardwareImg = ({ model }: { model: number }) => {
  const image = HARDWARE_PHOTOS[model as keyof typeof HARDWARE_PHOTOS];

  const modelName = useMemo(
    () =>
      Object.keys(HardwareModel)[Object.values(HardwareModel).indexOf(model)],
    [model]
  );

  if (!image) return <></>;

  // Determine if it's an SVG, WebP, or PNG based on file extension
  const extension = image.split('.').pop()?.toLowerCase();
  const isSvg = extension === 'svg';

  return (
    <img
      src={`${import.meta.env.BASE_URL}images/hardware/${image}`}
      alt={modelName}
      title={modelName}
      className={`w-8 h-8 object-cover ${!isSvg ? 'dark:brightness-5' : ''}`}
    />
  );
};
