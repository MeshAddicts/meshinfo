/* eslint-disable react-refresh/only-export-components -- provider + hook share a single context instance, kept in one file */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

/**
 * Shared time-tick provider so virtualized lists don't have to pass `currentDate`
 * down as a prop. When the tick changes, only components that actually subscribe
 * to this context (via useTimeTicker) re-render — sibling props on memoized rows
 * stay stable and React skips the row entirely.
 */
const TimeTickerContext = createContext<Date>(new Date());

export function TimeTickerProvider({
  intervalMs = 1000,
  children,
}: {
  intervalMs?: number;
  children: ReactNode;
}) {
  const [date, setDate] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setDate(new Date()), intervalMs);
    return () => window.clearInterval(t);
  }, [intervalMs]);
  return (
    <TimeTickerContext.Provider value={date}>
      {children}
    </TimeTickerContext.Provider>
  );
}

export function useTimeTicker(): Date {
  return useContext(TimeTickerContext);
}
