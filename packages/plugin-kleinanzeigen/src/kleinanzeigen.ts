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
import { existsSync } from "node:fs";
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
import { writeFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const MIRROR = join(here, "mirror");
const LISTINGS = join(here, "listings");

function cmdSync(): number {
  let raws;
  try {
    raws = fetchConversations(here);
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

function cmdSend(args: string[]): number {
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
  // record the reply in the mirror and mark the conversation answered
  c.messages.push({ from: "seller", at: new Date().toISOString(), body: text });
  c.state = "answered";
  writeConversation(MIRROR, c);
  console.log(`send: ${result.note}. Conversation ${conv} marked answered.`);
  return 0;
}

function cmdProbe(): number {
  // v1 stub: discovery needs a logged-in session and is the post-probe follow-up. We DON'T make a live
  // call here — we tell Alex exactly what to capture so the live client can be wired deterministically.
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
    "  Until endpoints.json exists, run offline: KLEINANZEIGEN_FIXTURES=./fixtures node kleinanzeigen.js sync",
  ].join("\n"));
  return 0;
}

const cmd = process.argv[2];
const rest = process.argv.slice(3);

switch (cmd) {
  case "sync": process.exit(cmdSync());
  case "rate": process.exit(cmdRate());
  case "notify": process.exit(cmdNotify());
  case "send": process.exit(cmdSend(rest));
  case "probe": process.exit(cmdProbe());
  case "check": {
    const proc = spawnSync(process.execPath, [join(here, "check.js")], { stdio: "inherit" });
    process.exit(proc.status ?? 1);
  }
  default:
    console.error("usage: node kleinanzeigen.js <sync|rate|notify|send|probe|check>");
    process.exit(1);
}
