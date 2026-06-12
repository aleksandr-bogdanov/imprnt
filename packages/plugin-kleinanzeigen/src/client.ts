// imprnt · kleinanzeigen plugin — the network edge. The ONLY module that may touch the wire.
//
// Wired against the real Kleinanzeigen message-box API (gateway.kleinanzeigen.de/messagebox), captured
// from a logged-in session. The endpoints live in `endpoints.json` (run `probe --har` to generate it).
// Auth is the user's .kleinanzeigen.de session cookies, read from the file named by KLEINANZEIGEN_COOKIES
// — never hardcoded, never committed. Until cookies + endpoints exist, every wire call fails LOUD.
//
// Two offline doors so the whole pipeline is exercisable with ZERO network:
//   KLEINANZEIGEN_FIXTURES=<dir>  read conversations from *.json there instead of the wire
//   KLEINANZEIGEN_DRY_RUN=1       `send` records intent without posting
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Msg } from "./mirror.ts";
import { liveAuth } from "./browser-auth.ts";

export type RawConv = {
  conv: string;
  listing: string;
  counterpart: string;
  synthetic?: boolean;
  messages: Msg[];
};

export type Endpoints = {
  transport: string;
  base: string;
  userId: string;
  listPath: string;
  detailPath: string;
  replyPath: string | null;
  headers: Record<string, string>;
  note?: string;
};

const PROBE_HINT =
  "no endpoints.json — the live transport isn't wired yet.\n" +
  "  Generate it from a message-box HAR:  node kleinanzeigen.js probe --har <file.har>\n" +
  "  Or run offline against fixtures:      KLEINANZEIGEN_FIXTURES=./fixtures node kleinanzeigen.js sync";

const AUTH_HINT =
  "no live session — couldn't read your kleinanzeigen access_token.\n" +
  "  Log into kleinanzeigen.de in Arc (or Chrome/Brave/Edge) and approve the Keychain prompt, or set\n" +
  "  KLEINANZEIGEN_TOKEN=<jwt> / KLEINANZEIGEN_COOKIES=<file>. Offline: KLEINANZEIGEN_FIXTURES=./fixtures.";

export function loadEndpoints(here: string): Endpoints | null {
  const p = join(here, "endpoints.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf8")) as Endpoints; } catch { return null; }
}

function readFixtures(dir: string): RawConv[] {
  if (!existsSync(dir)) throw new Error(`KLEINANZEIGEN_FIXTURES points at a missing dir: ${dir}`);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as RawConv);
}

function fill(tmpl: string, vars: Record<string, string | number>): string {
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}

// Map the message-box JSON into our RawConv shape. boundness INBOUND = from the buyer, OUTBOUND = us.
function toMsgs(messages: Array<{ textShort?: string; boundness?: string; receivedDate?: string }>): Msg[] {
  return messages.map((m) => ({
    from: m.boundness === "OUTBOUND" ? "seller" : "buyer",
    at: m.receivedDate ?? "",
    body: (m.textShort ?? "").trim(),
  }));
}

// Fetch every conversation where the user is the SELLER, with FULL message bodies. Fixtures win when
// the env var is set (offline). Live path: Bearer-auth with the access_token from the local browser
// session, GET the conversation list, KEEP only role=Seller (the message box also holds threads where
// the user is the buyer on someone else's ad — not what a selling-watcher triages), then GET each
// conversation's detail for the full thread. The list view trims long messages, so the detail fetch is
// what makes classification honest (a "kann ich abholen" tail that the list cut would misread).
export async function fetchConversations(here: string): Promise<RawConv[]> {
  const fixtures = process.env.KLEINANZEIGEN_FIXTURES;
  if (fixtures) return readFixtures(fixtures);

  const ep = loadEndpoints(here);
  if (!ep) throw new Error(PROBE_HINT);
  const auth = liveAuth();
  if (!auth) throw new Error(AUTH_HINT);

  const headers = { ...ep.headers, authorization: `Bearer ${auth.token}` };
  const listUrl = ep.base + fill(ep.listPath, { userId: ep.userId, page: 0, size: 100 });
  const listRes = await fetch(listUrl, { headers });
  if (!listRes.ok) throw new Error(`list fetch ${listRes.status} ${listRes.statusText} — session expired? reload kleinanzeigen.de in your browser`);
  const list = (await listRes.json()) as { conversations: Array<{ id: string; adId: string; buyerName: string; role?: string }> };
  const selling = list.conversations.filter((c) => (c.role ?? "Seller") === "Seller");

  const out: RawConv[] = [];
  for (const c of selling) {
    const detUrl = ep.base + fill(ep.detailPath, { userId: ep.userId, convId: c.id });
    let messages: Msg[];
    try {
      const detRes = await fetch(detUrl, { headers });
      const det = (await detRes.json()) as { messages?: Array<{ textShort?: string; boundness?: string; receivedDate?: string }> };
      messages = toMsgs(det.messages ?? []);
    } catch {
      messages = []; // a single failed detail must not sink the whole sync
    }
    out.push({ conv: c.id, listing: c.adId, counterpart: c.buyerName, synthetic: false, messages });
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
  const auth = liveAuth();
  if (!auth) throw new Error(AUTH_HINT);
  const url = ep.base + fill(ep.replyPath, { userId: ep.userId, convId: conv });
  const res = await fetch(url, {
    method: "POST",
    headers: { ...ep.headers, authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
    body: JSON.stringify({ message: text }),
  });
  if (!res.ok) throw new Error(`reply POST ${res.status} ${res.statusText}`);
  return { delivered: true, dryRun: false, note: `reply sent to ${conv}` };
}
