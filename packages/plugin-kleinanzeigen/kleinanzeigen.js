#!/usr/bin/env node

// src/kleinanzeigen.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync5, readFileSync as readFileSync5, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join5, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// src/client.ts
import { existsSync as existsSync2, readFileSync as readFileSync2, readdirSync } from "node:fs";
import { join as join2 } from "node:path";

// src/browser-auth.ts
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
var printable = (s) => /^[\x20-\x7E]*$/.test(s);
var BROWSERS = [
  { name: "Arc", keychain: "Arc Safe Storage", cookieDir: "Arc/User Data/Default" },
  { name: "Chrome", keychain: "Chrome Safe Storage", cookieDir: "Google/Chrome/Default" },
  { name: "Brave", keychain: "Brave Safe Storage", cookieDir: "BraveSoftware/Brave-Browser/Default" },
  { name: "Edge", keychain: "Microsoft Edge Safe Storage", cookieDir: "Microsoft Edge/Default" }
];
function keychainKey(service) {
  try {
    return execFileSync("security", ["find-generic-password", "-ws", service], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}
function decryptValue(encHex, derived) {
  const buf = Buffer.from(encHex, "hex");
  if (buf.length < 4)
    return null;
  const ver = buf.subarray(0, 3).toString();
  if (ver !== "v10" && ver !== "v11")
    return null;
  const d = crypto.createDecipheriv("aes-128-cbc", derived, Buffer.alloc(16, " "));
  d.setAutoPadding(false);
  let out = Buffer.concat([d.update(buf.subarray(3)), d.final()]);
  const pad = out[out.length - 1];
  if (pad > 0 && pad <= 16)
    out = out.subarray(0, out.length - pad);
  const full = out.toString("latin1");
  const stripped = out.subarray(32).toString("latin1");
  if (printable(full))
    return full;
  if (printable(stripped))
    return stripped;
  return null;
}
function liveAuth() {
  if (process.env.KLEINANZEIGEN_TOKEN)
    return { token: process.env.KLEINANZEIGEN_TOKEN.trim(), source: "KLEINANZEIGEN_TOKEN" };
  const jar = process.env.KLEINANZEIGEN_COOKIES;
  if (jar && existsSync(jar)) {
    const raw = readFileSync(jar, "utf8");
    const m = raw.match(/access_token=([^;\s]+)/);
    if (m)
      return { token: m[1], source: "KLEINANZEIGEN_COOKIES" };
    if (raw.trim().split(".").length === 3)
      return { token: raw.trim(), source: "KLEINANZEIGEN_COOKIES (raw jwt)" };
  }
  for (const b of BROWSERS) {
    const dbPath = join(homedir(), "Library", "Application Support", b.cookieDir, "Cookies");
    if (!existsSync(dbPath))
      continue;
    const key = keychainKey(b.keychain);
    if (!key)
      continue;
    const derived = crypto.pbkdf2Sync(key, "saltysalt", 1003, 16, "sha1");
    const tmp = mkdtempSync(join(tmpdir(), "ka-auth-"));
    for (const f of ["Cookies", "Cookies-wal", "Cookies-shm"]) {
      const s = join(homedir(), "Library", "Application Support", b.cookieDir, f);
      if (existsSync(s))
        try {
          copyFileSync(s, join(tmp, f));
        } catch {}
    }
    let rows;
    try {
      rows = execFileSync("sqlite3", [
        join(tmp, "Cookies"),
        "SELECT name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '%kleinanzeigen%' AND name='access_token';"
      ], { encoding: "utf8" });
    } catch {
      continue;
    }
    for (const line of rows.trim().split(/\r?\n/)) {
      const [name, hex] = line.split("|");
      if (name !== "access_token" || !hex)
        continue;
      const val = decryptValue(hex, derived);
      if (val && val.split(".").length === 3)
        return { token: val, source: `${b.name} session` };
    }
  }
  return null;
}

// src/client.ts
var PROBE_HINT = `no endpoints.json — the live transport isn't wired yet.
` + `  Generate it from a message-box HAR:  node kleinanzeigen.js probe --har <file.har>
` + "  Or run offline against fixtures:      KLEINANZEIGEN_FIXTURES=./fixtures node kleinanzeigen.js sync";
var AUTH_HINT = `no live session — couldn't read your kleinanzeigen access_token.
` + `  Log into kleinanzeigen.de in Arc (or Chrome/Brave/Edge) and approve the Keychain prompt, or set
` + "  KLEINANZEIGEN_TOKEN=<jwt> / KLEINANZEIGEN_COOKIES=<file>. Offline: KLEINANZEIGEN_FIXTURES=./fixtures.";
function loadEndpoints(here) {
  const p = join2(here, "endpoints.json");
  if (!existsSync2(p))
    return null;
  try {
    return JSON.parse(readFileSync2(p, "utf8"));
  } catch {
    return null;
  }
}
function readFixtures(dir) {
  if (!existsSync2(dir))
    throw new Error(`KLEINANZEIGEN_FIXTURES points at a missing dir: ${dir}`);
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync2(join2(dir, f), "utf8")));
}
function fill(tmpl, vars) {
  return tmpl.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));
}
function toMsgs(messages) {
  return messages.map((m) => ({
    from: m.boundness === "OUTBOUND" ? "seller" : "buyer",
    at: m.receivedDate ?? "",
    body: (m.textShort ?? "").trim()
  }));
}
async function fetchConversations(here) {
  const fixtures = process.env.KLEINANZEIGEN_FIXTURES;
  if (fixtures)
    return readFixtures(fixtures);
  const ep = loadEndpoints(here);
  if (!ep)
    throw new Error(PROBE_HINT);
  const auth = liveAuth();
  if (!auth)
    throw new Error(AUTH_HINT);
  const headers = { ...ep.headers, authorization: `Bearer ${auth.token}` };
  const listUrl = ep.base + fill(ep.listPath, { userId: ep.userId, page: 0, size: 100 });
  const listRes = await fetch(listUrl, { headers });
  if (!listRes.ok)
    throw new Error(`list fetch ${listRes.status} ${listRes.statusText} — session expired? reload kleinanzeigen.de in your browser`);
  const list = await listRes.json();
  const selling = list.conversations.filter((c) => (c.role ?? "Seller") === "Seller");
  const out = [];
  for (const c of selling) {
    const detUrl = ep.base + fill(ep.detailPath, { userId: ep.userId, convId: c.id });
    let messages;
    try {
      const detRes = await fetch(detUrl, { headers });
      const det = await detRes.json();
      messages = toMsgs(det.messages ?? []);
    } catch {
      messages = [];
    }
    out.push({ conv: c.id, listing: c.adId, counterpart: c.buyerName, synthetic: false, messages });
  }
  return out;
}
async function postReply(here, conv, text) {
  if (process.env.KLEINANZEIGEN_DRY_RUN || process.env.KLEINANZEIGEN_FIXTURES) {
    return { delivered: false, dryRun: true, note: `dry-run: reply to ${conv} recorded, not sent` };
  }
  const ep = loadEndpoints(here);
  if (!ep)
    throw new Error(PROBE_HINT);
  if (!ep.replyPath) {
    throw new Error(`replyPath is not set in endpoints.json — the send-a-message request hasn't been captured yet.
` + `  Capture one reply with devtools open (Network → the POST when you send), add its path as replyPath,
` + "  or use KLEINANZEIGEN_DRY_RUN=1 to record intent. Read stays fully wired; send waits on this one capture.");
  }
  const auth = liveAuth();
  if (!auth)
    throw new Error(AUTH_HINT);
  const url = ep.base + fill(ep.replyPath, { userId: ep.userId, convId: conv });
  const res = await fetch(url, {
    method: "POST",
    headers: { ...ep.headers, authorization: `Bearer ${auth.token}`, "content-type": "application/json" },
    body: JSON.stringify({ message: text })
  });
  if (res.status === 401)
    throw new Error("reply POST 401 — session expired; reload kleinanzeigen.de in your browser, then retry");
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`reply POST ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 300)}` : ""}`);
  }
  return { delivered: true, dryRun: false, note: `reply sent to ${conv}` };
}

// src/facts.ts
import { existsSync as existsSync3, readFileSync as readFileSync3 } from "node:fs";
import { join as join3 } from "node:path";
function emptyFacts(listing) {
  return {
    listing,
    model: "",
    variant: "",
    artikelnummer: "",
    includes: [],
    condition: "",
    age: "",
    software: "",
    cable: "",
    price: null,
    floor: null,
    pickup_area: "",
    shipping: ""
  };
}
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && (t[0] === '"' && t.at(-1) === '"' || t[0] === "'" && t.at(-1) === "'")) {
    return t.slice(1, -1);
  }
  return t;
}
function parseFacts(text, listingFallback = "") {
  const f = emptyFacts(listingFallback);
  const lines = text.split(/\r?\n/);
  let listKey = null;
  for (const raw of lines) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim())
      continue;
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      f[listKey].push(unquote(item[1]));
      continue;
    }
    const kv = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv)
      continue;
    const key = kv[1];
    const value = kv[2].trim();
    listKey = null;
    if (key === "includes") {
      if (value === "") {
        listKey = "includes";
        continue;
      }
      const inner = value.replace(/^\[/, "").replace(/\]$/, "");
      f.includes = inner.split(",").map((s) => unquote(s)).filter((s) => s.length > 0);
      continue;
    }
    if (key === "price" || key === "floor") {
      const n = Number(value);
      f[key] = Number.isFinite(n) ? n : null;
      continue;
    }
    if (key in f) {
      f[key] = unquote(value);
    }
  }
  return f;
}
function loadFacts(listingId, listingsDir) {
  const p = join3(listingsDir, `${listingId}.yaml`);
  if (!existsSync3(p))
    return null;
  return parseFacts(readFileSync3(p, "utf8"), listingId);
}

// src/rate.ts
var lc = (s) => s.toLowerCase();
var PAYPAL = /\bpaypal\b/i;
var FRIENDS_FAMILY = /\b(friends?\s*(&|and|\/)?\s*family|f\s*&\s*f|freunde\s*(und|&)\s*familie)\b/i;
var PAYMENT_LINK = /(zahlungslink|payment link|bezahllink|kleinanzeigen[.-]?(sicher|pay)|tinyurl|bit\.ly|t\.ly|\bhttps?:\/\/(?!www\.kleinanzeigen\.de))/i;
var EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
var PHONE = /(\+\d{2,3}[\s/-]?\d{3,}|\b0\d{2,4}[\s/-]?\d{4,}|whatsapp)/i;
var ABROAD = /(im ausland|bin gerade (im|in)|auf (geschäftsreise|dienstreise|montage)|abroad|currently (abroad|overseas))/i;
var COURIER = /(kurier|spediteur|spedition|versanddienst|abholdienst|transportunternehmen|shipping (agent|company)|courier)/i;
var INSTANT_FULL_PRICE = /(zahle?\s+(den\s+)?(vollen\s+)?preis|pay\s+(the\s+)?(full\s+)?price|preis\s+zusammen\s+mit\s+(dem\s+)?versand|full\s+(asking\s+)?price)/i;
function deliveryRecipient(body) {
  const trigger = body.match(/(?:empf[aä]nger|lieferung\s+(?:bitte\s+)?an|liefern\s+an|deliver(?:y)?\s+(?:to|address)|recipient)\s*:?\s*\n?\s*/iu);
  if (!trigger || trigger.index === undefined)
    return null;
  let rest = body.slice(trigger.index + trigger[0].length);
  rest = rest.replace(/^(?:empf[aä]nger|recipient)\s*:?\s*\n?\s*/iu, "");
  const name = rest.match(/^([A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+){1,3})/u);
  return name ? name[1].trim() : null;
}
function surname(name) {
  const parts = name.trim().split(/\s+/);
  return parts.length ? lc(parts[parts.length - 1]) : "";
}
function scamTells(body, counterpart) {
  const tells = [];
  if (PAYPAL.test(body))
    tells.push("paypal");
  if (FRIENDS_FAMILY.test(body))
    tells.push("friends-family");
  if (PAYMENT_LINK.test(body))
    tells.push("payment-link");
  if (EMAIL.test(body) || PHONE.test(body))
    tells.push("external-contact");
  if (ABROAD.test(body))
    tells.push("abroad-story");
  if (COURIER.test(body))
    tells.push("courier-story");
  const recipient = deliveryRecipient(body);
  if (recipient && counterpart && surname(recipient) && surname(recipient) !== surname(counterpart)) {
    tells.push("name-mismatch");
  }
  if (INSTANT_FULL_PRICE.test(body) && (PAYPAL.test(body) || PAYMENT_LINK.test(body) || recipient)) {
    tells.push("instant-full-price");
  }
  return tells;
}
function detectOffer(body) {
  const m = body.match(/(?:biete|zahle|geben?|nehme|f[uü]r|w[uü]rde\s+(?:dir\s+)?)\s*(\d{2,4})\s*(?:€|eur|euro)?\b/i) || body.match(/(\d{2,4})\s*(?:€|eur|euro)\b/i);
  if (!m)
    return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}
var FAQ_FIELDS = [
  { re: /(artikel ?nummer|art\.?-?nr|artnr|welche version|2000\s?2910|20002910)/i, field: "artikelnummer", label: "artikelnummer" },
  { re: /(koax|koaxial|kabel\s+dabei|mit\s+kabel|cable\s+included)/i, field: "cable", label: "cable" },
  { re: /(wie alt|alter|baujahr|how old|wie lange (genutzt|in betrieb))/i, field: "age", label: "age" },
  { re: /(software|firmware|fritz ?os|welche version installiert|os version)/i, field: "software", label: "software" },
  { re: /(zustand|condition|kratzer|gebraucht oder neu|wie ist der zustand)/i, field: "condition", label: "condition" },
  { re: /(ovp|originalverpackung|karton dabei|mit verpackung|box included)/i, field: "includes", label: "includes" }
];
function factValue(facts, field) {
  const v = facts[field];
  if (Array.isArray(v))
    return v.join(", ");
  if (v === null)
    return "";
  return String(v);
}
var PICKUP = /(abhol|vorbei ?kommen|vorbei ?schauen|holen kommen|heute noch holen|pick ?up|abzuholen|gleich (holen|abholen|kommen)|wann kann ich)/i;
var INTEREST = /(noch (da|verf[uü]gbar|zu haben)|verf[uü]gbar|interesse|interessiert|kaufen|abkaufen|\bnehmen\b|still available)/i;
var SAFETY = "Zahlung über Sicher bezahlen oder bar bei Abholung, kein PayPal Friends & Family.";
function faqDraft(facts, answered) {
  const parts = answered.map((a) => {
    switch (a.label) {
      case "artikelnummer":
        return `Die Artikelnummer ist ${a.value}.`;
      case "cable":
        return `Zum Kabel: ${a.value}.`;
      case "age":
        return `Zum Alter: ${a.value}.`;
      case "software":
        return `Installiert ist ${a.value}.`;
      case "condition":
        return `Zustand: ${a.value}.`;
      case "includes":
        return `Dabei ist: ${a.value}.`;
      default:
        return a.value;
    }
  });
  return `Hi, ${parts.join(" ")} ${SAFETY}`;
}
function pickupDraft(facts) {
  const where = facts.pickup_area ? ` in ${facts.pickup_area}` : "";
  return `Hi, Abholung ist möglich${where}. Wann würde es dir passen? ${SAFETY}`;
}
function interestDraft(facts) {
  const what = facts.model || facts.variant || "das Gerät";
  return `Hi, ja, ${what} ist noch verfügbar. ${SAFETY}`;
}
function classify(body, counterpart, facts) {
  const tells = scamTells(body, counterpart);
  if (tells.length) {
    return { rating: "scam", tells, needs_fact: [], draft: null, offer_amount: null };
  }
  const amount = detectOffer(body);
  if (amount !== null) {
    return { rating: "offer", tells: [], needs_fact: [], draft: null, offer_amount: amount };
  }
  const asked = FAQ_FIELDS.filter((q) => q.re.test(body));
  if (asked.length) {
    const answered = [];
    const missing = [];
    for (const q of asked) {
      const val = facts ? factValue(facts, q.field) : "";
      if (val)
        answered.push({ label: q.label, value: val });
      else
        missing.push(q.label);
    }
    const draft = missing.length === 0 && facts ? faqDraft(facts, answered) : null;
    return { rating: "faq", tells: [], needs_fact: missing, draft, offer_amount: null };
  }
  if (PICKUP.test(body)) {
    return { rating: "pickup", tells: [], needs_fact: [], draft: facts ? pickupDraft(facts) : null, offer_amount: null };
  }
  if (INTEREST.test(body)) {
    return { rating: "interest", tells: [], needs_fact: [], draft: facts ? interestDraft(facts) : null, offer_amount: null };
  }
  return { rating: "odd", tells: [], needs_fact: [], draft: null, offer_amount: null };
}
function belowFloor(amount, facts) {
  return amount !== null && !!facts && facts.floor !== null && amount < facts.floor;
}

// src/mirror.ts
import { existsSync as existsSync4, readFileSync as readFileSync4, readdirSync as readdirSync2, writeFileSync, mkdirSync } from "node:fs";
import { join as join4 } from "node:path";
function ser(value) {
  if (Array.isArray(value))
    return `[${value.map((v) => String(v)).join(", ")}]`;
  if (typeof value === "boolean" || typeof value === "number")
    return String(value);
  if (value === null || value === undefined)
    return "";
  return JSON.stringify(String(value).replace(/\r?\n/g, " "));
}
function parseScalar(raw) {
  const v = raw.trim();
  if (v === "")
    return "";
  if (v === "true")
    return true;
  if (v === "false")
    return false;
  if (v === "null")
    return null;
  if (/^\[.*\]$/.test(v)) {
    const inner = v.slice(1, -1).trim();
    if (!inner)
      return [];
    return inner.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  if (/^-?\d+(\.\d+)?$/.test(v))
    return Number(v);
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}
var FENCE = "```text";
function serializeConversation(c) {
  const fm = [
    ["conv", c.conv],
    ["listing", c.listing],
    ["counterpart", c.counterpart],
    ["state", c.state],
    ["synthetic", c.synthetic]
  ];
  if (c.rating !== undefined)
    fm.push(["rating", c.rating]);
  if (c.tells !== undefined)
    fm.push(["tells", c.tells]);
  if (c.needs_fact !== undefined)
    fm.push(["needs_fact", c.needs_fact]);
  if (c.draft !== undefined)
    fm.push(["draft", c.draft]);
  if (c.offer_amount !== undefined && c.offer_amount !== null)
    fm.push(["offer_amount", c.offer_amount]);
  if (c.below_floor !== undefined)
    fm.push(["below_floor", c.below_floor]);
  if (c.last_message_at !== undefined)
    fm.push(["last_message_at", c.last_message_at]);
  if (c.synced !== undefined)
    fm.push(["synced", c.synced]);
  const head = ["---", ...fm.map(([k, v]) => `${k}: ${ser(v)}`), "---", ""];
  const title = `# ${c.counterpart} — listing ${c.listing}`;
  const body = ["", "## Messages", ""];
  for (const m of c.messages) {
    body.push(`### ${m.from} · ${m.at}`, FENCE, m.body, "```", "");
  }
  return [...head, title, ...body].join(`
`);
}
function parseConversation(text) {
  const lines = text.split(/\r?\n/);
  const c = { conv: "", listing: "", counterpart: "", state: "open", synthetic: false, messages: [] };
  let i = 0;
  if (lines[0]?.trim() === "---") {
    i = 1;
    for (;i < lines.length; i++) {
      if (lines[i].trim() === "---") {
        i++;
        break;
      }
      const m = lines[i].match(/^([a-z_]+):\s*(.*)$/i);
      if (!m)
        continue;
      const key = m[1];
      const val = parseScalar(m[2]);
      switch (key) {
        case "conv":
          c.conv = String(val);
          break;
        case "listing":
          c.listing = String(val);
          break;
        case "counterpart":
          c.counterpart = String(val);
          break;
        case "state":
          c.state = String(val);
          break;
        case "synthetic":
          c.synthetic = val === true;
          break;
        case "rating":
          c.rating = String(val);
          break;
        case "tells":
          c.tells = Array.isArray(val) ? val : [];
          break;
        case "needs_fact":
          c.needs_fact = Array.isArray(val) ? val : [];
          break;
        case "draft":
          c.draft = val === "" ? null : String(val);
          break;
        case "offer_amount":
          c.offer_amount = typeof val === "number" ? val : null;
          break;
        case "below_floor":
          c.below_floor = val === true;
          break;
        case "last_message_at":
          c.last_message_at = String(val);
          break;
        case "synced":
          c.synced = String(val);
          break;
      }
    }
  }
  for (;i < lines.length; i++) {
    const h = lines[i].match(/^###\s+(buyer|seller)\s+·\s+(.*)$/);
    if (!h)
      continue;
    const from = h[1];
    const at = h[2].trim();
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "")
      j++;
    if (lines[j]?.trim() !== FENCE && lines[j]?.trim() !== "```")
      continue;
    j++;
    const buf = [];
    while (j < lines.length && lines[j].trim() !== "```") {
      buf.push(lines[j]);
      j++;
    }
    c.messages.push({ from, at, body: buf.join(`
`).trim() });
    i = j;
  }
  return c;
}
function writeConversation(mirrorDir, c) {
  mkdirSync(mirrorDir, { recursive: true });
  const p = join4(mirrorDir, `${c.conv}.md`);
  writeFileSync(p, serializeConversation(c));
  return p;
}
function readConversation(path) {
  return parseConversation(readFileSync4(path, "utf8"));
}
function listConversations(mirrorDir) {
  if (!existsSync4(mirrorDir))
    return [];
  return readdirSync2(mirrorDir).filter((f) => f.endsWith(".md")).sort().map((f) => readConversation(join4(mirrorDir, f)));
}
function latestBuyerMessage(c) {
  for (let k = c.messages.length - 1;k >= 0; k--) {
    if (c.messages[k].from === "buyer")
      return c.messages[k];
  }
  return null;
}

// src/notify.ts
import { spawnSync } from "node:child_process";
function composeDigest(convs) {
  const fresh = convs.filter((c) => c.state !== "answered" && c.state !== "closed");
  if (fresh.length === 0)
    return "Kleinanzeigen: nothing new.";
  const order = ["scam", "offer", "faq", "pickup", "interest", "odd"];
  const sorted = [...fresh].sort((a, b) => order.indexOf(a.rating ?? "odd") - order.indexOf(b.rating ?? "odd"));
  const byListing = new Map;
  for (const c of fresh)
    byListing.set(c.listing, (byListing.get(c.listing) ?? 0) + 1);
  const header = [...byListing.entries()].map(([l, n]) => `${l}: ${n} new`).join(" · ");
  const lines = sorted.map((c) => {
    const who = c.counterpart || c.conv;
    const tag = c.rating ?? "odd";
    if (tag === "scam")
      return `⚠ ${who} [scam: ${(c.tells ?? []).join(", ")}] — no draft, do not reply`;
    if (tag === "offer") {
      const amt = c.offer_amount != null ? `${c.offer_amount}€` : "?";
      const floor = c.below_floor ? " (below floor)" : "";
      return `${who} [offer ${amt}${floor}] — your call`;
    }
    if ((c.needs_fact ?? []).length)
      return `${who} [${tag}] — needs you: confirm ${(c.needs_fact ?? []).join(", ")}`;
    if (c.draft)
      return `${who} [${tag}] draft: "${c.draft}"`;
    return `${who} [${tag}] — no draft`;
  });
  return [`Kleinanzeigen — ${header}`, ...lines].join(`
`);
}
function deliver(text) {
  const cmd = process.env.WATCHER_NOTIFY_CMD;
  if (!cmd) {
    process.stdout.write(text + `
`);
    return { channel: "stdout", ok: true, detail: "WATCHER_NOTIFY_CMD unset — printed to stdout" };
  }
  const proc = spawnSync(cmd, { input: text, shell: true, stdio: ["pipe", "inherit", "inherit"] });
  const ok = proc.status === 0;
  return { channel: "cmd", ok, detail: ok ? `delivered via WATCHER_NOTIFY_CMD` : `WATCHER_NOTIFY_CMD exited ${proc.status}` };
}

// src/send.ts
function guardSend(c, force) {
  if (c.rating === "scam" && !force) {
    return {
      allowed: false,
      reason: `refusing to reply to a scam-rated conversation (${c.conv}: ${(c.tells ?? []).join(", ")}). ` + "If you're certain, re-run with --force. The vault's rule: anyone steering off Sicher bezahlen is the signal."
    };
  }
  if (c.state === "closed") {
    return { allowed: false, reason: `conversation ${c.conv} is closed` };
  }
  return { allowed: true, reason: "ok" };
}

// src/kleinanzeigen.ts
var here = dirname(fileURLToPath(import.meta.url));
var MIRROR = join5(here, "mirror");
var LISTINGS = join5(here, "listings");
async function cmdSync() {
  let raws;
  try {
    raws = await fetchConversations(here);
  } catch (e) {
    console.error(`sync: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let written = 0;
  for (const r of raws) {
    const existingPath = join5(MIRROR, `${r.conv}.md`);
    let state = "open";
    if (existsSync5(existingPath)) {
      const prev = readConversation(existingPath);
      if (prev.state === "answered" || prev.state === "closed")
        state = prev.state;
    }
    const last = r.messages.length ? r.messages[r.messages.length - 1].at : "";
    writeConversation(MIRROR, {
      conv: r.conv,
      listing: r.listing,
      counterpart: r.counterpart,
      state,
      synthetic: r.synthetic ?? false,
      messages: r.messages,
      last_message_at: last
    });
    written++;
  }
  writeFileSync2(join5(MIRROR, ".last-sync"), new Date().toISOString() + `
`);
  const src = process.env.KLEINANZEIGEN_FIXTURES ? "fixtures" : "live";
  console.log(`sync (${src}): ${written} conversation(s) mirrored, .last-sync stamped.`);
  return 0;
}
function cmdRate() {
  const convs = listConversations(MIRROR);
  if (!convs.length) {
    console.log("rate: no conversations in the mirror — run sync first.");
    return 0;
  }
  let rated = 0;
  for (const c of convs) {
    const buyer = latestBuyerMessage(c);
    if (!buyer)
      continue;
    const facts = loadFacts(c.listing, LISTINGS);
    const r = classify(buyer.body, c.counterpart, facts);
    c.rating = r.rating;
    c.tells = r.tells;
    c.needs_fact = r.needs_fact;
    c.draft = r.draft;
    c.offer_amount = r.offer_amount;
    c.below_floor = belowFloor(r.offer_amount, facts);
    c.last_message_at = buyer.at;
    writeConversation(MIRROR, c);
    rated++;
  }
  const tally = new Map;
  for (const c of convs)
    tally.set(c.rating ?? "odd", (tally.get(c.rating ?? "odd") ?? 0) + 1);
  const summary = [...tally.entries()].sort().map(([k, n]) => `${k}:${n}`).join("  ");
  console.log(`rate: ${rated} conversation(s) classified — ${summary}`);
  return 0;
}
function cmdNotify() {
  const convs = listConversations(MIRROR);
  const digest = composeDigest(convs);
  const res = deliver(digest);
  if (res.channel === "cmd")
    console.log(`notify: ${res.detail}`);
  return res.ok ? 0 : 1;
}
async function cmdSend(args) {
  const force = args.includes("--force");
  const positional = args.filter((a) => a !== "--force");
  const conv = positional[0];
  const text = positional.slice(1).join(" ");
  if (!conv || !text) {
    console.error('usage: send <conv-id> "<reply text>" [--force]');
    return 1;
  }
  const p = join5(MIRROR, `${conv}.md`);
  if (!existsSync5(p)) {
    console.error(`send: no such conversation in mirror: ${conv}`);
    return 1;
  }
  const c = readConversation(p);
  const buyer = latestBuyerMessage(c);
  if (buyer) {
    const r = classify(buyer.body, c.counterpart, loadFacts(c.listing, LISTINGS));
    c.rating = r.rating;
    c.tells = r.tells;
  }
  const decision = guardSend(c, force);
  if (!decision.allowed) {
    console.error(`send: ${decision.reason}`);
    return 1;
  }
  let result;
  try {
    result = await postReply(here, conv, text);
  } catch (e) {
    console.error(`send: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  c.messages.push({ from: "seller", at: new Date().toISOString(), body: text });
  c.state = "answered";
  writeConversation(MIRROR, c);
  console.log(`send: ${result.note}. Conversation ${conv} marked answered.`);
  return 0;
}
function cmdProbe(args) {
  const harFlag = args.indexOf("--har");
  if (harFlag === -1 || !args[harFlag + 1]) {
    console.log("usage: node kleinanzeigen.js probe --har <messagebox.har>");
    console.log("  Capture: log into kleinanzeigen.de, open Messages, devtools → Network → Save all as HAR.");
    return 1;
  }
  const harPath = args[harFlag + 1];
  if (!existsSync5(harPath)) {
    console.error(`probe: no such HAR file: ${harPath}`);
    return 1;
  }
  let har;
  try {
    har = JSON.parse(readFileSync5(harPath, "utf8"));
  } catch (e) {
    console.error(`probe: unreadable HAR: ${e instanceof Error ? e.message : e}`);
    return 1;
  }
  const urls = (har.log?.entries ?? []).map((e) => e.request.url);
  const m = urls.map((u) => u.match(/(https:\/\/[^/]+\/messagebox\/api)\/users\/(\d+)\/conversations/)).find(Boolean);
  if (!m) {
    console.error("probe: no messagebox conversation requests found in the HAR — capture the Messages page.");
    return 1;
  }
  const [, base, userId] = m;
  const ep = {
    transport: "messagebox-web",
    base,
    userId,
    listPath: "/users/{userId}/conversations?page={page}&size={size}",
    detailPath: "/users/{userId}/conversations/{convId}?contentWarnings=true",
    replyPath: "/users/{userId}/conversations/{convId}",
    headers: { accept: "application/json", "x-ecg-user-agent": "messagebox-1", origin: "https://www.kleinanzeigen.de", referer: "https://www.kleinanzeigen.de/" },
    note: "Auth is Bearer <access_token>, read from the browser session at sync time. replyPath POSTs to the conversation endpoint; body shape unverified until the first live send."
  };
  writeFileSync2(join5(here, "endpoints.json"), JSON.stringify(ep, null, 2) + `
`);
  console.log(`probe: wrote endpoints.json (base ${base}, userId ${userId}).`);
  console.log("  Live sync now works: node kleinanzeigen.js sync (reads your browser session for the token).");
  return 0;
}
var cmd = process.argv[2];
var rest = process.argv.slice(3);
async function main() {
  switch (cmd) {
    case "sync":
      return await cmdSync();
    case "rate":
      return cmdRate();
    case "notify":
      return cmdNotify();
    case "send":
      return await cmdSend(rest);
    case "probe":
      return cmdProbe(rest);
    case "check": {
      const proc = spawnSync2(process.execPath, [join5(here, "check.js")], { stdio: "inherit" });
      return proc.status ?? 1;
    }
    default:
      console.error("usage: node kleinanzeigen.js <sync|rate|notify|send|probe|check>");
      return 1;
  }
}
main().then((code) => process.exit(code));
