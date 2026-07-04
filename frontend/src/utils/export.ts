/** Quote a CSV field when it contains a comma, quote, or newline. */
export function csvEscape(v: unknown): string {
  const s = String(v ?? "");
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Trigger a browser download of the blob under the given filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // deferred revoke: revoking synchronously can cancel the download in some browsers
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
