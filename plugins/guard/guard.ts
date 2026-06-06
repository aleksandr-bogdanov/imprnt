#!/usr/bin/env bun
// imprint guard — deterministic destructive-command blocklist (opt-in plugin).
//
//   bun plugins/guard/guard.ts "<command>"     # or pipe the command on stdin
//
// Exits 2 + a reason if the command is obviously dangerous; exits 0 otherwise.
// No LLM, no analysis — just a short list of "don't do the obviously dumb thing".
// Wire it as a PreToolUse guard on Bash if you ever let the agent run shell.
const DENY: { re: RegExp; why: string }[] = [
  { re: /\brm\s+-[a-z]*r[a-z]*f?\b[^\n]*\s(\/|~|\$HOME|\/Users|\/etc|\/usr|\/var|\/bin|\/System|\/Library)(\s|\/|$)/, why: "rm -rf on a home/system path" },
  { re: /\bsudo\b/, why: "sudo / privilege escalation" },
  { re: /\b(mkfs|dd)\b[^\n]*\bof=\/dev\//, why: "writing to a raw device" },
  { re: />\s*\/dev\/(sd|nvme|disk)/, why: "redirect to a raw disk" },
  { re: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, why: "fork bomb" },
  { re: /\bchmod\s+-R\s+0?777\s+\//, why: "recursive 777 on a system path" },
  { re: /\bgit\s+push\b[^\n]*--force[^\n]*\b(main|master)\b/, why: "force-push to main/master" },
];

const argCmd = process.argv.slice(2).join(" ").trim();
const cmd = argCmd || (await Bun.stdin.text()).trim();
if (!cmd) { console.error('usage: guard "<command>"'); process.exit(1); }

for (const d of DENY) {
  if (d.re.test(cmd)) {
    console.error(`BLOCKED (${d.why}):\n  ${cmd}`);
    process.exit(2);
  }
}
console.log("ok");
process.exit(0);
