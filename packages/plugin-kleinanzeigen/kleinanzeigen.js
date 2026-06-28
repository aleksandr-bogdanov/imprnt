#!/usr/bin/env node

// src/kleinanzeigen.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync8, readFileSync as readFileSync8, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join8, dirname as dirname2 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";

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
async function sessionHostToken() {
  const port = Number(process.env.SESSION_HOST_PORT ?? 8787);
  const ctrl = new AbortController;
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/session/token?site=kleinanzeigen.de`, { signal: ctrl.signal });
    if (!res.ok)
      return null;
    const j = await res.json();
    return j.token ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
async function liveAuth() {
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
  const hosted = await sessionHostToken();
  if (hosted)
    return { token: hosted, source: "session-host" };
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
var AUTH_HINT = `no live session — couldn't get a kleinanzeigen access_token.
` + "  Best: run the session host (`session-host serve`) and enroll once (`session-host login ...`).\n" + `  Or log into kleinanzeigen.de in Arc and approve the Keychain prompt, or set
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
    from: m.boundness === "OUTBOUND" ? "me" : "them",
    at: m.receivedDate ?? "",
    body: (m.textShort ?? "").trim()
  }));
}
function normalizeAuthor(from) {
  return from === "me" || from === "seller" || from === "OUTBOUND" ? "me" : "them";
}
var clean = (v) => String(v ?? "").trim();
function fixturesToConvs(rows) {
  return rows.map((f) => ({
    conv: String(f.conv ?? ""),
    side: f.side === "buying" ? "buying" : "selling",
    listing: String(f.listing ?? ""),
    ad_title: String(f.ad_title ?? ""),
    counterpart: String(f.counterpart ?? ""),
    ad_status: String(f.ad_status ?? ""),
    unread: Number(f.unread ?? 0) || 0,
    synthetic: f.synthetic ?? false,
    messages: (f.messages ?? []).map((m) => ({ from: normalizeAuthor(m.from), at: m.at ?? "", body: (m.body ?? "").trim() }))
  }));
}
async function fetchConversations(here) {
  const fixtures = process.env.KLEINANZEIGEN_FIXTURES;
  if (fixtures)
    return fixturesToConvs(readFixtures(fixtures));
  const ep = loadEndpoints(here);
  if (!ep)
    throw new Error(PROBE_HINT);
  const auth = await liveAuth();
  if (!auth)
    throw new Error(AUTH_HINT);
  const headers = { ...ep.headers, authorization: `Bearer ${auth.token}` };
  const listUrl = ep.base + fill(ep.listPath, { userId: ep.userId, page: 0, size: 100 });
  const listRes = await fetch(listUrl, { headers });
  if (!listRes.ok)
    throw new Error(`list fetch ${listRes.status} ${listRes.statusText} — session expired? reload kleinanzeigen.de in your browser`);
  const list = await listRes.json();
  const convs = list.conversations ?? [];
  const out = [];
  for (const c of convs) {
    const role = c.role ?? "Seller";
    const side = role === "Buyer" ? "buying" : "selling";
    const detUrl = ep.base + fill(ep.detailPath, { userId: ep.userId, convId: c.id });
    let messages;
    try {
      const detRes = await fetch(detUrl, { headers });
      const det = await detRes.json();
      messages = toMsgs(det.messages ?? []);
    } catch {
      messages = [];
    }
    out.push({
      conv: String(c.id),
      side,
      listing: clean(c.adId),
      ad_title: clean(c.adTitle),
      counterpart: clean(role === "Buyer" ? c.sellerName : c.buyerName),
      ad_status: clean(c.adStatus),
      unread: Number(c.unreadMessagesCount ?? 0) || 0,
      synthetic: false,
      messages
    });
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
  const auth = await liveAuth();
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
var CONTACT_AUTH_HINT = `no live session — couldn't get a kleinanzeigen access_token, so nothing was sent.
` + `  Log into your real account once:  node plugins/session-host/session-host.js login kleinanzeigen.de
` + "  Then make sure the broker is serving: node plugins/session-host/session-host.js serve";
var DEFAULT_CONTACT_PATH = "/users/{userId}/conversations";
function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = k.toLowerCase() === "authorization" ? "Bearer <redacted — read live from your session at send time>" : v;
  }
  return out;
}
async function postContact(here, adId, text, opts = {}) {
  const ep = loadEndpoints(here);
  if (!ep)
    throw new Error(PROBE_HINT);
  const contactPath = ep.contactPath ?? DEFAULT_CONTACT_PATH;
  const url = ep.base + fill(contactPath, { userId: ep.userId, adId });
  const headers = { ...ep.headers, "content-type": "application/json" };
  const contacter = ep.contacterName;
  if (!contacter) {
    throw new Error('contacterName is not set in endpoints.json — add your Kleinanzeigen display name (the create-conversation API requires a "contacter"), e.g. "contacterName": "Alex".');
  }
  const body = { adId: Number(adId), contacter: { name: contacter }, message: text };
  const dryRun = !!opts.dryRun || !!process.env.KLEINANZEIGEN_DRY_RUN || !!process.env.KLEINANZEIGEN_FIXTURES;
  if (dryRun) {
    const shown = redactHeaders({ ...headers, authorization: "Bearer x" });
    const lines = ["  --- dry-run: the request that WOULD be sent (no network call made) ---", `  POST ${url}`];
    for (const [k, v] of Object.entries(shown))
      lines.push(`  ${k}: ${v}`);
    lines.push(`  body: ${JSON.stringify(body)}`, "  --- end dry-run ---");
    console.log(lines.join(`
`));
    return { delivered: false, dryRun: true, note: `dry-run: would start a new conversation on ad ${adId} — NOT sent` };
  }
  const auth = await liveAuth();
  if (!auth)
    throw new Error(CONTACT_AUTH_HINT);
  const res = await fetch(url, {
    method: "POST",
    headers: { ...headers, authorization: `Bearer ${auth.token}` },
    body: JSON.stringify(body)
  });
  if (res.status === 401)
    throw new Error("contact POST 401 — session expired; reload kleinanzeigen.de in your browser, then retry");
  if (!res.ok) {
    const b = await res.text().catch(() => "");
    throw new Error(`contact POST ${res.status} ${res.statusText}${b ? ` — ${b.slice(0, 300)}` : ""}`);
  }
  let convId = "";
  try {
    const j = await res.json();
    convId = j?.id ?? j?.conversationId ?? "";
  } catch {}
  return { delivered: true, dryRun: false, note: `new conversation started on ad ${adId}${convId ? ` (conv ${convId})` : ""} — run sync to mirror it` };
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
function classify(body, counterpart, facts, side = "selling") {
  const tells = scamTells(body, counterpart);
  if (tells.length) {
    return { rating: "scam", tells, needs_fact: [], draft: null, offer_amount: null };
  }
  if (side === "buying") {
    return { rating: "reply", tells: [], needs_fact: [], draft: null, offer_amount: null };
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
function fenceFor(body) {
  let max = 0;
  for (const m of String(body).matchAll(/`+/g))
    max = Math.max(max, m[0].length);
  return "`".repeat(Math.max(3, max + 1));
}
function serializeConversation(c) {
  const fm = [
    ["conv", c.conv],
    ["side", c.side ?? "selling"],
    ["listing", c.listing],
    ["ad_title", c.ad_title ?? ""],
    ["ad_status", c.ad_status ?? ""],
    ["counterpart", c.counterpart],
    ["state", c.state],
    ["awaiting", c.awaiting ?? "none"],
    ["unread", c.unread ?? 0],
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
  const title = `# ${c.counterpart} — ${c.ad_title ? c.ad_title : `listing ${c.listing}`}`;
  const body = ["", "## Messages", ""];
  for (const m of c.messages) {
    const f = fenceFor(m.body);
    body.push(`### ${m.from} · ${m.at}`, f + "text", m.body, f, "");
  }
  return [...head, title, ...body].join(`
`);
}
function parseConversation(text) {
  const lines = text.split(/\r?\n/);
  const c = {
    conv: "",
    side: "selling",
    listing: "",
    ad_title: "",
    ad_status: "",
    counterpart: "",
    state: "open",
    awaiting: "none",
    unread: 0,
    synthetic: false,
    messages: []
  };
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
        case "side":
          c.side = String(val) === "buying" ? "buying" : "selling";
          break;
        case "listing":
          c.listing = String(val);
          break;
        case "ad_title":
          c.ad_title = val === "" ? "" : String(val);
          break;
        case "ad_status":
          c.ad_status = val === "" ? "" : String(val);
          break;
        case "counterpart":
          c.counterpart = String(val);
          break;
        case "state":
          c.state = String(val);
          break;
        case "awaiting":
          c.awaiting = ["me", "them", "none"].includes(String(val)) ? String(val) : "none";
          break;
        case "unread":
          c.unread = typeof val === "number" ? val : 0;
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
    const h = lines[i].match(/^###\s+(me|them|buyer|seller)\s+·\s+(.*)$/);
    if (!h)
      continue;
    const from = h[1] === "seller" ? "me" : h[1] === "buyer" ? "them" : h[1];
    const at = h[2].trim();
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === "")
      j++;
    const open = lines[j]?.match(/^(`{3,})/);
    if (!open)
      continue;
    const close = open[1];
    j++;
    const buf = [];
    while (j < lines.length && lines[j].trim() !== close) {
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
function latestCounterpartMessage(c) {
  for (let k = c.messages.length - 1;k >= 0; k--) {
    if (c.messages[k].from === "them")
      return c.messages[k];
  }
  return null;
}
function lastMessage(c) {
  return c.messages.length ? c.messages[c.messages.length - 1] : null;
}
var KA_SYSTEM_DEAD = /^(anfrage (abgelehnt|beendet|zur[üu]ckgezogen)|request (declined|ended|withdrawn))[.!]?$/i;
function turnAwaiting(c) {
  if (c.state === "closed")
    return "none";
  const last = lastMessage(c);
  if (!last)
    return "none";
  if (last.from === "them" && KA_SYSTEM_DEAD.test(last.body.trim()))
    return "none";
  return last.from === "them" ? "me" : "them";
}

// src/notify.ts
import { spawnSync } from "node:child_process";
function sellLine(c) {
  const who = c.counterpart ? ` (${c.counterpart})` : "";
  const id = c.conv;
  const tag = c.rating ?? "odd";
  if (tag === "scam")
    return `⚠ ${id}${who} [scam: ${(c.tells ?? []).join(", ")}] — no draft, do not reply`;
  if (tag === "offer") {
    const amt = c.offer_amount != null ? `${c.offer_amount}€` : "?";
    const floor = c.below_floor ? " (below floor)" : "";
    return `${id}${who} [offer ${amt}${floor}] — your call`;
  }
  if ((c.needs_fact ?? []).length)
    return `${id}${who} [${tag}] — needs you: confirm ${(c.needs_fact ?? []).join(", ")}`;
  if (c.draft)
    return `${id}${who} [${tag}] draft: "${c.draft}"`;
  return `${id}${who} [${tag}] — no draft`;
}
function buyLine(c) {
  const who = c.counterpart ? ` (${c.counterpart})` : "";
  const what = c.ad_title ? ` ${c.ad_title}` : ` ad ${c.listing}`;
  if (c.rating === "scam")
    return `⚠ ${c.conv}${who}${what} [scam: ${(c.tells ?? []).join(", ")}] — do not reply`;
  const them = latestCounterpartMessage(c);
  const snip = them ? ` "${them.body.replace(/\s+/g, " ").slice(0, 80)}"` : "";
  return `${c.conv}${who}${what} [buying] seller replied — your turn:${snip}`;
}
function composeDigest(convs) {
  const fresh = convs.filter((c) => c.state !== "closed" && (c.awaiting ?? "none") === "me");
  if (fresh.length === 0)
    return "Kleinanzeigen: nothing awaiting your reply.";
  const order = ["scam", "offer", "faq", "pickup", "interest", "reply", "odd"];
  const byRating = (a, b) => order.indexOf(a.rating ?? "odd") - order.indexOf(b.rating ?? "odd");
  const sell = fresh.filter((c) => (c.side ?? "selling") !== "buying").sort(byRating);
  const buy = fresh.filter((c) => (c.side ?? "selling") === "buying").sort(byRating);
  const lines = [`Kleinanzeigen — ${fresh.length} awaiting you (${sell.length} selling, ${buy.length} buying)`];
  const mark = (c) => (c.unread ?? 0) > 0 ? "  ·unread" : "";
  if (sell.length) {
    lines.push("", "Selling:");
    for (const c of sell)
      lines.push("  " + sellLine(c) + mark(c));
  }
  if (buy.length) {
    lines.push("", "Buying:");
    for (const c of buy)
      lines.push("  " + buyLine(c) + mark(c));
  }
  return lines.join(`
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

// src/search.ts
import { existsSync as existsSync5, readFileSync as readFileSync5, readdirSync as readdirSync3, writeFileSync as writeFileSync2, mkdirSync as mkdirSync2, mkdtempSync as mkdtempSync2, rmSync } from "node:fs";
import { tmpdir as tmpdir2 } from "node:os";
import { join as join5, dirname } from "node:path";
import { fileURLToPath } from "node:url";
var here = dirname(fileURLToPath(import.meta.url));
var MARKET = join5(here, "market");
var SEARCH_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var SEARCH_LOCATIONS = {
  berlin: { path: "s-berlin", code: "l3331" }
};
function slugifyKeyword(kw) {
  return kw.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function searchUrl(keyword, location) {
  const slug = slugifyKeyword(keyword);
  if (!slug)
    return null;
  const loc = location ? location.toLowerCase() : "";
  if (!loc)
    return `https://www.kleinanzeigen.de/s-${slug}/k0`;
  const known = SEARCH_LOCATIONS[loc];
  if (known)
    return `https://www.kleinanzeigen.de/${known.path}/${slug}/k0${known.code}`;
  if (/^l\d+$/.test(loc))
    return `https://www.kleinanzeigen.de/s-${slug}/k0${loc}`;
  return `https://www.kleinanzeigen.de/s-${loc}/${slug}/k0`;
}
function decodeEntities(s) {
  return s.replace(/&#x([0-9a-fA-F]+);?/g, (_, h) => {
    try {
      return String.fromCodePoint(parseInt(h, 16));
    } catch {
      return "";
    }
  }).replace(/&#(\d+);?/g, (_, d) => {
    try {
      return String.fromCodePoint(parseInt(d, 10));
    } catch {
      return "";
    }
  }).replace(/&euro;/g, "€").replace(/&nbsp;/g, " ").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}
function stripHtml(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, " ")).replace(/​/g, "").replace(/\s+/g, " ").trim();
}
function firstPriceToken(s) {
  const m = s.match(/\d[\d.]*\s?€(?:\s?VB)?|Zu verschenken|VB/i);
  return m ? m[0] : "";
}
function priceToNumber(price) {
  if (!price)
    return null;
  const m = String(price).match(/\d[\d.]*(?:,\d+)?/);
  if (!m)
    return null;
  const n = Number(m[0].replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}
function parseSearchHtml(html) {
  const out = [];
  const re = /<article class="aditem[^"]*"([^>]*)data-adid="(\d+)"([^>]*)>([\s\S]*?)<\/article>/g;
  let m;
  while (m = re.exec(html)) {
    const openTag = m[1] + m[3];
    const id = m[2];
    const block = m[4];
    let href = "";
    const hrefM = openTag.match(/data-href="([^"]*)"/) || block.match(/href="(\/s-anzeige\/[^"]*)"/);
    if (hrefM)
      href = hrefM[1];
    let title = "";
    const lj = block.match(/"title":"((?:[^"\\]|\\.)*)"/);
    if (lj) {
      try {
        title = JSON.parse('"' + lj[1] + '"');
      } catch {
        title = lj[1];
      }
    }
    if (!title) {
      const h2 = block.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
      if (h2)
        title = stripHtml(h2[1]);
    }
    let price = "";
    const pe = block.match(/class="aditem-main--middle--price-shipping--price"[^>]*>([\s\S]*?)<\/p>/);
    if (pe)
      price = firstPriceToken(stripHtml(pe[1]));
    if (!price) {
      const pm = block.match(/\d[\d.]*\s?€(?:\s?VB)?/);
      if (pm)
        price = pm[0];
    }
    let location = "";
    const le = block.match(/aditem-main--top--left"[^>]*>([\s\S]*?)<\/div>/);
    if (le)
      location = stripHtml(le[1]);
    let date = "";
    const de = block.match(/aditem-main--top--right"[^>]*>([\s\S]*?)<\/div>/);
    if (de)
      date = stripHtml(de[1]);
    const shipping = /Versand möglich|Versand moeglich/i.test(block) && !/Nur Abholung|kein\w* Versand/i.test(block);
    const gewerblich = /badge-hint-pro/i.test(openTag + block);
    out.push({ id, title: decodeEntities(title).trim(), price, location, date, url: href ? "https://www.kleinanzeigen.de" + href : "", shipping, gewerblich });
  }
  return out;
}
async function fetchSearchHttp(url) {
  const ctrl = new AbortController;
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": SEARCH_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8"
      },
      signal: ctrl.signal
    });
    if (!res.ok)
      return { ok: false, status: res.status, listings: [] };
    const html = await res.text();
    return { ok: true, status: res.status, listings: parseSearchHtml(html) };
  } catch (e) {
    return { ok: false, status: 0, listings: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}
async function dismissConsent(page) {
  const labels = ["Alle akzeptieren", "Akzeptieren", "Zustimmen", "Einverstanden", "Accept all", "Accept"];
  for (const frame of [page.mainFrame(), ...page.frames()]) {
    for (const label of labels) {
      try {
        const btn = frame.locator(`button:has-text("${label}")`);
        if (await btn.count()) {
          await btn.first().click({ timeout: 2000 });
          await page.waitForTimeout(800);
          return true;
        }
      } catch {}
    }
  }
  return false;
}
async function fetchSearchBrowser(url) {
  let chromium;
  try {
    ({ chromium } = await import(join5(here, "..", "session-host", "node_modules", "playwright-core", "index.mjs")));
  } catch {
    return { ok: false, listings: [], error: "browser fallback unavailable (session-host playwright-core not found)" };
  }
  const tmp = mkdtempSync2(join5(tmpdir2(), "ka-search-"));
  let context;
  try {
    context = await chromium.launchPersistentContext(tmp, { headless: true, channel: "chrome", chromiumSandbox: true });
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await dismissConsent(page);
    try {
      await page.waitForSelector("[data-adid]", { timeout: 8000 });
    } catch {}
    const html = await page.content();
    return { ok: true, listings: parseSearchHtml(html) };
  } catch (e) {
    return { ok: false, listings: [], error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      if (context)
        await context.close();
    } catch {}
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }
}
function locSlug(location) {
  const s = (location || "DE").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return s || "de";
}
function searchId(location, keyword) {
  return `${locSlug(location)}__${slugifyKeyword(keyword) || "q"}`;
}
function snapDir(id) {
  return join5(MARKET, "snapshots", id);
}
function listSnapFiles(id) {
  const d = snapDir(id);
  if (!existsSync5(d))
    return [];
  return readdirSync3(d).filter((f) => f.endsWith(".json")).sort();
}
function readSnapFile(id, file) {
  try {
    return JSON.parse(readFileSync5(join5(snapDir(id), file), "utf8"));
  } catch {
    return null;
  }
}
function newestSnapshot(id) {
  const files = listSnapFiles(id);
  for (let k = files.length - 1;k >= 0; k--) {
    const snap = readSnapFile(id, files[k]);
    if (snap)
      return snap;
  }
  return null;
}
function pruneSnapshots(id, keep) {
  const files = listSnapFiles(id);
  if (files.length <= keep)
    return;
  for (const f of files.slice(0, files.length - keep)) {
    try {
      rmSync(join5(snapDir(id), f));
    } catch {}
  }
}
function writeSnapshot(id, data) {
  const dir = snapDir(id);
  mkdirSync2(dir, { recursive: true });
  const safe = String(data.fetchedAt).replace(/[:.]/g, "-");
  writeFileSync2(join5(dir, `${safe}.json`), JSON.stringify(data, null, 2) + `
`);
  pruneSnapshots(id, 30);
}
function toSnapshotListing(row) {
  return {
    adId: row.id,
    title: row.title,
    price: row.price,
    priceNum: priceToNumber(row.price),
    location: row.location,
    date: row.date,
    url: row.url,
    shipping: !!row.shipping,
    gewerblich: !!row.gewerblich
  };
}
function loadListingsIndex() {
  const p = join5(MARKET, "listings.jsonl");
  const map = new Map;
  if (!existsSync5(p))
    return map;
  for (const line of readFileSync5(p, "utf8").split(`
`)) {
    const t = line.trim();
    if (!t)
      continue;
    try {
      const o = JSON.parse(t);
      if (o && o.adId)
        map.set(String(o.adId), o);
    } catch {}
  }
  return map;
}
function writeListingsIndex(map) {
  mkdirSync2(MARKET, { recursive: true });
  const lines = [...map.values()].map((o) => JSON.stringify(o));
  writeFileSync2(join5(MARKET, "listings.jsonl"), lines.length ? lines.join(`
`) + `
` : "");
}
function upsertListings(listings, at) {
  const map = loadListingsIndex();
  for (const l of listings) {
    const adId = String(l.adId);
    const prev = map.get(adId);
    if (!prev) {
      map.set(adId, {
        adId,
        title: l.title,
        location: l.location,
        url: l.url,
        firstSeen: at,
        lastSeen: at,
        lastPrice: l.price || "",
        priceNum: l.priceNum ?? null,
        priceHistory: l.price ? [{ price: l.price, at }] : []
      });
      continue;
    }
    prev.lastSeen = at;
    if (l.title)
      prev.title = l.title;
    if (l.location)
      prev.location = l.location;
    if (l.url)
      prev.url = l.url;
    if (l.price && l.price !== prev.lastPrice) {
      prev.priceHistory = prev.priceHistory || [];
      prev.priceHistory.push({ price: l.price, at });
      prev.lastPrice = l.price;
      prev.priceNum = l.priceNum ?? prev.priceNum;
    } else if (l.priceNum != null && prev.priceNum == null) {
      prev.priceNum = l.priceNum;
    }
  }
  writeListingsIndex(map);
  return map;
}
function applyPriceFilters(rows, minPrice, maxPrice) {
  if (minPrice == null && maxPrice == null)
    return rows;
  return rows.filter((r) => {
    const n = r.priceNum;
    if (n == null)
      return false;
    if (minPrice != null && n < minPrice)
      return false;
    if (maxPrice != null && n > maxPrice)
      return false;
    return true;
  });
}
function sortByPrice(rows) {
  return [...rows].sort((a, b) => {
    const pa = a.priceNum;
    const pb = b.priceNum;
    if (pa == null && pb == null)
      return 0;
    if (pa == null)
      return 1;
    if (pb == null)
      return -1;
    return pa - pb;
  });
}
function titleMatches(title, terms) {
  const hay = (title || "").toLowerCase();
  return terms.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
}
function extractAdId(input) {
  const s = String(input ?? "").trim();
  if (!s)
    return null;
  if (/^\d+$/.test(s))
    return s;
  const last = s.split(/[?#]/)[0].split("/").filter(Boolean).pop() ?? "";
  const lead = last.match(/^(\d{5,})/);
  if (lead)
    return lead[1];
  const any = s.match(/(\d{5,})/);
  return any ? any[1] : null;
}
async function cmdSearch(args) {
  let location = "";
  let limit = 25;
  let asJson = false;
  let forceBrowser = false;
  let sort = "";
  let refresh = false;
  let localOnly = false;
  let minPrice = null;
  let maxPrice = null;
  const positional = [];
  for (let i = 0;i < args.length; i++) {
    const a = args[i];
    if (a === "--location" || a === "-l") {
      location = args[++i] ?? "";
      continue;
    }
    if (a.startsWith("--location=")) {
      location = a.slice("--location=".length);
      continue;
    }
    if (a === "--limit") {
      limit = Number(args[++i]) || limit;
      continue;
    }
    if (a.startsWith("--limit=")) {
      limit = Number(a.slice("--limit=".length)) || limit;
      continue;
    }
    if (a === "--sort") {
      sort = (args[++i] ?? "").toLowerCase();
      continue;
    }
    if (a.startsWith("--sort=")) {
      sort = a.slice("--sort=".length).toLowerCase();
      continue;
    }
    if (a === "--max-price") {
      maxPrice = Number(args[++i]);
      continue;
    }
    if (a.startsWith("--max-price=")) {
      maxPrice = Number(a.slice("--max-price=".length));
      continue;
    }
    if (a === "--min-price") {
      minPrice = Number(args[++i]);
      continue;
    }
    if (a.startsWith("--min-price=")) {
      minPrice = Number(a.slice("--min-price=".length));
      continue;
    }
    if (a === "--json") {
      asJson = true;
      continue;
    }
    if (a === "--browser") {
      forceBrowser = true;
      continue;
    }
    if (a === "--refresh") {
      refresh = true;
      continue;
    }
    if (a === "--local") {
      localOnly = true;
      continue;
    }
    positional.push(a);
  }
  if (minPrice != null && !Number.isFinite(minPrice))
    minPrice = null;
  if (maxPrice != null && !Number.isFinite(maxPrice))
    maxPrice = null;
  const keyword = positional.join(" ").trim();
  if (!keyword) {
    console.error('usage: node kleinanzeigen.js search "<keyword>" [--location berlin] [--limit N] [--sort price] [--min-price N] [--max-price N] [--refresh] [--json] [--browser]');
    console.error('       node kleinanzeigen.js search --local "<terms>" [--sort price] [--min-price N] [--max-price N] [--limit N] [--json]   (no web call; greps the local market store)');
    return 1;
  }
  const render = (rows, source) => {
    let out = applyPriceFilters(rows, minPrice, maxPrice);
    if (sort === "price")
      out = sortByPrice(out);
    const shown = out.slice(0, limit);
    if (asJson) {
      console.log(JSON.stringify({ keyword, location: location || "DE", source, count: out.length, listings: shown }, null, 2));
      return;
    }
    const more = shown.length < out.length ? `, showing ${shown.length}` : "";
    console.log(`search "${keyword}" [${location || "DE"}] — ${source} — ${out.length} listing(s)${more}`);
    for (const it of shown) {
      const price = (it.price || (it.priceNum != null ? `${it.priceNum} €` : "—")).padEnd(12);
      const loc = (it.location || "—").padEnd(24);
      const date = (it.date || "—").padEnd(14);
      console.log(`  ${price} ${loc} ${date} ${it.title}  #${it.adId}`);
    }
  };
  if (localOnly) {
    const map = loadListingsIndex();
    const rows = [...map.values()].filter((r) => titleMatches(r.title, keyword)).map((r) => ({
      adId: r.adId,
      title: r.title,
      price: r.lastPrice,
      priceNum: r.priceNum ?? null,
      location: r.location,
      date: r.lastSeen ? r.lastSeen.slice(0, 10) : "",
      url: r.url
    }));
    if (rows.length === 0 && !asJson)
      console.log(`search --local "${keyword}" — local store, 0 match(es). The store fills as you run live searches (market/listings.jsonl).`);
    else
      render(rows, "local store");
    return 0;
  }
  const url = searchUrl(keyword, location);
  if (!url) {
    console.error("search: keyword is empty after slugify");
    return 1;
  }
  const id = searchId(location, keyword);
  const cached = newestSnapshot(id);
  const FRESH_MS = 1800000;
  const ageMs = cached && cached.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : null;
  const fresh = cached && ageMs != null && ageMs >= 0 && ageMs < FRESH_MS;
  if (cached && fresh && !refresh && !forceBrowser) {
    render(cached.listings, `cache (age ${Math.round(ageMs / 60000)}m)`);
    return 0;
  }
  let result;
  let via = "http";
  if (forceBrowser) {
    console.error("search: --browser drives a headless automation profile, which carries a bot fingerprint (navigator.webdriver) that Kleinanzeigen's fraud system flags and can IP-block. Use only knowingly and sparingly.");
    result = await fetchSearchBrowser(url);
    via = "browser";
  } else {
    result = await fetchSearchHttp(url);
    if (!result.ok || result.listings.length === 0) {
      const why = result.ok ? "0 listings (possible consent/bot wall, or a temporary IP-range block)" : `http ${result.status || "error"}${result.error ? " " + result.error : ""}`;
      console.error(`search: direct fetch returned ${why}.`);
      console.error("  NOT auto-launching the headless browser — that automation fingerprint is what trips the IP-range fraud block. Wait the block out (or switch network), and browse in your real browser. Force the bot path only knowingly: --browser");
    }
  }
  if (!result.ok && result.listings.length === 0) {
    if (cached) {
      const staleMin = ageMs != null ? Math.round(ageMs / 60000) : "?";
      console.error(`search: live fetch failed — falling back to the cached snapshot (age ${staleMin}m), no further web call.`);
      render(cached.listings, `stale cache (age ${staleMin}m)`);
      return 0;
    }
    console.error(`search: failed${result.error ? " — " + result.error : ""}.
  URL: ${url}`);
    return 1;
  }
  const fetchedAt = new Date().toISOString();
  const listings = result.listings.map(toSnapshotListing);
  writeSnapshot(id, { query: keyword, location: location || "DE", url, fetchedAt, listings });
  upsertListings(listings, fetchedAt);
  render(listings, via === "browser" ? "live fetch (browser)" : "live fetch");
  return 0;
}

// src/watch.ts
import { existsSync as existsSync6, readFileSync as readFileSync6, writeFileSync as writeFileSync3, mkdirSync as mkdirSync3 } from "node:fs";
import { join as join6 } from "node:path";
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function watchPath() {
  return join6(MARKET, "searches.json");
}
function readWatches() {
  const p = watchPath();
  if (!existsSync6(p))
    return { searches: [] };
  try {
    const j = JSON.parse(readFileSync6(p, "utf8"));
    return { searches: Array.isArray(j.searches) ? j.searches : [] };
  } catch {
    return { searches: [] };
  }
}
function writeWatches(w) {
  mkdirSync3(MARKET, { recursive: true });
  writeFileSync3(watchPath(), JSON.stringify(w, null, 2) + `
`);
}
function diffSnapshots(prev, next) {
  const prevMap = new Map((prev?.listings ?? []).map((l) => [String(l.adId), l]));
  const nextMap = new Map((next?.listings ?? []).map((l) => [String(l.adId), l]));
  const added = [];
  const dropped = [];
  const gone = [];
  for (const [adId, l] of nextMap) {
    const p = prevMap.get(adId);
    if (!p) {
      added.push(l);
      continue;
    }
    if (l.priceNum != null && p.priceNum != null && l.priceNum < p.priceNum)
      dropped.push({ ...l, oldPrice: p.price, oldPriceNum: p.priceNum });
  }
  for (const [adId, l] of prevMap)
    if (!nextMap.has(adId))
      gone.push(l);
  return { added, dropped, gone };
}
function inBand(priceNum, minPrice, maxPrice) {
  if (priceNum == null)
    return minPrice == null;
  if (minPrice != null && priceNum < minPrice)
    return false;
  if (maxPrice != null && priceNum > maxPrice)
    return false;
  return true;
}
function filterDiffByBand(diff, minPrice, maxPrice) {
  if (minPrice == null && maxPrice == null)
    return diff;
  const keep = (l) => inBand(l.priceNum, minPrice, maxPrice);
  return { added: diff.added.filter(keep), dropped: diff.dropped.filter(keep), gone: diff.gone.filter(keep) };
}
async function refreshSearch(s) {
  const url = searchUrl(s.query, s.location);
  if (!url)
    return { ok: false, id: s.id, query: s.query, location: s.location, error: "empty keyword" };
  const result = await fetchSearchHttp(url);
  if (!result.ok || result.listings.length === 0) {
    return {
      ok: false,
      id: s.id,
      query: s.query,
      location: s.location,
      error: result.ok ? "0 listings (consent/bot wall or IP-range block)" : `http ${result.status || "error"}${result.error ? " " + result.error : ""}`
    };
  }
  const id = searchId(s.location, s.query);
  const prev = newestSnapshot(id);
  const fetchedAt = new Date().toISOString();
  const listings = result.listings.map(toSnapshotListing);
  writeSnapshot(id, { query: s.query, location: s.location || "DE", url, fetchedAt, listings });
  upsertListings(listings, fetchedAt);
  const diff = filterDiffByBand(diffSnapshots(prev, { listings }), s.minPrice ?? null, s.maxPrice ?? null);
  return { ok: true, id, query: s.query, location: s.location, count: listings.length, firstRun: !prev, diff };
}
function dealLine(l) {
  const price = l.price || (l.priceNum != null ? `${l.priceNum} €` : "—");
  return `${price} · ${l.title} #${l.adId}${l.url ? ` ${l.url}` : ""}`;
}
function composeDealDigest(results) {
  const ok = results.filter((r) => r.ok);
  if (!ok.length)
    return `Kleinanzeigen deals: no searches could be refreshed (${results.map((r) => r.ok ? "" : r.error).filter(Boolean).join("; ") || "no saved searches"}).`;
  const totalNew = ok.reduce((n, r) => n + r.diff.added.length, 0);
  const totalDrop = ok.reduce((n, r) => n + r.diff.dropped.length, 0);
  const totalGone = ok.reduce((n, r) => n + r.diff.gone.length, 0);
  const lines = [`Kleinanzeigen deals — ${totalNew} new, ${totalDrop} price drop(s), ${totalGone} gone`];
  for (const r of ok) {
    const loc = r.location || "DE";
    if (r.firstRun) {
      lines.push("", `${r.query} [${loc}]: first snapshot, ${r.count} listing(s) (baseline, no diff yet)`);
      continue;
    }
    const d = r.diff;
    if (!d.added.length && !d.dropped.length && !d.gone.length) {
      lines.push("", `${r.query} [${loc}]: no change (${r.count} listing(s))`);
      continue;
    }
    lines.push("", `${r.query} [${loc}]: ${d.added.length} new, ${d.dropped.length} price drop, ${d.gone.length} gone`);
    for (const l of d.added)
      lines.push(`  NEW   ${dealLine(l)}`);
    for (const l of d.dropped)
      lines.push(`  DROP  ${l.oldPrice || l.oldPriceNum + " €"} -> ${dealLine(l)}`);
    for (const l of d.gone)
      lines.push(`  GONE  ${dealLine(l)}`);
  }
  return lines.join(`
`);
}
function parseSearchFlags(args) {
  let location = "";
  let minPrice = null;
  let maxPrice = null;
  const positional = [];
  for (let i = 0;i < args.length; i++) {
    const a = args[i];
    if (a === "--location" || a === "-l") {
      location = args[++i] ?? "";
      continue;
    }
    if (a.startsWith("--location=")) {
      location = a.slice("--location=".length);
      continue;
    }
    if (a === "--min-price") {
      minPrice = Number(args[++i]);
      continue;
    }
    if (a.startsWith("--min-price=")) {
      minPrice = Number(a.slice("--min-price=".length));
      continue;
    }
    if (a === "--max-price") {
      maxPrice = Number(args[++i]);
      continue;
    }
    if (a.startsWith("--max-price=")) {
      maxPrice = Number(a.slice("--max-price=".length));
      continue;
    }
    positional.push(a);
  }
  if (minPrice != null && !Number.isFinite(minPrice))
    minPrice = null;
  if (maxPrice != null && !Number.isFinite(maxPrice))
    maxPrice = null;
  return { location, minPrice, maxPrice, keyword: positional.join(" ").trim() };
}
async function cmdWatch(args) {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "add") {
    const { location, minPrice, maxPrice, keyword } = parseSearchFlags(rest);
    if (!keyword) {
      console.error('usage: watch add "<query>" [--location berlin] [--min-price N] [--max-price N]');
      return 1;
    }
    const id = searchId(location, keyword);
    const w = readWatches();
    const existing = w.searches.find((s) => s.id === id);
    if (existing) {
      if ((existing.minPrice ?? null) === minPrice && (existing.maxPrice ?? null) === maxPrice) {
        console.log(`watch: already watching "${keyword}" [${location || "DE"}] (${id}).`);
        return 0;
      }
      existing.minPrice = minPrice;
      existing.maxPrice = maxPrice;
      writeWatches(w);
      console.log(`watch: updated price band for "${keyword}" [${location || "DE"}] (${id}) — min ${minPrice ?? "—"}, max ${maxPrice ?? "—"}.`);
      return 0;
    }
    w.searches.push({ id, query: keyword, location: location || "", minPrice, maxPrice, addedAt: new Date().toISOString() });
    writeWatches(w);
    console.log(`watch: added "${keyword}" [${location || "DE"}] (${id}). ${w.searches.length} saved search(es).`);
    return 0;
  }
  if (sub === "list") {
    const w = readWatches();
    if (!w.searches.length) {
      console.log('watch: no saved searches. Add one: watch add "<query>" [--location berlin]');
      return 0;
    }
    console.log(`watch — ${w.searches.length} saved search(es):`);
    for (const s of w.searches) {
      const files = listSnapFiles(s.id);
      const newest = files.length ? newestSnapshot(s.id) : null;
      const age = newest && newest.fetchedAt ? `${Math.round((Date.now() - Date.parse(newest.fetchedAt)) / 60000)}m ago` : "never";
      const price = [s.minPrice != null ? `min ${s.minPrice}` : "", s.maxPrice != null ? `max ${s.maxPrice}` : ""].filter(Boolean).join(", ");
      console.log(`  ${s.id}  "${s.query}" [${s.location || "DE"}]${price ? ` {${price}}` : ""} — ${files.length} snapshot(s), last ${age}`);
    }
    return 0;
  }
  if (sub === "rm") {
    const target = rest[0];
    if (!target) {
      console.error("usage: watch rm <id>");
      return 1;
    }
    const w = readWatches();
    const before = w.searches.length;
    w.searches = w.searches.filter((s) => s.id !== target && s.query !== target);
    if (w.searches.length === before) {
      console.error(`watch: no saved search matching "${target}" (use the id from watch list).`);
      return 1;
    }
    writeWatches(w);
    console.log(`watch: removed "${target}". ${w.searches.length} saved search(es) left.`);
    return 0;
  }
  if (sub === "run") {
    let onlyId = "";
    for (let i = 0;i < rest.length; i++) {
      if (rest[i] === "--id") {
        onlyId = rest[++i] ?? "";
        continue;
      }
      if (rest[i].startsWith("--id=")) {
        onlyId = rest[i].slice("--id=".length);
        continue;
      }
    }
    const w = readWatches();
    const targets = onlyId ? w.searches.filter((s) => s.id === onlyId || s.query === onlyId) : w.searches;
    if (!targets.length) {
      console.log(onlyId ? `watch: no saved search matching "${onlyId}".` : 'watch: no saved searches. Add one: watch add "<query>".');
      return 0;
    }
    const results = [];
    for (let i = 0;i < targets.length; i++) {
      if (i > 0)
        await sleep(1500);
      console.error(`watch run: refreshing "${targets[i].query}" [${targets[i].location || "DE"}] ...`);
      results.push(await refreshSearch(targets[i]));
    }
    const digest = composeDealDigest(results);
    const res = deliver(digest);
    if (res.channel === "cmd")
      console.error(`watch run: ${res.detail}`);
    const failed = results.filter((r) => !r.ok);
    if (failed.length)
      console.error(`watch run: ${failed.length} search(es) could not refresh (${failed.map((f) => f.ok ? "" : f.error).join("; ")}).`);
    return res.ok ? 0 : 1;
  }
  console.error("usage: watch <add|list|rm|run>");
  console.error('  watch add "<query>" [--location berlin] [--min-price N] [--max-price N]');
  console.error("  watch list");
  console.error("  watch rm <id>");
  console.error("  watch run [--id <id>]");
  return 1;
}

// src/detail.ts
import { existsSync as existsSync7, readFileSync as readFileSync7, writeFileSync as writeFileSync4, mkdirSync as mkdirSync4 } from "node:fs";
import { join as join7 } from "node:path";
var ADS_DIR = join7(MARKET, "ads");
async function fetchHtml(url) {
  const ctrl = new AbortController;
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": SEARCH_UA,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "de-DE,de;q=0.9,en;q=0.8"
      },
      signal: ctrl.signal
    });
    if (!res.ok)
      return { ok: false, status: res.status, html: "" };
    return { ok: true, status: res.status, html: await res.text() };
  } catch (e) {
    return { ok: false, status: 0, html: "", error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}
var reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function metaContent(html, prop) {
  const tag = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${reEsc(prop)}["'][^>]*>`, "i"));
  if (!tag)
    return "";
  const c = tag[0].match(/content=["']([^"']*)["']/i);
  return c ? decodeEntities(c[1]).trim() : "";
}
function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while (m = re.exec(html)) {
    try {
      blocks.push(JSON.parse(m[1].trim()));
    } catch {}
  }
  return blocks;
}
function findProduct(blocks) {
  for (const b of blocks) {
    if (!b)
      continue;
    if (b["@type"] === "Product")
      return b;
    if (Array.isArray(b["@graph"])) {
      const p = b["@graph"].find((g) => g && g["@type"] === "Product");
      if (p)
        return p;
    }
  }
  return {};
}
function textNodeContaining(html, word) {
  const m = html.match(new RegExp(`>\\s*([^<>]*${reEsc(word)}[^<>]*)<`, "i"));
  return m ? stripHtml(m[1]) : "";
}
function valueAfter(html, label, span = 240) {
  const hit = html.match(new RegExp(reEsc(label), "i"));
  if (!hit || hit.index === undefined)
    return "";
  const end = hit.index + hit[0].length;
  const region = html.slice(end, end + span);
  const inline = region.match(/^[\s:]*([^<>]+?)\s*</);
  if (inline) {
    const t = stripHtml(inline[1]);
    if (t)
      return t;
  }
  for (const m of region.matchAll(/>\s*([^<>]+?)\s*</g)) {
    const t = stripHtml(m[1]);
    if (t)
      return t;
  }
  return "";
}
function parseAdDetail(html) {
  const prod = findProduct(jsonLdBlocks(html));
  const offer = Array.isArray(prod.offers) ? prod.offers[0] ?? {} : prod.offers ?? {};
  const attributes = {};
  const attrRe = /addetailslist--detail">\s*((?:(?!addetailslist--detail")[\s\S])*?)<span class="addetailslist--detail--value"[^>]*>([\s\S]*?)<\/span>/g;
  let am;
  while (am = attrRe.exec(html)) {
    const k = stripHtml(am[1]);
    const v = stripHtml(am[2]);
    if (k)
      attributes[k] = v;
  }
  const images = [];
  const og = metaContent(html, "og:image");
  if (og)
    images.push(og);
  const sellerType = /Gewerbliche?r? (Nutzer|Anbieter|Händler|Haendler|Verkäufer)/i.test(html) ? "gewerblich" : /Privater (Nutzer|Anbieter|Verkäufer|Verkaeufer)/i.test(html) ? "privat" : "";
  return {
    title: stripHtml(html.match(/id=["']viewad-title["'][^>]*>([\s\S]*?)<\//i)?.[1] ?? "") || metaContent(html, "og:title") || String(prod.name ?? ""),
    price: stripHtml(html.match(/id=["']viewad-price["'][^>]*>([\s\S]*?)<\//i)?.[1] ?? "") || (offer.price ? `${offer.price} €` : ""),
    location: stripHtml(html.match(/id=["']viewad-locality["'][^>]*>([\s\S]*?)<\//i)?.[1] ?? ""),
    posted: stripHtml(html.match(/id=["']viewad-extra-info["'][\s\S]*?icon-calendar[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i)?.[1] ?? "") || valueAfter(html, "Erstellungsdatum") || valueAfter(html, "Online seit"),
    description: stripHtml(html.match(/id=["']viewad-description-text["'][^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "") || String(prod.description ?? ""),
    seller_name: stripHtml(html.match(/userprofile-vip"[^>]*>\s*<a[^>]*>([\s\S]*?)<\/a>/i)?.[1] ?? "") || stripHtml(html.match(/userprofile-vip"[^>]*>\s*([^<]+?)\s*</i)?.[1] ?? ""),
    seller_id: html.match(/s-bestandsliste\.html\?userId=(\d+)/)?.[1] ?? "",
    seller_type: sellerType,
    zufriedenheit: textNodeContaining(html, "Zufriedenheit"),
    antwortrate: valueAfter(html, "Antwortrate"),
    antwortzeit: valueAfter(html, "Antwortzeit"),
    aktiv_seit: valueAfter(html, "Aktiv seit"),
    attributes,
    images
  };
}
async function cmdDetail(args) {
  let asJson = false;
  const positional = [];
  for (const a of args) {
    if (a === "--json") {
      asJson = true;
      continue;
    }
    positional.push(a);
  }
  const target = positional[0];
  if (!target) {
    console.error("usage: detail <adId-or-url> [--json]");
    console.error("  Fetches ONE public ad page and captures the seller rating + metadata into market/ads/<adId>.json.");
    return 1;
  }
  let url = "";
  let adId = "";
  if (/^https?:\/\//i.test(target)) {
    url = target.split("#")[0];
    adId = extractAdId(target) ?? "";
  } else {
    adId = extractAdId(target) ?? "";
    if (!adId) {
      console.error(`detail: couldn't read an ad id from "${target}"`);
      return 1;
    }
    const known = loadListingsIndex().get(String(adId));
    if (known?.url)
      url = known.url;
  }
  if (!adId) {
    console.error(`detail: couldn't read an ad id from "${target}"`);
    return 1;
  }
  if (!url) {
    console.error(`detail: no URL known for ad ${adId}. The market store hasn't seen it — pass the full ad URL instead.`);
    return 1;
  }
  const r = await fetchHtml(url);
  if (!r.ok) {
    console.error(`detail: fetch failed (${r.status || "error"}${r.error ? " " + r.error : ""}).
  URL: ${url}`);
    return 1;
  }
  const parsed = parseAdDetail(r.html);
  const fetchedAt = new Date().toISOString();
  mkdirSync4(ADS_DIR, { recursive: true });
  const adPath = join7(ADS_DIR, `${adId}.json`);
  let prior = null;
  if (existsSync7(adPath)) {
    try {
      prior = JSON.parse(readFileSync7(adPath, "utf8"));
    } catch {}
  }
  const history = Array.isArray(prior?.history) ? prior.history : [];
  if (prior && (prior.price !== parsed.price || prior.description !== parsed.description)) {
    history.push({ at: prior.fetchedAt, price: prior.price, description: prior.description });
  }
  const record = { adId, url, fetchedAt, ...parsed, history };
  writeFileSync4(adPath, JSON.stringify(record, null, 2) + `
`);
  if (asJson) {
    console.log(JSON.stringify(record, null, 2));
    return 0;
  }
  console.log(`detail: ad ${adId} captured -> market/ads/${adId}.json`);
  console.log(`  ${parsed.title || "(no title)"}`);
  if (parsed.price)
    console.log(`  price: ${parsed.price}`);
  if (parsed.location)
    console.log(`  location: ${parsed.location}`);
  console.log(`  seller: ${parsed.seller_name || "?"}${parsed.seller_type ? ` (${parsed.seller_type})` : ""}`);
  if (parsed.zufriedenheit)
    console.log(`  Zufriedenheit: ${parsed.zufriedenheit}`);
  if (parsed.antwortrate)
    console.log(`  Antwortrate: ${parsed.antwortrate}`);
  if (parsed.antwortzeit)
    console.log(`  Antwortzeit: ${parsed.antwortzeit}`);
  if (parsed.aktiv_seit)
    console.log(`  Aktiv seit: ${parsed.aktiv_seit}`);
  const attrN = Object.keys(parsed.attributes || {}).length;
  if (attrN)
    console.log(`  ${attrN} attribute(s): ${Object.entries(parsed.attributes).map(([k, v]) => `${k}=${v}`).join(", ").slice(0, 200)}`);
  if (!parsed.seller_name && !parsed.zufriedenheit && !attrN)
    console.error("  (no seller box / attributes parsed — selectors may need pinning against this page; raw HTML fetched OK)");
  return 0;
}

// src/kleinanzeigen.ts
var here2 = dirname2(fileURLToPath2(import.meta.url));
var MIRROR = join8(here2, "mirror");
var LISTINGS = join8(here2, "listings");
async function cmdSync() {
  let raws;
  try {
    raws = await fetchConversations(here2);
  } catch (e) {
    console.error(`sync: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let written = 0;
  const syncedAt = new Date().toISOString();
  for (const r of raws) {
    const existingPath = join8(MIRROR, `${r.conv}.md`);
    let state = "open";
    if (existsSync8(existingPath)) {
      const prev = readConversation(existingPath);
      if (prev.state === "closed")
        state = "closed";
    }
    const last = r.messages.length ? r.messages[r.messages.length - 1].at : "";
    const conv = {
      conv: r.conv,
      side: r.side ?? "selling",
      listing: r.listing,
      ad_title: r.ad_title ?? "",
      ad_status: r.ad_status ?? "",
      counterpart: r.counterpart,
      state,
      synthetic: r.synthetic ?? false,
      messages: r.messages,
      last_message_at: last,
      unread: r.unread ?? 0,
      synced: syncedAt
    };
    conv.awaiting = turnAwaiting(conv);
    writeConversation(MIRROR, conv);
    written++;
  }
  writeFileSync5(join8(MIRROR, ".last-sync"), new Date().toISOString() + `
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
    const them = latestCounterpartMessage(c);
    const last = lastMessage(c);
    if (last)
      c.last_message_at = last.at;
    c.awaiting = turnAwaiting(c);
    if (!them) {
      writeConversation(MIRROR, c);
      continue;
    }
    const facts = loadFacts(c.listing, LISTINGS);
    const r = classify(them.body, c.counterpart, facts, c.side);
    c.rating = r.rating;
    c.tells = r.tells;
    c.needs_fact = r.needs_fact;
    c.draft = r.draft;
    c.offer_amount = r.offer_amount;
    c.below_floor = belowFloor(r.offer_amount, facts);
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
  const p = join8(MIRROR, `${conv}.md`);
  if (!existsSync8(p)) {
    console.error(`send: no such conversation in mirror: ${conv}`);
    return 1;
  }
  const c = readConversation(p);
  const them = latestCounterpartMessage(c);
  if (them) {
    const r = classify(them.body, c.counterpart, loadFacts(c.listing, LISTINGS), c.side);
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
    result = await postReply(here2, conv, text);
  } catch (e) {
    console.error(`send: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  c.messages.push({ from: "me", at: new Date().toISOString(), body: text });
  c.awaiting = "them";
  writeConversation(MIRROR, c);
  console.log(`send: ${result.note}. Conversation ${conv} now awaiting them.`);
  return 0;
}
async function cmdContact(args) {
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const positional = args.filter((a) => a !== "--dry-run" && a !== "--force");
  const target = positional[0];
  const text = positional.slice(1).join(" ").trim();
  if (!target || !text) {
    console.error('usage: contact <listing-id-or-url> "<message>" [--dry-run] [--force]');
    console.error("  Starts a NEW conversation on a seller's listing and sends exactly ONE message.");
    return 1;
  }
  const adId = extractAdId(target);
  if (!adId) {
    console.error(`contact: couldn't extract a numeric ad id from "${target}"`);
    return 1;
  }
  console.log(`contact: ad ${adId}`);
  console.log(`  message: ${text}`);
  let result;
  try {
    result = await postContact(here2, adId, text, { dryRun, force });
  } catch (e) {
    console.error(`contact: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  console.log(`contact: ${result.note}`);
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
  if (!existsSync8(harPath)) {
    console.error(`probe: no such HAR file: ${harPath}`);
    return 1;
  }
  let har;
  try {
    har = JSON.parse(readFileSync8(harPath, "utf8"));
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
    contactPath: "/users/{userId}/ads/{adId}/conversations",
    headers: { accept: "application/json", "x-ecg-user-agent": "messagebox-1", origin: "https://www.kleinanzeigen.de", referer: "https://www.kleinanzeigen.de/" },
    note: "Auth is Bearer <access_token>, read from the browser session at sync time. replyPath POSTs to the conversation endpoint; contactPath POSTs {adId, message} to start a NEW conversation on an ad. Body shapes unverified until the first live send/contact."
  };
  writeFileSync5(join8(here2, "endpoints.json"), JSON.stringify(ep, null, 2) + `
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
    case "contact":
      return await cmdContact(rest);
    case "search":
      return await cmdSearch(rest);
    case "watch":
      return await cmdWatch(rest);
    case "detail":
      return await cmdDetail(rest);
    case "probe":
      return cmdProbe(rest);
    case "check": {
      const proc = spawnSync2(process.execPath, [join8(here2, "check.js")], { stdio: "inherit" });
      return proc.status ?? 1;
    }
    default:
      console.error("usage: node kleinanzeigen.js <sync|rate|notify|send|contact|search|watch|detail|probe|check>");
      return 1;
  }
}
main().then((code) => process.exit(code));
