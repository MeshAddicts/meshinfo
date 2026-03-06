import { useMemo, useState } from "react";
import { isRouteErrorResponse, Link, useLocation, useRouteError } from "react-router-dom";

function BrokenNodeArt() {
  return (
    <svg viewBox="0 0 120 120" className="h-20 w-20" aria-hidden="true">
      {/* antenna */}
      <path
        d="M60 14v22"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        fill="none"
      />
      {/* rf waves */}
      <path
        d="M43 30c5-7 11-10 17-10s12 3 17 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
        opacity="0.55"
      />
      <path
        d="M34 40c8-10 16-15 26-15s18 5 26 15"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
        opacity="0.3"
      />

      {/* node */}
      <circle
        cx="60"
        cy="70"
        r="26"
        stroke="currentColor"
        strokeWidth="4"
        fill="none"
      />

      {/* crack */}
      <path
        d="M56 52l8 12-9 7 10 17"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />

      {/* little “packet shrapnel” */}
      <circle cx="92" cy="78" r="2.6" fill="currentColor" opacity="0.6" />
      <circle cx="98" cy="86" r="1.8" fill="currentColor" opacity="0.35" />
      <circle cx="24" cy="86" r="2.0" fill="currentColor" opacity="0.25" />

      {/* shadow */}
      <ellipse cx="64" cy="106" rx="36" ry="7" fill="currentColor" opacity="0.08" />
    </svg>
  );
}

export function RouteError() {
  const err = useRouteError();
  const loc = useLocation();
  const [copied, setCopied] = useState(false);

  const info = useMemo(() => {
    let title = "Packets collided too hard";
    let subtitle = "A node fell over while trying to forward the truth.";
    let statusLine: string | undefined;
    let message: string | undefined;
    let details: string | undefined;

    if (isRouteErrorResponse(err)) {
      statusLine = `${err.status} ${err.statusText}`;
      title = "Route failed to load";
      subtitle = "The router returned an error response.";
      message = typeof err.data === "string" ? err.data : undefined;
    } else if (err instanceof Error) {
      title = "Meshinfo hit an exception";
      subtitle = "This is usually a harmless dev oops (but it *is* dramatic).";
      message = err.message;
      details = err.stack;
    } else if (typeof err === "string") {
      title = "Meshinfo hit an exception";
      subtitle = "The error was thrown as a string.";
      message = err;
    } else if (err && typeof err === "object") {
      title = "Meshinfo hit an exception";
      subtitle = "Unknown error object.";
      try {
        details = JSON.stringify(err, null, 2);
      } catch {
        // ignore
      }
    }

    const diagnostics = [
      "Meshinfo Route Error",
      `Path: ${loc.pathname}${loc.search}${loc.hash}`,
      statusLine ? `Status: ${statusLine}` : null,
      `When: ${new Date().toISOString()}`,
      message ? `Message: ${message}` : null,
      details ? `\nDetails:\n${details}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return { title, subtitle, statusLine, message, details, diagnostics };
  }, [err, loc.hash, loc.pathname, loc.search]);

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(info.diagnostics);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="min-h-[100dvh] bg-white dark:bg-gray-950">
      {/* simple “in-app-ish” header */}
      <div className="sticky top-0 z-10 border-b border-gray-200 dark:border-gray-800 bg-white/85 dark:bg-gray-900/70 backdrop-blur">
        <div className="mx-auto max-w-[1600px] px-3 sm:px-5 py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-indigo-600 dark:text-indigo-400">
              <BrokenNodeArt />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                Meshinfo
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 truncate">
                {loc.pathname}
                {loc.search}
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              to="/map"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
            >
              Map
            </Link>
            <Link
              to="/chat"
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
            >
              Chat
            </Link>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
            >
              Reload
            </button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1600px] px-3 sm:px-5 py-6">
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 shadow-sm overflow-hidden">
          <div className="p-5 sm:p-6">
            <div className="flex items-start gap-4">
              <div className="text-indigo-600 dark:text-indigo-400 shrink-0">
                <BrokenNodeArt />
              </div>

              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-lg sm:text-xl font-semibold text-gray-900 dark:text-gray-100">
                    {info.title}
                  </h1>
                  {info.statusLine ? (
                    <span className="rounded-full border border-gray-300/60 dark:border-gray-700 px-2 py-0.5 text-[11px] text-gray-700 dark:text-gray-200">
                      {info.statusLine}
                    </span>
                  ) : null}
                </div>

                <p className="mt-2 text-sm text-gray-700 dark:text-gray-300">
                  {info.subtitle}
                </p>

                {info.message ? (
                  <p className="mt-3 text-sm rounded-md border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-950/40 px-3 py-2 text-gray-800 dark:text-gray-200">
                    {info.message}
                  </p>
                ) : null}

                <div className="mt-4 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={copyDiagnostics}
                    className="rounded-md px-3 py-2 text-sm border border-indigo-300/60 dark:border-indigo-700/60 text-indigo-700 dark:text-indigo-200 hover:bg-indigo-50/60 dark:hover:bg-indigo-900/20 transition"
                    title="Copy useful error details to paste into an issue"
                  >
                    {copied ? "Copied!" : "Copy diagnostics"}
                  </button>

                  <Link
                    to="/nodes"
                    className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  >
                    Nodes
                  </Link>

                  <Link
                    to="/stats"
                    className="rounded-md px-3 py-2 text-sm border border-gray-300/60 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-100/60 dark:hover:bg-gray-800/40 transition"
                  >
                    Stats
                  </Link>
                </div>

                {info.details ? (
                  <details className="mt-5">
                    <summary className="cursor-pointer text-xs text-gray-500 dark:text-gray-400">
                      Technical details (for humans who enjoy pain)
                    </summary>
                    <pre className="mt-2 max-h-[45vh] overflow-auto rounded-md bg-gray-50 dark:bg-gray-950/40 p-3 text-xs text-gray-700 dark:text-gray-200">
                      {info.details}
                    </pre>
                  </details>
                ) : null}
              </div>
            </div>
          </div>

          <div className="border-t border-gray-200 dark:border-gray-800 px-5 sm:px-6 py-3 bg-gray-50/60 dark:bg-gray-900/40">
            <div className="text-[11px] text-gray-500 dark:text-gray-400">
              “Packets collided too hard.” — Meshinfo, probably
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
