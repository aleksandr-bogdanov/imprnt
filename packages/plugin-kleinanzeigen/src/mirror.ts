// imprnt · kleinanzeigen plugin — the local mirror (read/write).
//
// The mirror is the plugin's OWN cache of message-box state, one markdown file per conversation. It is
// the render-at-read source: the agent reads these files, never the wire. `sync` writes them, `rate`
// annotates them, `notify`/`send`/`check` read them.
//
// Two-sided: a conversation is either `selling` (you posted the ad, the counterpart is a buyer) or
// `buying` (you contacted someone else's ad, the counterpart is the seller). `from: "me"` is YOUR
// message (outbound), `from: "them"` is the counterpart's (inbound) — independent of side.
//
// EVERY message body lives inside a code fence. That's the injection seam made physical: hostile
// counterpart text is DATA, set apart from the structured fields the code trusts. The frontmatter
// carries only typed, code-produced values (rating, tells, ids) — never raw counterpart prose. The
// fence is ADAPTIVE: a body that itself contains a run of backticks gets a longer fence (fenceFor),
// so a pasted ```code block``` can't break the message out of its quote.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Msg = { from: "me" | "them"; at: string; body: string };

export type Conversation = {
  conv: string;
  side?: "selling" | "buying"; // which role you're in; absent on legacy files → treated as selling
  listing: string;
  ad_title?: string;
  ad_status?: string;
  counterpart: string;
  state: "open" | "closed"; // legacy "answered" still parses and is treated as open
  awaiting?: "me" | "them" | "none"; // whose turn it is — set by turnAwaiting()
  unread: number;
  synthetic: boolean;
  messages: Msg[];
  // rating fields (populated by `rate`, absent until then)
  rating?: string;
  tells?: string[];
  needs_fact?: string[];
  draft?: string | null;
  offer_amount?: number | null;
  below_floor?: boolean;
  last_message_at?: string;
  synced?: string;
};

// ── a tiny frontmatter serializer/parser (flat subset, no dependency) ───────────────────────────────
// Supports: string, number, boolean, and inline string list `[a, b]`. Single-line values only — our
// drafts are one line by construction, and any newline in a value is collapsed to a space on write.
function ser(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => String(v)).join(", ")}]`;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (value === null || value === undefined) return "";
  return JSON.stringify(String(value).replace(/\r?\n/g, " ")); // quote strings, escape safely
}

function parseScalar(raw: string): string | number | boolean | string[] | null {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v.startsWith('"')) {
    try { return JSON.parse(v) as string; } catch { return v; }
  }
  return v;
}

// The shortest fence that the body cannot contain: a backtick run one longer than the longest run in
// the body, never below 3. So a message that pastes a ```` ```code``` ```` block is still quoted whole.
export function fenceFor(body: string): string {
  let max = 0;
  for (const m of String(body).matchAll(/`+/g)) max = Math.max(max, m[0].length);
  return "`".repeat(Math.max(3, max + 1));
}

export function serializeConversation(c: Conversation): string {
  const fm: [string, unknown][] = [
    ["conv", c.conv],
    ["side", c.side ?? "selling"],
    ["listing", c.listing],
    ["ad_title", c.ad_title ?? ""],
    ["ad_status", c.ad_status ?? ""],
    ["counterpart", c.counterpart],
    ["state", c.state],
    ["awaiting", c.awaiting ?? "none"],
    ["unread", c.unread ?? 0],
    ["synthetic", c.synthetic],
  ];
  if (c.rating !== undefined) fm.push(["rating", c.rating]);
  if (c.tells !== undefined) fm.push(["tells", c.tells]);
  if (c.needs_fact !== undefined) fm.push(["needs_fact", c.needs_fact]);
  if (c.draft !== undefined) fm.push(["draft", c.draft]);
  if (c.offer_amount !== undefined && c.offer_amount !== null) fm.push(["offer_amount", c.offer_amount]);
  if (c.below_floor !== undefined) fm.push(["below_floor", c.below_floor]);
  if (c.last_message_at !== undefined) fm.push(["last_message_at", c.last_message_at]);
  if (c.synced !== undefined) fm.push(["synced", c.synced]);

  const head = ["---", ...fm.map(([k, v]) => `${k}: ${ser(v)}`), "---", ""];
  const title = `# ${c.counterpart} — ${c.ad_title ? c.ad_title : `listing ${c.listing}`}`;
  const body: string[] = ["", "## Messages", ""];
  for (const m of c.messages) {
    const f = fenceFor(m.body);
    body.push(`### ${m.from} · ${m.at}`, f + "text", m.body, f, "");
  }
  return [...head, title, ...body].join("\n");
}

export function parseConversation(text: string): Conversation {
  const lines = text.split(/\r?\n/);
  const c: Conversation = {
    conv: "", side: "selling", listing: "", ad_title: "", ad_status: "",
    counterpart: "", state: "open", awaiting: "none", unread: 0, synthetic: false, messages: [],
  };

  // frontmatter
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    for (; i < lines.length; i++) {
      if (lines[i].trim() === "---") { i++; break; }
      const m = lines[i].match(/^([a-z_]+):\s*(.*)$/i);
      if (!m) continue;
      const key = m[1];
      const val = parseScalar(m[2]);
      switch (key) {
        case "conv": c.conv = String(val); break;
        case "side": c.side = String(val) === "buying" ? "buying" : "selling"; break;
        case "listing": c.listing = String(val); break;
        case "ad_title": c.ad_title = val === "" ? "" : String(val); break;
        case "ad_status": c.ad_status = val === "" ? "" : String(val); break;
        case "counterpart": c.counterpart = String(val); break;
        // free string here: a legacy "answered" round-trips unchanged and the filters treat it as open.
        case "state": c.state = String(val) as Conversation["state"]; break;
        case "awaiting": c.awaiting = ["me", "them", "none"].includes(String(val)) ? (String(val) as Conversation["awaiting"]) : "none"; break;
        case "unread": c.unread = typeof val === "number" ? val : 0; break;
        case "synthetic": c.synthetic = val === true; break;
        case "rating": c.rating = String(val); break;
        case "tells": c.tells = Array.isArray(val) ? val : []; break;
        case "needs_fact": c.needs_fact = Array.isArray(val) ? val : []; break;
        case "draft": c.draft = val === "" ? null : String(val); break;
        case "offer_amount": c.offer_amount = typeof val === "number" ? val : null; break;
        case "below_floor": c.below_floor = val === true; break;
        case "last_message_at": c.last_message_at = String(val); break;
        case "synced": c.synced = String(val); break;
      }
    }
  }

  // messages: ### <from> · <at> then an adaptive fence (legacy `me|them|buyer|seller` headers map in).
  // The opening fence is captured (3+ backticks); the body runs until a line equal to that exact run.
  for (; i < lines.length; i++) {
    const h = lines[i].match(/^###\s+(me|them|buyer|seller)\s+·\s+(.*)$/);
    if (!h) continue;
    const from: Msg["from"] = h[1] === "seller" ? "me" : h[1] === "buyer" ? "them" : (h[1] as Msg["from"]);
    const at = h[2].trim();
    // next non-empty line should open the fence
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    const open = lines[j]?.match(/^(`{3,})/);
    if (!open) continue;
    const close = open[1];
    j++;
    const buf: string[] = [];
    while (j < lines.length && lines[j].trim() !== close) { buf.push(lines[j]); j++; }
    c.messages.push({ from, at, body: buf.join("\n").trim() });
    i = j;
  }
  return c;
}

export function writeConversation(mirrorDir: string, c: Conversation): string {
  mkdirSync(mirrorDir, { recursive: true });
  const p = join(mirrorDir, `${c.conv}.md`);
  writeFileSync(p, serializeConversation(c));
  return p;
}

export function readConversation(path: string): Conversation {
  return parseConversation(readFileSync(path, "utf8"));
}

export function listConversations(mirrorDir: string): Conversation[] {
  if (!existsSync(mirrorDir)) return [];
  return readdirSync(mirrorDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => readConversation(join(mirrorDir, f)));
}

// The most recent COUNTERPART message — what the rater classifies. Your own replies are ignored.
export function latestCounterpartMessage(c: Conversation): Msg | null {
  for (let k = c.messages.length - 1; k >= 0; k--) {
    if (c.messages[k].from === "them") return c.messages[k];
  }
  return null;
}

export function lastMessage(c: Conversation): Msg | null {
  return c.messages.length ? c.messages[c.messages.length - 1] : null;
}

// A system "Anfrage abgelehnt/beendet/zurückgezogen" line is the platform speaking, not the
// counterpart — a dead thread, nobody's turn. Matched both German and English, with optional . / !.
export const KA_SYSTEM_DEAD = /^(anfrage (abgelehnt|beendet|zur[üu]ckgezogen)|request (declined|ended|withdrawn))[.!]?$/i;

// Whose turn it is. Closed → none. No messages → none. A dead-thread system line from them → none.
// Otherwise: the last message was theirs → it's your move; the last was yours → you're waiting on them.
export function turnAwaiting(c: Conversation): "me" | "them" | "none" {
  if (c.state === "closed") return "none";
  const last = lastMessage(c);
  if (!last) return "none";
  if (last.from === "them" && KA_SYSTEM_DEAD.test(last.body.trim())) return "none";
  return last.from === "them" ? "me" : "them";
}
