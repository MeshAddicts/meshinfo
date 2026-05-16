import { useMemo } from "react";

import { useTimeTicker } from "./TimeTickerContext";

export const DateToSince = ({
  date,
  currentDate,
}: {
  date: string | Date;
  /** Optional override; falls back to TimeTickerContext when omitted. */
  currentDate?: Date;
}) => {
  const tickerDate = useTimeTicker();
  const effectiveDate = currentDate ?? tickerDate;
  const interval = useMemo(
    () => effectiveDate.getTime() - new Date(date).getTime(),
    [effectiveDate, date],
  );
  return (
    <span title={`${date}`}>
      {Math.round(interval / 1000)} secs
    </span>
  );
};
