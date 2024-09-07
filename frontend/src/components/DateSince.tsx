import { useMemo } from "react";

export const DateToSince = ({
  date,
  currentDate = new Date(),
}: {
  date: string | Date;
  currentDate?: Date;
}) => {
  const interval = useMemo(
    () =>
      currentDate.getTime() - new Date(date).getTime(),
    [currentDate, date]
  );
  return (
    <span title={`${date}`}>
      {Math.round(interval / 1000)} secs
    </span>
  );
};
