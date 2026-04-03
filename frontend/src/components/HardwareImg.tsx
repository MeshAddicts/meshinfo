import { useMemo } from "react";

import { HARDWARE_PHOTOS, HardwareModel } from "../types";

export const HardwareImg = ({
  model,
  showLabel = false,
}: {
  model: number;
  showLabel?: boolean;
}) => {
  const image = HARDWARE_PHOTOS[model as keyof typeof HARDWARE_PHOTOS];

  const modelName = useMemo(
    () =>
      HardwareModel[model as HardwareModel] as string | undefined,
    [model]
  );

  const label = modelName?.replace(/_/g, " ").replace(/\bV(\d)/g, "v$1");

  if (!image && !showLabel) return <></>;

  return (
    <span className="inline-flex items-center gap-2">
      {image && (
        <img
          src={`${import.meta.env.BASE_URL}images/hardware/${image}`}
          alt={modelName}
          title={modelName}
          className="w-8 h-8 object-cover dark:brightness-90"
        />
      )}
      {showLabel && label && (
        <span className="text-sm text-gray-700 dark:text-gray-300">
          {label}
        </span>
      )}
    </span>
  );
};
