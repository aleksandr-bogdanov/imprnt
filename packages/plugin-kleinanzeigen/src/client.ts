// imprnt · kleinanzeigen plugin — the network edge. The ONLY module that may touch the wire.
//
// Wired against the real Kleinanzeigen message-box API (gateway.kleinanzeigen.de/messagebox), captured
// from a logged-in session. The endpoints live in `endpoints.json` (run `probe --har` to generate it).
// Auth is the user's .kleinanzeigen.de session cookies, read from the file named by KLEINANZEIGEN_COOKIES
// — never hardcoded, never committed. Until cookies + endpoints exist, every wire call fails LOUD.
//
// Two-sided: the message box holds BOTH the threads where you're the seller (someone's buying your ad)
// and the threads where you're the buyer (you contacted someone's ad). We keep both, tagging each with
// `side` and the right counterpart. `from: "me"` is outbound (you), `from: "them"` is the counterpart.
//
// Two offline doors so the whole pipeline is exercisable with ZERO network:
//   KLEINANZEIGEN_FIXTURES=<dir>  read conversations from *.json there instead of the wire
//   KLEINANZEIGEN_DRY_RUN=1       `send`/`contact` record intent without posting
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Msg } from "./mirror.ts";
import { liveAuth } from "./browser-auth.ts";

export type RawConv = {
  conv: string;
  side: "selling" | "buying";
  listing: string;
  ad_title: string;
  counterpart: string;
  ad_status: string;
  unread: number;
  synthetic?: boolean;
  messages: Msg[];
  // The per-conversation detail fetch failed (transient 429/5xx, bad JSON): messages is empty because
  // we couldn't read them, not because there are none. sync must keep the prior mirror file, not wipe it.
  detail_failed?: boolean;
};

export type Endpoints = {
  transport: string;
  base: string;
  userId: string;
  listPath: string;
  detailPath: string;
  replyPath: string | null;
  contactPath?: string;
  contacterName?: string;
  headers: Record<string, string>;
  note?: string;
};

const PROBE_HINT =
  "no endpoints.json — the live transport isn't wired yet.\n" +
  "  Generate it from a message-box HAR:  node kleinanzeigen.js probe --har <file.har>\n" +
  "  Or run offline against fixtures:      KLEINANZEIGEN_FIXTURES=./fixtures node kleinanzeigen.js sync";

const AUTH_HINT =
  "no live session — couldn't get a kleinanzeigen access_token.\n" +
  "  Best: run the session host (`session-host serve`) and enroll once (`session-host login ...`).\n" +
  "  Or log into kleinanzeigen.de in Arc and approve the Keychain prompt, or set\n" +
  "  KLEINANZEIGEN_TOKEN=<jwt> / KLEINANZEIGEN_COOKIES=<file>. Offline: KLEINANZEIGEN_FIXTURES=./fixtures.";

export function loadEndpoints(here: string): Endpoints | null {
  const p = join(here, "endpoints.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as Endpoints; } catch { return null; }
}

// A raw fixture row, as authored in fixtures/*.json. Author can be the new (me/them) or legacy
// (buyer/seller) vocabulary; normalizeAuthor folds both into me/them.
type FixtureRow = {
  conv?: string;
  side?: string;
  listing?: string;
  ad_title?: string;
  counterpart?: string;
  ad_status?: string;
  unread?: number;
  synthetic?: boolean;
  messages?: Array<{ from?: string; at?: string; body?: string }>;
};

function readFixtures(dir: string): FixtureRow[] {
  if (!existsSync(dir)) throw new Error(`KLEINANZEIGEN_FIXTURES points at a missing dir: ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as FixtureRow);
}

function fill(tmpl: string, vars: Record<string, string | number>): string {
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

// Map the message-box JSON into our Msg shape. boundness OUTBOUND = you, anything else = the counterpart.
function toMsgs(messages: Array<{ textShort?: string; boundness?: string; receivedDate?: string }>): Msg[] {
  return messages.map((m) => ({
    from: m.boundness === "OUTBOUND" ? "me" : "them",
    at: m.receivedDate ?? "",
    body: (m.textShort ?? "").trim(),
  }));
}

// Fold any author label into me/them. me/seller/OUTBOUND → me (you authored it), everything else → them.
// (The fixtures predate the rename and still say buyer/seller; the live path already emits me/them.)
export function normalizeAuthor(from: string | undefined): Msg["from"] {
  return from === "me" || from === "seller" || from === "OUTBOUND" ? "me" : "them";
}

const clean = (v: unknown) => String(v ?? "").trim();

// Turn fixture rows into RawConv, normalizing the author vocabulary and defaulting the new fields.
export function fixturesToConvs(rows: FixtureRow[]): RawConv[] {
  return rows.map((f) => ({
    conv: String(f.conv ?? ""),
    side: f.side === "buying" ? "buying" : "selling",
    listing: String(f.listing ?? ""),
    ad_title: String(f.ad_title ?? ""),
    counterpart: String(f.counterpart ?? ""),
    ad_status: String(f.ad_status ?? ""),
    unread: Number(f.unread ?? 0) || 0,
    synthetic: f.synthetic ?? false,
    messages: (f.messages ?? []).map((m) => ({ from: normalizeAuthor(m.from), at: m.at ?? "", body: (m.body ?? "").trim() })),
  }));
}

// Fetch every conversation (both sides) with FULL message bodies. Fixtures win when the env var is set
// (offline). Live path: Bearer-auth with the access_token from the local browser session, GET the
// conversation list, then GET each conversation's detail for the full thread. `role` decides side and
// which name is the counterpart (Buyer → you're buying, the seller is the counterpart; else selling).
// The list view trims long messages, so the detail fetch is what makes classification honest.
export async function fetchConversations(here: string): Promise<RawConv[]> {
  const fixtures = process.env.KLEINANZEIGEN_FIXTURES;
  if (fixtures) return fixturesToConvs(readFixtures(fixtures));

  const ep = loadEndpoints(here);
  if (!ep) throw new Error(PROBE_HINT);
  const auth = await liveAuth();
  if (!auth) throw new Error(AUTH_HINT);

  const headers = { ...ep.headers, authorization: `Bearer ${auth.token}` };
  const listUrl = ep.base + fill(ep.listPath, { userId: ep.userId, page: 0, size: 100 });
  const listRes = await fetch(listUrl, { headers });
  if (!listRes.ok) throw new Error(`list fetch ${listRes.status} ${listRes.statusText} — session expired? reload kleinanzeigen.de in your browser`);
  const list = (await listRes.json()) as {
    conversations?: Array<{
      id: string; adId?: string; adTitle?: string; adStatus?: string;
      buyerName?: string; sellerName?: string; role?: string; unreadMessagesCount?: number;
    }>;
  };
  const convs = list.conversations ?? [];

  const out: RawConv[] = [];
  for (let i = 0; i < convs.length; i++) {
    const c = convs[i];
    // A small politeness gap between detail GETs — up to 100 back-to-back requests is how you earn
    // the transient 429 that used to blank threads (the bulk search path waits 1500ms per page).
    if (i > 0) await new Promise((r) => setTimeout(r, 250));
    const role = c.role ?? "Seller";
    const side: RawConv["side"] = role === "Buyer" ? "buying" : "selling";
    const detUrl = ep.base + fill(ep.detailPath, { userId: ep.userId, convId: c.id });
    // null = the detail fetch FAILED (non-2xx, unparseable body, or an error body without .messages).
    // A single failed detail must not sink the whole sync — but it must not be mistaken for an empty
    // thread either, so it's flagged and sync keeps the prior mirror file untouched.
    let messages: Msg[] | null = null;
    try {
      const detRes = await fetch(detUrl, { headers });
      if (detRes.ok) {
        const det = (await detRes.json()) as { messages?: Array<{ textShort?: string; boundness?: string; receivedDate?: string }> };
        if (Array.isArray(det.messages)) messages = toMsgs(det.messages);
      }
    } catch { /* fall through: messages stays null */ }
    out.push({
      conv: String(c.id),
      side,
      listing: clean(c.adId),
      ad_title: clean(c.adTitle),
      counterpart: clean(role === "Buyer" ? c.sellerName : c.buyerName),
      ad_status: clean(c.adStatus),
      unread: Number(c.unreadMessagesCount ?? 0) || 0,
      synthetic: false,
      messages: messages ?? [],
      detail_failed: messages === null,
    });
  }
  return out;
}

export type SendResult = { delivered: boolean; dryRun: boolean; note: string };

// Post one reply. Dry-run / fixtures mode records intent without a wire call. The live reply endpoint
// (replyPath) is captured separately — until it's set, live send refuses loudly rather than guessing
// a POST shape that could mis-send.
export async function postReply(here: string, conv: string, text: string): Promise<SendResult> {
  if (process.env.KLEINANZEIGEN_DRY_RUN || process.env.KLEINANZEIGEN_FIXTURES) {
    return { delivered: false, dryRun: true, note: `dry-run: reply to ${conv} recorded, not sent` };
  }
  const ep = loadEndpoints(here);
  if (!ep) throw new Error(PROBE_HINT);
  if (!ep.replyPath) {
    throw new Error(
      "replyPath is not set in endpoints.json — the send-a-message request hasn't been captured yet.\n" +
      "  Capture one reply with devtools open (Network → the POST when you send), add its path as replyPath,\n" +
      "  or use KLEINANZEIGEN_DRY_RUN=1 to record intent. Read stays fully wired; send waits on this one capture.",
    );
  }
  const auth = await liveAuth();
  if (!auth) throw new Error(AUTH_HINT);
  const url = ep.base + fill(ep.replyPath, { userId: ep.userId, convId: conv });
  const res = await fetch(url, {
    method: "POST",
    headers: { ...ep.headers, authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
    body: JSON.stringify({ message: text }),
  });
  if (res.status === 401) throw new Error("reply POST 401 — session expired; reload kleinanzeigen.de in your browser, then retry");
  if (!res.ok) {
    // Surface the server's validation message — if the { message } body shape is wrong, the 4xx body
    // names the field it wants, which is how the first live send confirms (and corrects) the schema.
    const body = await res.text().catch(() => "");
    throw new Error(`reply POST ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`);
  }
  return { delivered: true, dryRun: false, note: `reply sent to ${conv}` };
}

// ── contact: start a NEW conversation on someone else's ad ───────────────────────────────────────────
// The buying-side mirror image of postReply. Creates the conversation and posts exactly ONE message.
// The create-conversation API needs a `contacter` display name (yours), set as `contacterName` in
// endpoints.json. Dry-run / fixtures prints the FULL constructed request (auth redacted) and makes NO
// network call, so you can eyeball the exact wire shape before ever sending for real.
const CONTACT_AUTH_HINT =
  "no live session — couldn't get a kleinanzeigen access_token, so nothing was sent.\n" +
  "  Log into your real account once:  node plugins/session-host/session-host.js login kleinanzeigen.de\n" +
  "  Then make sure the broker is serving: node plugins/session-host/session-host.js serve";

const DEFAULT_CONTACT_PATH = "/users/{userId}/conversations";

// Redact the Authorization header for the dry-run print — the token is read live at send time and must
// never land in a log. Every other header passes through verbatim so the dry-run is honest.
function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase() === "authorization" ? "Bearer <redacted — read live from your session at send time>" : v;
  }
  return out;
}

export async function postContact(
  here: string,
  adId: string,
  text: string,
  opts: { dryRun?: boolean } = {},
): Promise<SendResult> {
  const ep = loadEndpoints(here);
  if (!ep) throw new Error(PROBE_HINT);
  const contactPath = ep.contactPath ?? DEFAULT_CONTACT_PATH;
  const url = ep.base + fill(contactPath, { userId: ep.userId, adId });
  const headers = { ...ep.headers, "content-type": "application/json" };
  const contacter = ep.contacterName;
  if (!contacter) {
    throw new Error(
      'contacterName is not set in endpoints.json — add your Kleinanzeigen display name (the create-conversation API requires a "contacter"), e.g. "contacterName": "Alex".',
    );
  }
  const body = { adId: Number(adId), contacter: { name: contacter }, message: text };
  const dryRun = !!opts.dryRun || !!process.env.KLEINANZEIGEN_DRY_RUN || !!process.env.KLEINANZEIGEN_FIXTURES;
  if (dryRun) {
    const shown = redactHeaders({ ...headers, authorization: "Bearer x" });
    const lines = ["  --- dry-run: the request that WOULD be sent (no network call made) ---", `  POST ${url}`];
    for (const [k, v] of Object.entries(shown)) lines.push(`  ${k}: ${v}`);
    lines.push(`  body: ${JSON.stringify(body)}`, "  --- end dry-run ---");
    console.log(lines.join("\n"));
    return { delivered: false, dryRun: true, note: `dry-run: would start a new conversation on ad ${adId} — NOT sent` };
  }
  const auth = await liveAuth();
  if (!auth) throw new Error(CONTACT_AUTH_HINT);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, authorization: `Bearer ${auth.token}` },
    body: JSON.stringify(body),
  });
  if (res.status === 401) throw new Error("contact POST 401 — session expired; reload kleinanzeigen.de in your browser, then retry");
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`contact POST ${res.status} ${res.statusText}${b ? ` — ${b.slice(0, 300)}` : ""}`);
  }
  let convId = "";
  try {
    const j = (await res.json()) as { id?: string; conversationId?: string };
    convId = j?.id ?? j?.conversationId ?? "";
  } catch { /* the conv id is a nicety, not required */ }
  return { delivered: true, dryRun: false, note: `new conversation started on ad ${adId}${convId ? ` (conv ${convId})` : ""} — run sync to mirror it` };
}
