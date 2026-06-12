#!/usr/bin/env node

// src/kleinanzeigen.ts
import { spawnSync as spawnSync2 } from "node:child_process";
import { existsSync as existsSync4 } from "node:fs";
import { join as join4, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// src/client.ts
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
var PROBE_HINT = `no endpoints.json — the live transport isn't wired yet.
` + `  Run the probe once while logged in:  KLEINANZEIGEN_COOKIES=<jar> node kleinanzeigen.js probe
` + "  Or run offline against fixtures:      KLEINANZEIGEN_FIXTURES=./fixtures node kleinanzeigen.js sync";
function loadEndpoints(here) {
  const p = join(here, "endpoints.json");
  if (!existsSync(p))
    return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}
function readFixtures(dir) {
  if (!existsSync(dir))
    throw new Error(`KLEINANZEIGEN_FIXTURES points at a missing dir: ${dir}`);
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}
function fetchConversations(here) {
  const fixtures = process.env.KLEINANZEIGEN_FIXTURES;
  if (fixtures)
    return readFixtures(fixtures);
  const endpoints = loadEndpoints(here);
  if (!endpoints)
    throw new Error(PROBE_HINT);
  throw new Error(`endpoints.json present (transport: ${endpoints.transport}) but the live HTTP client is not implemented in v1.
` + `  v1 ships the deterministic pipeline; wiring the real fetch is the post-probe follow-up.
` + "  Run offline meanwhile: KLEINANZEIGEN_FIXTURES=./fixtures node kleinanzeigen.js sync");
}
function postReply(here, conv, _text) {
  if (process.env.KLEINANZEIGEN_DRY_RUN || process.env.KLEINANZEIGEN_FIXTURES) {
    return { delivered: false, dryRun: true, note: `dry-run: reply to ${conv} recorded, not sent` };
  }
  const endpoints = loadEndpoints(here);
  if (!endpoints)
    throw new Error(PROBE_HINT);
  throw new Error(`endpoints.json present (transport: ${endpoints.transport}) but live send is not implemented in v1.
` + "  Use KLEINANZEIGEN_DRY_RUN=1 to record intent, or wire the reply transport after probe.");
}

// src/facts.ts
import { existsSync as existsSync2, readFileSync as readFileSync2 } from "node:fs";
import { join as join2 } from "node:path";
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
  const p = join2(listingsDir, `${listingId}.yaml`);
  if (!existsSync2(p))
    return null;
  return parseFacts(readFileSync2(p, "utf8"), listingId);
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
import { existsSync as existsSync3, readFileSync as readFileSync3, readdirSync as readdirSync2, writeFileSync, mkdirSync } from "node:fs";
import { join as join3 } from "node:path";
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
  const p = join3(mirrorDir, `${c.conv}.md`);
  writeFileSync(p, serializeConversation(c));
  return p;
}
function readConversation(path) {
  return parseConversation(readFileSync3(path, "utf8"));
}
function listConversations(mirrorDir) {
  if (!existsSync3(mirrorDir))
    return [];
  return readdirSync2(mirrorDir).filter((f) => f.endsWith(".md")).sort().map((f) => readConversation(join3(mirrorDir, f)));
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
import { writeFileSync as writeFileSync2 } from "node:fs";
var here = dirname(fileURLToPath(import.meta.url));
var MIRROR = join4(here, "mirror");
var LISTINGS = join4(here, "listings");
function cmdSync() {
  let raws;
  try {
    raws = fetchConversations(here);
  } catch (e) {
    console.error(`sync: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let written = 0;
  for (const r of raws) {
    const existingPath = join4(MIRROR, `${r.conv}.md`);
    let state = "open";
    if (existsSync4(existingPath)) {
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
  writeFileSync2(join4(MIRROR, ".last-sync"), new Date().toISOString() + `
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
function cmdSend(args) {
  const force = args.includes("--force");
  const positional = args.filter((a) => a !== "--force");
  const conv = positional[0];
  const text = positional.slice(1).join(" ");
  if (!conv || !text) {
    console.error('usage: send <conv-id> "<reply text>" [--force]');
    return 1;
  }
  const p = join4(MIRROR, `${conv}.md`);
  if (!existsSync4(p)) {
    console.error(`send: no such conversation in mirror: ${conv}`);
    return 1;
  }
  const c = readConversation(p);
  const decision = guardSend(c, force);
  if (!decision.allowed) {
    console.error(`send: ${decision.reason}`);
    return 1;
  }
  let result;
  try {
    result = postReply(here, conv, text);
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
function cmdProbe() {
  console.log("probe (v1 stub — no live call made):");
  if (!process.env.KLEINANZEIGEN_COOKIES) {
    console.log("  set KLEINANZEIGEN_COOKIES to your cookie-jar path first.");
  }
  console.log([
    "  To wire the live transport, capture these while logged into the web message box:",
    "   1. open the message box in a browser, devtools → Network → XHR/Fetch",
    "   2. note the conversation-LIST request (URL, method, headers) and the conversation-DETAIL request",
    "   3. note the SEND-reply request (URL, method, body shape)",
    "   4. write them into endpoints.json: { transport, conversations_url, reply_url, note }",
    "  Until endpoints.json exists, run offline: KLEINANZEIGEN_FIXTURES=./fixtures node kleinanzeigen.js sync"
  ].join(`
`));
  return 0;
}
var cmd = process.argv[2];
var rest = process.argv.slice(3);
switch (cmd) {
  case "sync":
    process.exit(cmdSync());
  case "rate":
    process.exit(cmdRate());
  case "notify":
    process.exit(cmdNotify());
  case "send":
    process.exit(cmdSend(rest));
  case "probe":
    process.exit(cmdProbe());
  case "check": {
    const proc = spawnSync2(process.execPath, [join4(here, "check.js")], { stdio: "inherit" });
    process.exit(proc.status ?? 1);
  }
  default:
    console.error("usage: node kleinanzeigen.js <sync|rate|notify|send|probe|check>");
    process.exit(1);
}
