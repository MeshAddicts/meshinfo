import { intervalToDuration } from "date-fns";
import { useMemo } from "react";

export const DateToSince = ({
  date,
  currentDate = new Date(),
}: {
  date: string | Date;
  currentDate?: Date;
}) => {
  const duration = useMemo(
    () =>
      intervalToDuration({
        start: new Date(date).getTime(),
        end: currentDate.getTime(),
      }),
    [currentDate, date]
  );
  return (
    <span title={`${date}`}>
      {duration.years ? `${duration.years}yrs` : ""}
      {duration.months ? `${duration.months}mo` : ""}
      {duration.days ? `${duration.days}d` : ""}
      {duration.hours ? `${duration.hours}h` : ""}
      {duration.minutes ? `${duration.minutes}m` : ""}
      {duration.seconds ? `${duration.seconds}s` : ""} ago
    </span>
  );
};
