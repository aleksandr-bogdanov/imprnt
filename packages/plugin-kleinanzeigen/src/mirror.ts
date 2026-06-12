// imprnt · kleinanzeigen plugin — the local mirror (read/write).
//
// The mirror is the plugin's OWN cache of message-box state, one markdown file per conversation. It is
// the render-at-read source: the agent reads these files, never the wire. `sync` writes them, `rate`
// annotates them, `notify`/`send`/`check` read them.
//
// EVERY message body lives inside a ```text fence. That's the injection seam made physical: hostile
// buyer text is DATA, set apart from the structured fields the code trusts. The frontmatter carries
// only typed, code-produced values (rating, tells, ids) — never raw buyer prose.
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Msg = { from: "buyer" | "seller"; at: string; body: string };

export type Conversation = {
  conv: string;
  listing: string;
  counterpart: string;
  state: "open" | "answered" | "closed";
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

const FENCE = "```text";

export function serializeConversation(c: Conversation): string {
  const fm: [string, unknown][] = [
    ["conv", c.conv],
    ["listing", c.listing],
    ["counterpart", c.counterpart],
    ["state", c.state],
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
  const title = `# ${c.counterpart} — listing ${c.listing}`;
  const body: string[] = ["", "## Messages", ""];
  for (const m of c.messages) {
    body.push(`### ${m.from} · ${m.at}`, FENCE, m.body, "```", "");
  }
  return [...head, title, ...body].join("\n");
}

export function parseConversation(text: string): Conversation {
  const lines = text.split(/\r?\n/);
  const c: Conversation = { conv: "", listing: "", counterpart: "", state: "open", synthetic: false, messages: [] };

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
        case "listing": c.listing = String(val); break;
        case "counterpart": c.counterpart = String(val); break;
        case "state": c.state = String(val) as Conversation["state"]; break;
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

  // messages: ### <from> · <at> then a ```text fence until ```
  for (; i < lines.length; i++) {
    const h = lines[i].match(/^###\s+(buyer|seller)\s+·\s+(.*)$/);
    if (!h) continue;
    const from = h[1] as Msg["from"];
    const at = h[2].trim();
    // next non-empty line should open the fence
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "") j++;
    if (lines[j]?.trim() !== FENCE && lines[j]?.trim() !== "```") continue;
    j++;
    const buf: string[] = [];
    while (j < lines.length && lines[j].trim() !== "```") { buf.push(lines[j]); j++; }
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

// The most recent buyer message — what the rater classifies. Seller replies are ignored for rating.
export function latestBuyerMessage(c: Conversation): Msg | null {
  for (let k = c.messages.length - 1; k >= 0; k--) {
    if (c.messages[k].from === "buyer") return c.messages[k];
  }
  return null;
}
