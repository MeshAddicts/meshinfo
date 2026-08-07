import { useEffect, useRef, useState } from "react";

import { toast } from "../../../components/toastStore";
import {
  type CoveragePanelSettings,
  type CoveragePreset,
  downloadPresets,
  MAX_PRESET_NAME_LEN,
  MAX_PRESETS,
  parsePresetsFile,
  readPresetLibrary,
  resolvePreset,
  snapshotPreset,
  writePresetLibrary,
} from "../rf/coveragePresets";

/** Presets row body: saved list (click = apply), save-as, export/import.
 *  Applied-name state is parent-owned — this section unmounts on collapse. */
export function CoveragePresetsSection({
  current,
  onApply,
  appliedName,
  onAppliedNameChange,
  onCountChange,
}: {
  /** Live panel settings, used for Save. */
  current: CoveragePanelSettings;
  /** Applies a preset by fanning out to the panel's individual onChange props. */
  onApply: (resolved: CoveragePanelSettings, name: string) => void;
  /** Name of the last-applied preset (parent-owned). */
  appliedName: string | null;
  onAppliedNameChange: (name: string | null) => void;
  /** Keeps the collapsed-row summary count in sync. */
  onCountChange?: (count: number) => void;
}) {
  const [presets, setPresets] = useState<CoveragePreset[]>(() => readPresetLibrary());
  const [draftName, setDraftName] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onCountChange?.(presets.length);
  }, [presets.length, onCountChange]);

  const persist = (next: CoveragePreset[]) => {
    setPresets(next);
    writePresetLibrary(next);
  };

  const trimmedDraft = draftName.trim();
  const nameExists = presets.some((p) => p.name === trimmedDraft);
  const atCapacity = presets.length >= MAX_PRESETS && !nameExists;

  const handleSave = () => {
    if (!trimmedDraft || atCapacity) return;
    const snap = snapshotPreset(trimmedDraft, current);
    const next = nameExists
      ? presets.map((p) => (p.name === snap.name ? snap : p))
      : [...presets, snap];
    persist(next);
    setDraftName("");
    onAppliedNameChange(snap.name);
    toast(`Preset "${snap.name}" ${nameExists ? "updated" : "saved"}.`, { kind: "success" });
  };

  const handleApply = (p: CoveragePreset) => {
    onApply(resolvePreset(p), p.name);
    onAppliedNameChange(p.name);
  };

  const handleDelete = (name: string) => {
    persist(presets.filter((p) => p.name !== name));
    if (appliedName === name) onAppliedNameChange(null);
    toast(`Preset "${name}" deleted.`);
  };

  const handleImportFile = async (file: File) => {
    const text = await file.text();
    const imported = parsePresetsFile(text);
    if (!imported) {
      toast("Couldn't read that file — not a coverage-presets JSON.", { kind: "error" });
      return;
    }
    // Imports overwrite same-name entries; the rest append up to the cap
    const byName = new Map(presets.map((p) => [p.name, p] as const));
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const p of imported) {
      if (byName.has(p.name)) {
        byName.set(p.name, p);
        updated += 1;
      } else if (byName.size < MAX_PRESETS) {
        byName.set(p.name, p);
        added += 1;
      } else {
        skipped += 1;
      }
    }
    persist([...byName.values()]);
    const parts = [
      added > 0 ? `${added} added` : null,
      updated > 0 ? `${updated} updated` : null,
      skipped > 0 ? `${skipped} skipped (library full)` : null,
    ].filter(Boolean);
    toast(`Presets imported: ${parts.length > 0 ? parts.join(", ") : "no changes"}.`, {
      kind: skipped > 0 ? "error" : "success",
    });
  };

  return (
    <div className="space-y-2">
      {presets.length === 0 ? (
        <div className="text-[10px] text-gray-500 leading-relaxed">
          No saved presets yet. Configure the tool, then save the setup here to
          recall it later — presets capture TX/RX hardware, environment,
          accuracy, and overlay settings (not the pin location).
        </div>
      ) : (
        <div className="flex flex-col gap-1" role="list" aria-label="Saved coverage presets">
          {presets.map((p) => (
            <div
              key={p.name}
              role="listitem"
              className={`flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-md text-[11px] transition-colors ${
                appliedName === p.name
                  ? "bg-cyan-500/10 border border-cyan-500/30 text-cyan-200"
                  : "bg-white/5 border border-transparent text-gray-300"
              }`}
            >
              <button
                type="button"
                onClick={() => handleApply(p)}
                title={`Apply "${p.name}" (saved ${new Date(p.savedAt).toLocaleDateString()}) — recomputes coverage with these settings`}
                className="flex-1 min-w-0 text-left truncate hover:text-cyan-300 transition-colors cursor-pointer"
              >
                {p.name}
              </button>
              {appliedName === p.name && (
                <span className="shrink-0 text-[9px] uppercase tracking-wider text-cyan-400/80">active</span>
              )}
              <button
                type="button"
                onClick={() => handleDelete(p.name)}
                aria-label={`Delete preset ${p.name}`}
                className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded leading-none text-gray-500 hover:text-red-300 hover:bg-white/10 transition-colors"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-1.5">
        <input
          type="text"
          value={draftName}
          maxLength={MAX_PRESET_NAME_LEN}
          onChange={(e) => setDraftName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              handleSave();
            }
          }}
          placeholder="Preset name…"
          aria-label="Name for the preset to save"
          className="flex-1 min-w-0 px-2 py-1 rounded-md bg-white/5 border border-white/10 text-[10px] text-gray-200 placeholder:text-gray-500 focus:outline-none focus:border-cyan-500/50"
        />
        <button
          type="button"
          onClick={handleSave}
          disabled={!trimmedDraft || atCapacity}
          title={
            atCapacity
              ? `Library is full (${MAX_PRESETS} presets) — delete one first`
              : nameExists
                ? `Overwrite "${trimmedDraft}" with the current settings`
                : "Save the current settings as a new preset"
          }
          className="px-2 py-1 rounded-md border text-[10px] whitespace-nowrap shrink-0 transition-colors bg-cyan-500/10 border-cyan-500/30 text-cyan-300 hover:bg-cyan-500/20 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-cyan-500/10"
        >
          {nameExists ? "Overwrite" : "Save"}
        </button>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1 border-t border-white/5">
        <button
          type="button"
          onClick={() => downloadPresets(presets)}
          disabled={presets.length === 0}
          title="Download all presets as a JSON file to share or back up"
          className="text-[10px] text-gray-400 hover:text-cyan-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-400"
        >
          Export all
        </button>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          title="Import presets from a JSON file (same-name presets are overwritten)"
          className="text-[10px] text-gray-400 hover:text-cyan-300 transition-colors"
        >
          Import…
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          aria-hidden="true"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            // Reset so re-importing the same file re-fires onChange
            e.target.value = "";
            if (f) void handleImportFile(f);
          }}
        />
      </div>
    </div>
  );
}
