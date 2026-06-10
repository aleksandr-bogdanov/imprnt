// imprnt guard — deterministic destructive-command blocklist (opt-in plugin).
// Shipped as built guard.js (node banner); run as `node plugins/guard/guard.js "<cmd>"` or via a hook.
//
//   node plugins/guard/guard.js "<command>"    # or pipe the command on stdin
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
import { readFileSync } from "node:fs";

// The path token may be quoted (rm -rf "/" - ShellCheck-idiomatic) and may be followed by a quote,
// a closing paren, a command separator (; &) or end-of-line (bash -c 'rm -rf ~', rm -rf ~;).
// The leading boundary tolerates a short run of empty quote-pairs / a lone opening quote so the shell
// collapse rm -rf ""/"" -> rm -rf / (empty quotes vanish, "" + / + "" joins to /) is still caught.
// The HOME var has a brace sibling ${HOME}. A widened trailing boundary catches the trailing shapes -
// still a regex, not a parser.
const HOME_OR_SYSTEM = "(?:[\"']{2}){0,3}[\"']?(\\/|~|\\$HOME|\\$\\{HOME\\}|\\/Users|\\/etc|\\/usr|\\/var|\\/bin|\\/System|\\/Library)(\\s|\\/|[\"');&]|$)";
const DENY: { re: RegExp; why: string }[] = [
  // rm with a recursive flag and a home/system path. The recursive flag may sit in any flag token,
  // not just the first (rm -f -r /, rm -v -rf /, rm -i -rf /) - the flag-order bug the old anchored
  // pattern had. A flag token is a dash-run of letters, optionally quoted (rm "-rf" /). The lookahead
  // asserts SOME short flag token before the path carries r/R (the recursive flag). -R is the BSD/macOS
  // synonym for -r. A trailing f is incidental: the recursive flag is the dangerous one for rm.
  { re: new RegExp(`\\brm\\b(?=(?:\\s+["']?--?[a-zA-Z][a-zA-Z-]*["']?)*\\s+["']?-[a-zA-Z]*[rR])[^\\n]*\\s${HOME_OR_SYSTEM}`), why: "rm -rf on a home/system path" },
  // rm with the GNU long recursive flag (--recursive), with or without --force, in any order.
  { re: new RegExp(`\\brm\\b(?=[^\\n]*\\s--recursive\\b)[^\\n]*\\s${HOME_OR_SYSTEM}`), why: "rm --recursive on a home/system path" },
  { re: /\bsudo\b/, why: "sudo / privilege escalation" },
  { re: /\bdd\b[^\n]*\bof=\/dev\//, why: "writing to a raw device" },
  // mkfs takes the device positionally (mkfs.ext4 /dev/sda), never of= - match /dev/ as an argument.
  { re: /\bmkfs(\.[a-z0-9]+)?\b[^\n]*\s["']?\/dev\//, why: "mkfs on a raw device" },
  { re: />\s*\/dev\/(sd|nvme|disk|rdisk)/, why: "redirect to a raw disk" },
  { re: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, why: "fork bomb" },
  { re: /\bchmod\s+-R\s+0?777\s+\//, why: "recursive 777 on a system path" },
  // force-push: a `git push` line carrying a force flag (-f / --force / --force-with-lease) AND a
  // main/master token, in EITHER order (order-independent via two lookaheads).
  // Git global options may sit between `git` and `push` (e.g. `git -C /repo push`, `git -c k=v push`,
  // `git --git-dir=... push`). We tolerate a bounded run of intervening non-space tokens so those
  // forms are still caught. The count is capped at 16 (no unbounded/nested quantifier) to avoid ReDoS:
  // the bound is a deliberate heuristic, a real force-push with 16+ leading global options is implausible.
  { re: /\bgit\b(?:\s+\S+){0,16}?\s+push\b(?=[^\n]*(?:--force(?:-with-lease)?\b|(?<![\w-])-[a-zA-Z]*f[a-zA-Z]*\b))(?=[^\n]*\b(?:main|master)\b)/, why: "force-push to main/master" },
  // bare `git push -f` / `git push --force` with no remote argument force-pushes the CURRENT branch,
  // which is frequently main/master. Block it too. (A remote like `origin` opts out of this rule.)
  // Same bounded tolerance (cap 16) for git global options between `git` and `push`.
  { re: /\bgit\b(?:\s+\S+){0,16}?\s+push\s+(?:--force(?:-with-lease)?|(?<![\w-])-[a-zA-Z]*f[a-zA-Z]*)\s*$/, why: "bare force-push (current branch, often main/master)" },
];

const argCmd = process.argv.slice(2).join(" ").trim();
const cmd = argCmd || readFileSync(0, "utf8").trim(); // piped stdin to EOF, sync — no Bun, no await
if (!cmd) { console.error('usage: guard "<command>"'); process.exit(1); }

for (const d of DENY) {
  if (d.re.test(cmd)) {
    console.error(`BLOCKED (${d.why}):\n  ${cmd}`);
    process.exit(2);
  }
}
console.log("ok");
process.exit(0);
