// imprnt · kleinanzeigen plugin — the digest + its delivery.
//
// `notify` composes a phone-sized summary of the rated mirror and ships it. The CHANNEL is dumb
// plumbing: notify writes the digest text to whatever `WATCHER_NOTIFY_CMD` names (a curl to a Telegram
// bot, ntfy, terminal-notifier, anything that reads stdin), and falls back to stdout when unset. No
// channel framework, no coupling to any one messenger — swap the env var, swap the channel.
//
// Two-sided: the digest shows only what's awaiting YOU (state !== closed && awaiting === "me"), split
// into a Selling group (per-rating template lines) and a Buying group (the seller replied, your turn).
import { spawnSync } from "node:child_process";
import { udata } from "./untrusted.ts";
import { latestCounterpartMessage, type Conversation } from "./mirror.ts";

// One sell-side line: lead with the conv id (the verifiable anchor and the exact `send <conv>` arg),
// the counterpart name rides along as a hint, then the rating verdict / draft / needs-you tail.
function sellLine(c: Conversation): string {
  const who = c.counterpart ? ` (${udata(c.counterpart, 40)})` : "";
  const id = c.conv;
  const tag = c.rating ?? "odd";
  if (tag === "scam") return `⚠ ${id}${who} [scam: ${(c.tells ?? []).join(", ")}] — no draft, do not reply`;
  if (tag === "offer") {
    const amt = c.offer_amount != null ? `${c.offer_amount}€` : "?";
    const floor = c.below_floor ? " (below floor)" : "";
    return `${id}${who} [offer ${amt}${floor}] — your call`;
  }
  if ((c.needs_fact ?? []).length) return `${id}${who} [${tag}] — needs you: confirm ${(c.needs_fact ?? []).join(", ")}`;
  if (c.draft) return `${id}${who} [${tag}] draft: "${c.draft}"`;
  return `${id}${who} [${tag}] — no draft`;
}

// One buy-side line: there's no template to send (you write buy-side replies yourself), so just surface
// that the seller replied, the ad it's about, and an 80-char snippet of their latest message.
function buyLine(c: Conversation): string {
  const who = c.counterpart ? ` (${udata(c.counterpart, 40)})` : "";
  const what = c.ad_title ? ` ${udata(c.ad_title, 60)}` : ` ad ${c.listing}`;
  if (c.rating === "scam") return `⚠ ${c.conv}${who}${what} [scam: ${(c.tells ?? []).join(", ")}] — do not reply`;
  const them = latestCounterpartMessage(c);
  // Their actual message. The most obviously hostile field in the plugin.
  const snip = them ? ` ${udata(them.body, 80)}` : "";
  return `${c.conv}${who}${what} [buying] seller replied — your turn:${snip}`;
}

// Compose the digest: only conversations awaiting you, grouped Selling / Buying, scams first within each.
export function composeDigest(convs: Conversation[]): string {
  const fresh = convs.filter((c) => c.state !== "closed" && (c.awaiting ?? "none") === "me");
  if (fresh.length === 0) return "Kleinanzeigen: nothing awaiting your reply.";

  const order = ["scam", "offer", "faq", "pickup", "interest", "reply", "odd"];
  const byRating = (a: Conversation, b: Conversation) => order.indexOf(a.rating ?? "odd") - order.indexOf(b.rating ?? "odd");
  const sell = fresh.filter((c) => (c.side ?? "selling") !== "buying").sort(byRating);
  const buy = fresh.filter((c) => (c.side ?? "selling") === "buying").sort(byRating);

  const lines = [`Kleinanzeigen — ${fresh.length} awaiting you (${sell.length} selling, ${buy.length} buying)`];
  const mark = (c: Conversation) => ((c.unread ?? 0) > 0 ? "  ·unread" : "");
  if (sell.length) {
    lines.push("", "Selling:");
    for (const c of sell) lines.push("  " + sellLine(c) + mark(c));
  }
  if (buy.length) {
    lines.push("", "Buying:");
    for (const c of buy) lines.push("  " + buyLine(c) + mark(c));
  }
  return lines.join("\n");
}

// Ship the digest. Returns how it went, for the CLI to print honestly.
export function deliver(text: string): { channel: "cmd" | "stdout"; ok: boolean; detail: string } {
  const cmd = process.env.WATCHER_NOTIFY_CMD;
  if (!cmd) {
    process.stdout.write(text + "\n");
    return { channel: "stdout", ok: true, detail: "WATCHER_NOTIFY_CMD unset — printed to stdout" };
  }
  // Run the command through a shell so a user can write a full pipeline ("curl ... -d @-"). The digest
  // arrives on the command's stdin. We never interpolate the text into the command string (no shell
  // injection from counterpart-derived content).
  const proc = spawnSync(cmd, { input: text, shell: true, stdio: ["pipe", "inherit", "inherit"] });
  const ok = proc.status === 0;
  return { channel: "cmd", ok, detail: ok ? `delivered via WATCHER_NOTIFY_CMD` : `WATCHER_NOTIFY_CMD exited ${proc.status}` };
}
