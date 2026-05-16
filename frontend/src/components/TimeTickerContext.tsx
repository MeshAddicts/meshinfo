/* eslint-disable react-refresh/only-export-components -- provider + hook share a single context instance, kept in one file */
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";

/** Tick provider for virtualized lists: only useTimeTicker subscribers re-render
 *  on each tick, so memoized sibling rows can be skipped by React. */
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
