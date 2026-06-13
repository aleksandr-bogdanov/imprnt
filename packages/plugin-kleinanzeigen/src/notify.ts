// imprnt · kleinanzeigen plugin — the digest + its delivery.
//
// `notify` composes a phone-sized summary of the rated mirror and ships it. The CHANNEL is dumb
// plumbing: notify writes the digest text to whatever `WATCHER_NOTIFY_CMD` names (a curl to a Telegram
// bot, ntfy, terminal-notifier, anything that reads stdin), and falls back to stdout when unset. No
// channel framework, no coupling to any one messenger — swap the env var, swap the channel.
import { spawnSync } from "node:child_process";
import type { Conversation } from "./mirror.ts";

// One line per conversation, grouped so the scams and the ready-to-send drafts are scannable at a glance.
export function composeDigest(convs: Conversation[]): string {
  const fresh = convs.filter((c) => c.state !== "answered" && c.state !== "closed");
  if (fresh.length === 0) return "Kleinanzeigen: nothing new.";

  const order = ["scam", "offer", "faq", "pickup", "interest", "odd"];
  const sorted = [...fresh].sort(
    (a, b) => order.indexOf(a.rating ?? "odd") - order.indexOf(b.rating ?? "odd"),
  );

  const byListing = new Map<string, number>();
  for (const c of fresh) byListing.set(c.listing, (byListing.get(c.listing) ?? 0) + 1);
  const header = [...byListing.entries()].map(([l, n]) => `${l}: ${n} new`).join(" · ");

  // Lead with the conv id — it's the verifiable anchor (checkable against the server, and the exact
  // argument `send <conv>` takes). The counterpart name rides along as a human-readable hint only.
  const lines = sorted.map((c) => {
    const who = c.counterpart ? ` (${c.counterpart})` : "";
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
  });

  return [`Kleinanzeigen — ${header}`, ...lines].join("\n");
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
  // injection from buyer-derived content).
  const proc = spawnSync(cmd, { input: text, shell: true, stdio: ["pipe", "inherit", "inherit"] });
  const ok = proc.status === 0;
  return { channel: "cmd", ok, detail: ok ? `delivered via WATCHER_NOTIFY_CMD` : `WATCHER_NOTIFY_CMD exited ${proc.status}` };
}
