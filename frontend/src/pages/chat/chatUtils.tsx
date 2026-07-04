export type FocusMode = "endpoints" | "any";
export type MsgType = "all" | "bc" | "dm";
export type RangeKey = "1h" | "24h" | "7d" | "all";
export type SortKey = "desc" | "asc";
export type DirKey = "both" | "in" | "out";
export type NavMode = "replace" | "push";

export const DEFAULT_PARAM: Record<string, string> = {
  r: "24h",
  t: "all",
  s: "desc",
  focus: "endpoints",
  dir: "both",
};

export const isBroadcast = (to?: string) => !to || to === "ffffffff";

export const clampInt = (v: string | null, min: number, max: number) => {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  if (Number.isNaN(n)) return undefined;
  return Math.max(min, Math.min(max, n));
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildHighlightTokens = (query: string) => {
  const raw = (query ?? "").trim();
  if (!raw) return [];
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 6);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  return out;
};

export const renderHighlightedText = (text: string, query: string) => {
  const tokens = buildHighlightTokens(query);
  if (!tokens.length) return text;

  const tokenSet = new Set(tokens.map((t) => t.toLowerCase()));
  const re = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
  const parts = String(text ?? "").split(re);

  return parts.map((p, i) => {
    if (tokenSet.has(p.toLowerCase())) {
      return (
        <mark
          key={`hl-${i}`}
          className="rounded-sm px-0.5 bg-yellow-200/70 dark:bg-yellow-400/20 text-gray-900 dark:text-yellow-100"
        >
          {p}
        </mark>
      );
    }
    return <span key={`hl-${i}`}>{p}</span>;
  });
};

export const routeLabel = (nodes: any, id: string) => {
  if (!id || id === "ffffffff") return "ALL";
  return nodes?.[id]?.shortname ?? id;
};

export const buildRouteChain = (nodes: any, m: any) => {
  const from = routeLabel(nodes, String(m.from ?? ""));
  const to = routeLabel(nodes, String(m.to ?? ""));
  const via = Array.isArray(m.sender)
    ? m.sender.map((x: any) => routeLabel(nodes, String(x)))
    : [];
  return [from, ...via, to].join(" -> ");
};

// ---- Message permalink helpers (Commit 9-ish)
export const getMsgId = (m: any, fallback?: string) => {
  const id = m?.id;
  const s = String(id ?? "").trim();
  if (s) return s;
  return String(fallback ?? "").trim();
};

export const buildMessagePermalink = (msgId: string) => {
  const mid = String(msgId ?? "").trim();
  if (!mid) return window.location.href;

  try {
    const u = new URL(window.location.href);
    u.searchParams.set("msg", mid);
    return u.toString();
  } catch {
    return window.location.href;
  }
};
