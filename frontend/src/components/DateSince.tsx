import { useMemo } from "react";

import { useTimeTicker } from "./TimeTickerContext";

export const DateToSince = ({
  date,
  currentDate,
}: {
  date: string | Date;
  /** Optional override. If omitted, falls back to the TimeTickerContext so
   * rendering inside a memoized row doesn't require currentDate as a prop. */
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
