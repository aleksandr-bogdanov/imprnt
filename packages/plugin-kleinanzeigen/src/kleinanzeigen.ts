// imprnt · kleinanzeigen plugin — the watcher CLI. Shipped as built kleinanzeigen.js (node banner).
//
//   sync     refresh the local mirror from the message box   (the ONLY wire-touching command; offline
//            with KLEINANZEIGEN_FIXTURES)
//   rate     classify each mirrored conversation — pure regex, zero LLM, writes ratings back
//   notify   compose a phone-sized digest and ship it via $WATCHER_NOTIFY_CMD (stdout fallback)
//   send     post ONE approved reply to ONE conversation (refuses scam without --force)
//   probe    (Alex runs this once, logged in) discover live endpoints → endpoints.json
//   check    integrity (delegates to ./check.js)
//
// Contract: writes ONLY this plugin's own folder, never a vault note. Render-at-read off the mirror.
// The send button is human — nothing here sends without an explicit `send` invocation.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchConversations, postReply } from "./client.ts";
import { loadFacts } from "./facts.ts";
import { classify, belowFloor } from "./rate.ts";
import {
  listConversations, readConversation, writeConversation, latestBuyerMessage,
  type Conversation,
} from "./mirror.ts";
import { composeDigest, deliver } from "./notify.ts";
import { guardSend } from "./send.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MIRROR = join(here, "mirror");
const LISTINGS = join(here, "listings");

async function cmdSync(): Promise<number> {
  let raws;
  try {
    raws = await fetchConversations(here);
  } catch (e) {
    console.error(`sync: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  let written = 0;
  for (const r of raws) {
    // Preserve a prior answered/closed state so a re-sync doesn't reopen a conversation Alex handled.
    const existingPath = join(MIRROR, `${r.conv}.md`);
    let state: Conversation["state"] = "open";
    if (existsSync(existingPath)) {
      const prev = readConversation(existingPath);
      if (prev.state === "answered" || prev.state === "closed") state = prev.state;
    }
    const last = r.messages.length ? r.messages[r.messages.length - 1].at : "";
    writeConversation(MIRROR, {
      conv: r.conv,
      listing: r.listing,
      counterpart: r.counterpart,
      state,
      synthetic: r.synthetic ?? false,
      messages: r.messages,
      last_message_at: last,
    });
    written++;
  }
  writeFileSync(join(MIRROR, ".last-sync"), new Date().toISOString() + "\n");
  const src = process.env.KLEINANZEIGEN_FIXTURES ? "fixtures" : "live";
  console.log(`sync (${src}): ${written} conversation(s) mirrored, .last-sync stamped.`);
  return 0;
}

function cmdRate(): number {
  const convs = listConversations(MIRROR);
  if (!convs.length) {
    console.log("rate: no conversations in the mirror — run sync first.");
    return 0;
  }
  let rated = 0;
  for (const c of convs) {
    const buyer = latestBuyerMessage(c);
    if (!buyer) continue;
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
  // a compact tally so a human eyeballs the run
  const tally = new Map<string, number>();
  for (const c of convs) tally.set(c.rating ?? "odd", (tally.get(c.rating ?? "odd") ?? 0) + 1);
  const summary = [...tally.entries()].sort().map(([k, n]) => `${k}:${n}`).join("  ");
  console.log(`rate: ${rated} conversation(s) classified — ${summary}`);
  return 0;
}

function cmdNotify(): number {
  const convs = listConversations(MIRROR);
  const digest = composeDigest(convs);
  const res = deliver(digest);
  // deliver() already wrote to stdout when no channel is set; otherwise report how it went.
  if (res.channel === "cmd") console.log(`notify: ${res.detail}`);
  return res.ok ? 0 : 1;
}

async function cmdSend(args: string[]): Promise<number> {
  const force = args.includes("--force");
  const positional = args.filter((a) => a !== "--force");
  const conv = positional[0];
  const text = positional.slice(1).join(" ");
  if (!conv || !text) {
    console.error('usage: send <conv-id> "<reply text>" [--force]');
    return 1;
  }
  const p = join(MIRROR, `${conv}.md`);
  if (!existsSync(p)) {
    console.error(`send: no such conversation in mirror: ${conv}`);
    return 1;
  }
  const c = readConversation(p);
  // Classify right here before guarding — never trust a possibly-absent mirror rating (a send issued
  // before `rate` ran would otherwise bypass the scam guard). The guard must see a fresh verdict.
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
  // record the reply in the mirror and mark the conversation answered
  c.messages.push({ from: "seller", at: new Date().toISOString(), body: text });
  c.state = "answered";
  writeConversation(MIRROR, c);
  console.log(`send: ${result.note}. Conversation ${conv} marked answered.`);
  return 0;
}

function cmdProbe(args: string[]): number {
  // Ingest a message-box HAR (devtools → Save all as HAR) and write endpoints.json: the conversation
  // endpoint shapes and the numeric userId are in the captured URLs. Auth is NOT taken from the HAR
  // (browsers redact it); the live client reads the access_token from the browser session at sync time.
  const harFlag = args.indexOf("--har");
  if (harFlag === -1 || !args[harFlag + 1]) {
    console.log("usage: node kleinanzeigen.js probe --har <messagebox.har>");
    console.log("  Capture: log into kleinanzeigen.de, open Messages, devtools → Network → Save all as HAR.");
    return 1;
  }
  const harPath = args[harFlag + 1];
  if (!existsSync(harPath)) { console.error(`probe: no such HAR file: ${harPath}`); return 1; }
  let har: { log?: { entries?: Array<{ request: { url: string } }> } };
  try { har = JSON.parse(readFileSync(harPath, "utf8")); } catch (e) { console.error(`probe: unreadable HAR: ${e instanceof Error ? e.message : e}`); return 1; }
  const urls = (har.log?.entries ?? []).map((e) => e.request.url);
  const m = urls.map((u) => u.match(/(https:\/\/[^/]+\/messagebox\/api)\/users\/(\d+)\/conversations/)).find(Boolean);
  if (!m) { console.error("probe: no messagebox conversation requests found in the HAR — capture the Messages page."); return 1; }
  const [, base, userId] = m;
  const ep = {
    transport: "messagebox-web",
    base,
    userId,
    listPath: "/users/{userId}/conversations?page={page}&size={size}",
    detailPath: "/users/{userId}/conversations/{convId}?contentWarnings=true",
    // OPTIONS preflight confirms POST is allowed on the conversation endpoint, so reply posts there.
    // The request BODY shape ({ message }) is a best guess until one live send confirms it — a wrong
    // guess returns a clean 4xx (no message sent), and send is human-invoked, so it's safe to ship.
    replyPath: "/users/{userId}/conversations/{convId}",
    headers: { accept: "application/json", "x-ecg-user-agent": "messagebox-1", origin: "https://www.kleinanzeigen.de", referer: "https://www.kleinanzeigen.de/" },
    note: "Auth is Bearer <access_token>, read from the browser session at sync time. replyPath POSTs to the conversation endpoint; body shape unverified until the first live send.",
  };
  writeFileSync(join(here, "endpoints.json"), JSON.stringify(ep, null, 2) + "\n");
  console.log(`probe: wrote endpoints.json (base ${base}, userId ${userId}).`);
  console.log("  Live sync now works: node kleinanzeigen.js sync (reads your browser session for the token).");
  return 0;
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);

async function main(): Promise<number> {
  switch (cmd) {
    case "sync": return await cmdSync();
    case "rate": return cmdRate();
    case "notify": return cmdNotify();
    case "send": return await cmdSend(rest);
    case "probe": return cmdProbe(rest);
    case "check": {
      const proc = spawnSync(process.execPath, [join(here, "check.js")], { stdio: "inherit" });
      return proc.status ?? 1;
    }
    default:
      console.error("usage: node kleinanzeigen.js <sync|rate|notify|send|probe|check>");
      return 1;
  }
}

main().then((code) => process.exit(code));
