/**
 * Pure helpers for the growth loops: install attribution from links and the onboarding
 * survey (the lab's source_id and channel person properties), invite and share links that
 * name the sharer (inviter_distinct_id), and which share-sheet results count as a share.
 * Import-free so the studio's tests can load it.
 */

export interface Attribution {
  sourceId?: string;
  channel?: string;
  /** PostHog distinct id of the user whose link this install came from. */
  inviter?: string;
}

/** ChannelKind values (src/core/types.ts) a link may name. */
const CHANNELS = new Set(["creator_ugc", "owned_social", "share_loop", "invite_loop", "paid_ads", "app_store_search", "seo"]);
const VALUE = /^[A-Za-z0-9_.:@-]{1,80}$/;

function queryParams(url: string): Map<string, string> {
  const out = new Map<string, string>();
  const query = url.split("#")[0]?.split("?")[1] ?? "";
  for (const pair of query.split("&")) {
    const [k, v = ""] = pair.split("=");
    if (!k) continue;
    try {
      out.set(decodeURIComponent(k), decodeURIComponent(v.replace(/\+/g, " ")));
    } catch {
      // malformed escape: ignore the parameter
    }
  }
  return out;
}

function clean(value: string | undefined): string | undefined {
  return value && VALUE.test(value) ? value : undefined;
}

/**
 * Link parameters: `src` (a post or campaign id) or `c` (a creator code) → source_id, `ch` →
 * channel, `i` → inviter. A link that only names an inviter is attributed to that inviter.
 */
export function parseAttribution(url: string | null | undefined): Attribution {
  if (!url) return {};
  const q = queryParams(url);
  const inviter = clean(q.get("i"));
  const named = clean(q.get("ch"));
  const channel = named && CHANNELS.has(named) ? named : inviter ? "invite_loop" : undefined;
  const code = clean(q.get("c"));
  const sourceId = clean(q.get("src")) ?? (code ? `code:${code.toLowerCase()}` : inviter && channel ? `${channel}:${inviter}` : undefined);
  return { ...(sourceId ? { sourceId } : {}), ...(channel ? { channel } : {}), ...(inviter ? { inviter } : {}) };
}

/** The attribution survey answer as a source (and a channel when the answer names one). */
export function surveyAttribution(answer: string): Attribution {
  const slug = answer.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  if (!slug) return {};
  const channel = /friend|family|someone|partner|coworker/.test(slug)
    ? "invite_loop"
    : /app_?store|play_?store|google_play|store_search/.test(slug)
      ? "app_store_search"
      : /google|web|search/.test(slug)
        ? "seo"
        : undefined;
  return { sourceId: `survey:${slug}`, ...(channel ? { channel } : {}) };
}

/** Lab cell ids (store ids `cell_000123`); other flag variants are remote-config ids, never cells. */
const CELL_ID = /^cell_\d+$/;

export function cellIdFrom(variants: readonly string[]): string | undefined {
  return variants.find((v) => CELL_ID.test(v));
}

/** `base` with the defined parameters appended. */
export function withParams(base: string, params: Record<string, string | null | undefined>): string {
  const pairs = Object.entries(params).flatMap(([k, v]) => (v ? [`${k}=${encodeURIComponent(v)}`] : []));
  return pairs.length ? `${base}${base.includes("?") ? "&" : "?"}${pairs.join("&")}` : base;
}

/**
 * iOS reports whether the sheet completed (React Native Share: sharedAction vs dismissedAction).
 * Android's chooser reports nothing, so its shares count but are marked unconfirmed.
 */
export function shareOutcome(platform: string, action: string | null): { counted: boolean; confirmed: boolean } {
  if (platform === "ios") return { counted: action === "sharedAction", confirmed: action === "sharedAction" };
  return { counted: true, confirmed: false };
}
