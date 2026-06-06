import { useEffect, useState } from "react";

export type ToastKind = "info" | "error" | "success";

interface ToastItem {
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

const KIND_CLASS: Record<ToastKind, string> = {
  info: "bg-gray-900/85 border-white/10 text-gray-200",
  error: "bg-red-950/85 border-red-500/40 text-red-200",
  success: "bg-emerald-950/85 border-emerald-500/40 text-emerald-200",
};

/** Mount once near the app root; renders and auto-dismisses toasts. */
export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const onToast: Listener = (t) => {
      setItems((prev) => [...prev, t]);
      window.setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), t.duration);
    };
    listeners.add(onToast);
    return () => { listeners.delete(onToast); };
  }, []);

  if (items.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[2000] flex flex-col items-center gap-2 pointer-events-none"
    >
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
          className={`pointer-events-auto max-w-[min(90vw,28rem)] text-left px-3 py-2 rounded-lg text-xs shadow-2xl border backdrop-blur-xl ${KIND_CLASS[t.kind]}`}
        >
          {t.message}
        </button>
      ))}
    </div>
  );
}
