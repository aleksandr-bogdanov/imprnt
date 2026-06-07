#!/usr/bin/env bun
// imprint guard — deterministic destructive-command blocklist (opt-in plugin).
//
//   bun plugins/guard/guard.ts "<command>"     # or pipe the command on stdin
//
// Exits 2 + a reason if the command is obviously dangerous; exits 0 otherwise.
// No LLM, no analysis — just a short list of "don't do the obviously dumb thing".
// Wire it as a PreToolUse guard on Bash if you ever let the agent run shell.
//
// Known limitation: this is a regex blocklist, not a shell parser. A command whose
// quoted ARGUMENT merely mentions a dangerous pattern (git commit -m "remove rm -rf /")
// can false-positive. Guard errs on the side of blocking, which is the right default for
// a safety hook. Distinguishing a real command from a quoted string needs full shell
// parsing and is out of scope.
const HOME_OR_SYSTEM = "(\\/|~|\\$HOME|\\/Users|\\/etc|\\/usr|\\/var|\\/bin|\\/System|\\/Library)(\\s|\\/|$)";
const DENY: { re: RegExp; why: string }[] = [
  // rm with short bundled flags: -rf, -fr, -r -f, -r --force, etc. (an r-flag, an f somewhere).
  { re: new RegExp(`\\brm\\s+-[a-z]*r[a-z]*f?\\b[^\\n]*\\s${HOME_OR_SYSTEM}`), why: "rm -rf on a home/system path" },
  // rm with GNU long flags: --recursive and --force in any order, possibly interspersed with paths.
  { re: new RegExp(`\\brm\\b(?=[^\\n]*--recursive\\b)(?=[^\\n]*--force\\b)[^\\n]*\\s${HOME_OR_SYSTEM}`), why: "rm --recursive --force on a home/system path" },
  { re: /\bsudo\b/, why: "sudo / privilege escalation" },
  { re: /\b(mkfs|dd)\b[^\n]*\bof=\/dev\//, why: "writing to a raw device" },
  { re: />\s*\/dev\/(sd|nvme|disk)/, why: "redirect to a raw disk" },
  { re: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, why: "fork bomb" },
  { re: /\bchmod\s+-R\s+0?777\s+\//, why: "recursive 777 on a system path" },
  // force-push: a `git push` line carrying a force flag (-f / --force / --force-with-lease) AND a
  // main/master token, in EITHER order (order-independent via two lookaheads).
  // Git global options may sit between `git` and `push` (e.g. `git -C /repo push`, `git -c k=v push`,
  // `git --git-dir=... push`). We tolerate a bounded run of intervening non-space tokens so those
  // forms are still caught. The count is capped (no unbounded/nested quantifier) to avoid ReDoS and
  // to keep matching scoped to a plausible git command rather than far-apart words in prose.
  { re: /\bgit\b(?:\s+\S+){0,8}?\s+push\b(?=[^\n]*(?:--force(?:-with-lease)?\b|(?<![\w-])-[a-zA-Z]*f[a-zA-Z]*\b))(?=[^\n]*\b(?:main|master)\b)/, why: "force-push to main/master" },
  // bare `git push -f` / `git push --force` with no remote argument force-pushes the CURRENT branch,
  // which is frequently main/master. Block it too. (A remote like `origin` opts out of this rule.)
  // Same bounded tolerance for git global options between `git` and `push`.
  { re: /\bgit\b(?:\s+\S+){0,8}?\s+push\s+(?:--force(?:-with-lease)?|(?<![\w-])-[a-zA-Z]*f[a-zA-Z]*)\s*$/, why: "bare force-push (current branch, often main/master)" },
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
