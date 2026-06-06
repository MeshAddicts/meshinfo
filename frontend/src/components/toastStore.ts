export type ToastKind = "info" | "error" | "success";

export interface ToastItem {
  id: number;
  message: string;
  kind: ToastKind;
  duration: number;
}

type Listener = (t: ToastItem) => void;
const listeners = new Set<Listener>();
let nextId = 1;

/** Fire a transient toast. No-op if no <ToastHost> is mounted. */
export function toast(message: string, opts?: { kind?: ToastKind; duration?: number }): void {
  const item: ToastItem = {
    id: nextId++,
    message,
    kind: opts?.kind ?? "info",
    duration: opts?.duration ?? 4500,
  };
  listeners.forEach((l) => l(item));
}

/** Subscribe a host to fired toasts; returns an unsubscribe. */
export function subscribeToasts(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
