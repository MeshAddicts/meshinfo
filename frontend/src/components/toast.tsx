import { useEffect, useState } from "react";

import { subscribeToasts, type ToastItem, type ToastKind } from "./toastStore";

const KIND_CLASS: Record<ToastKind, string> = {
  info: "bg-gray-900/85 border-white/10 text-gray-200",
  error: "bg-red-950/85 border-red-500/40 text-red-200",
  success: "bg-emerald-950/85 border-emerald-500/40 text-emerald-200",
};

/** Mount once near the app root; renders and auto-dismisses toasts. */
export function ToastHost() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    return subscribeToasts((t) => {
      setItems((prev) => [...prev, t]);
      window.setTimeout(() => setItems((prev) => prev.filter((x) => x.id !== t.id)), t.duration);
    });
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
