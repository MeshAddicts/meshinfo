import { useEffect, useState } from "react";

import { commitNumericDraft } from "../lib/helpers";

/** Numeric input that commits on blur/Enter (clamped), reverting blank/garbage
 *  to the current value so the RF model never gets 0/NaN from a half-typed field. */
export function NumericDraftInput({
  value,
  onCommit,
  min,
  max,
  className,
  ariaLabel,
  title,
  inputMode = "text",
}: {
  value: number;
  onCommit: (v: number) => void;
  min: number;
  max: number;
  className?: string;
  ariaLabel?: string;
  title?: string;
  inputMode?: "text" | "numeric" | "decimal";
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const v = commitNumericDraft(draft, min, max, value);
    onCommit(v);
    setDraft(String(v));
  };

  return (
    <input
      type="text"
      inputMode={inputMode}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setDraft(String(value));
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      className={className}
      aria-label={ariaLabel}
      title={title}
    />
  );
}
