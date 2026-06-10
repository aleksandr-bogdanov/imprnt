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

// ---------------------------------------------------------------------------------------------------
// rm blocking, decomposed into ORDER-INDEPENDENT predicates.
//
// The old rm rule coupled flag-order to path-order inside one regex (a lookahead asserting the
// recursive flag came BEFORE the path, then `[^\n]*\s<path>`). Three audit rounds each found a new
// ordering/glob bypass against that coupling: flags before path, then non-r flag first, then path
// before flags / root-glob / tilde-user. Patching the one regex each time only moved the seam.
//
// This round blocks rm when ALL THREE hold, each tested INDEPENDENTLY over the whole command, so no
// ordering of {rm, recursive-flag, dangerous-path} can slip through:
//   (a) RM_CMD       - the `rm` token is invoked as a command (env-prefix tolerated, the documented
//                      regex-not-a-parser posture kept). `\brm\b` already excludes confirm/warm.
//   (b) RM_RECURSIVE - a recursive flag appears in ANY token: a short flag run containing r or R
//                      (-rf, -fr, -Rf, -r, -f -r ...), or the GNU long flag --recursive. -R is the
//                      BSD/macOS synonym. A flag token starts with `-` after whitespace/quote.
//   (c) DANGEROUS_PATH - a root/home path appears in ANY token (see below).
//
// (c) is the predicate the prior rounds kept under-specifying. A dangerous path is one that resolves
// to root or a home, REGARDLESS of what trails it. The trailing class now also accepts a glob/dot run
// (so /*, /., /.., /*.bak, /.??* are caught - the root-glob class, THE common catastrophic rm) and a
// tilde-username (~root, ~alex). The path must START at root (`/...`) or home (`~`, `$HOME`), never a
// relative prefix, so ./* src/* /tmp/* stay allowed (/tmp is not a system dir). A leading boundary
// tolerates collapsed empty quote-pairs (rm -rf ""/"" -> /) and a lone opening quote (rm -rf "/").
const Q = `["']`; // a single quote char (either kind)
// A root or home ROOT TOKEN, the dangerous head of a path. `/` alone, the listed system dirs, the
// home forms. Each is matched at the START of a path token; what trails is handled by PATH_TAIL.
const ROOT_TOKEN =
  "(?:" +
  // /var is split out so its temp subtrees can be carved out: $TMPDIR resolves under /var/folders/...
  // on macOS and /var/tmp is the legacy temp dir, both hit constantly by agents. The negative lookahead
  // exempts ONLY those two continuations, so bare /var and every other /var subdir (/var/lib /var/log)
  // still match. The (?![A-Za-z0-9_]) word boundary stays so /various never trips.
  "\\/var(?:(?![A-Za-z0-9_])(?!\\/(?:folders|tmp)(?:[\\/\\s\"';&]|$)))" + // /var /var/lib /var/tmpfoo (NOT /var/folders /var/tmp themselves)
  "|\\/(?:etc|usr|bin|lib|sys|dev|boot|home|root|System|Library|Users|opt|sbin|private|Applications|Volumes|proc|run|mnt|srv)(?![A-Za-z0-9_])" + // /etc /home /opt /sbin /private /Volumes /proc ... (not /etcetera /rootfs /opt-local /sbinx /privateer /VolumesX /runner)
  "|~[A-Za-z_][A-Za-z0-9_-]*" + // ~root ~alex - tilde + username
  "|\\$\\{HOME\\}" + // ${HOME}
  "|\\$HOME(?![A-Za-z0-9_])" + // $HOME (not $HOMEDIR)
  "|~" + // bare ~  (home)
  "|\\/" + // bare /  (root) - LAST so the longer system-dir alternatives win first
  ")";
// What may legally trail a dangerous root token and keep it dangerous: end-of-token (space, quote,
// separator, paren, EOL) OR a path/glob continuation (/sub, /*, /.., *, ., *.bak, .??*). The glob
// continuation is what the prior rounds dropped, which let /* and /. through. Bounded, no nesting.
const PATH_TAIL = "(?:[\\s\"'();&]|$|[\\/.*?][^\\s\"';&]*)";
// The full dangerous-path predicate: optional collapsed empty quotes + optional opening quote, then a
// root token, then a legal tail. Tested against the WHOLE command - position-independent by design.
const DANGEROUS_PATH = `(?:${Q}{2}){0,3}${Q}?${ROOT_TOKEN}${PATH_TAIL}`;
// A recursive flag in any token: a short flag run carrying r/R, or the long --recursive. The flag
// token is anchored to a flag position ((?<=\s|["']|^)-) so a path like /usr/bin -rf still trips (b)
// via the -rf token, while a bare word containing "r" never does.
const RM_RECURSIVE = `(?:(?<=[\\s"'])${Q}?-[a-zA-Z]*[rR][a-zA-Z]*\\b|--recursive\\b)`;
// rm invoked as a command. \brm\b excludes confirm/warm (no word boundary before their "rm" run).
const RM_CMD = "\\brm\\b";

// ---------------------------------------------------------------------------------------------------
// chmod blocking, decomposed into the SAME order-independent predicates as rm.
//
// The old chmod rule was the one destructive predicate that never got decomposed: a single regex
// /\bchmod\s+-R\s+0?777\s+\// demanding the literal token order -R then 777 then /. That has two
// defects the rm rework already solved elsewhere. (1) It is a FALSE NEGATIVE for every realistic
// reordering of the same catastrophic command (chmod -fR 777 / , chmod 777 -R / ,
// chmod --recursive 777 / , chmod -v -R 777 /), all of which bypassed. (2) Its trailing \s+\/ is a
// FALSE POSITIVE: it matched ANY absolute path, so chmod -R 777 /tmp and chmod -R 777 /app were
// wrongly blocked, inconsistent with the rm rule's /tmp + /var/tmp carve-outs.
//
// Block chmod when ALL hold, each tested INDEPENDENTLY over the whole command:
//   (a) CHMOD_CMD       - the `chmod` token is invoked as a command.
//   (b) CHMOD_RECURSIVE - a recursive flag in ANY token: a short flag run carrying r/R (-R, -fR,
//                         -Rf, -v -R ...) or the GNU long flag --recursive. Same shape as RM_RECURSIVE.
//   (c) CHMOD_777       - the world-writable 777 mode (with optional leading 0) in ANY token, in any
//                         order relative to the flag.
//   (d) DANGEROUS_PATH  - a root/home/system path appears in ANY token, REUSING the rm machinery
//                         (ROOT_TOKEN + PATH_TAIL) behind the SAME leading `\s` boundary the rm rule
//                         carries, so the root token must START a fresh argument and never matches as a
//                         SUBSTRING of a relative path (chmod -R 777 ./bin, vendor/bin, dist/lib stay
//                         allowed - their /bin /lib are mid-path, not argument heads). With that boundary
//                         /tmp /var/tmp /var/folders /app /workspace /data (non-system absolute paths)
//                         are NOT blocked while / /etc /usr /home /var /opt ... ARE. Identical cut to the
//                         rm rule (same `(?=[^\n]*\s${DANGEROUS_PATH})`), no separate path list.
const CHMOD_CMD = "\\bchmod\\b";
const CHMOD_RECURSIVE = `(?:(?<=[\\s"'])${Q}?-[a-zA-Z]*[rR][a-zA-Z]*\\b|--recursive\\b)`;
const CHMOD_777 = "0?777\\b";

const DENY: { re: RegExp; why: string }[] = [
  // rm: block when (a) rm is the command AND (b) a recursive flag appears anywhere AND (c) a
  // dangerous root/home path appears anywhere. Three independent lookaheads, so flag-order,
  // path-order, and glob shape no longer interact. Folds the old short-flag and --recursive rules
  // into one decomposition: rm --recursive --force / and rm --recursive / both satisfy (b)+(c).
  {
    re: new RegExp(`${RM_CMD}(?=[^\\n]*${RM_RECURSIVE})(?=[^\\n]*\\s${DANGEROUS_PATH})`),
    why: "rm -rf / --recursive on a root/home/system path",
  },
  { re: /\bsudo\b/, why: "sudo / privilege escalation" },
  // of= may carry a quoted device operand (of='/dev/sda'), a common shell reflex ShellCheck nudges
  // toward, so an optional quote before /dev/ matches the `["']?` tolerance the mkfs rule already has.
  { re: /\bdd\b[^\n]*\bof=["']?\/dev\//, why: "writing to a raw device" },
  // mkfs takes the device positionally (mkfs.ext4 /dev/sda), never of= - match /dev/ as an argument.
  { re: /\bmkfs(\.[a-z0-9]+)?\b[^\n]*\s["']?\/dev\//, why: "mkfs on a raw device" },
  // the redirect target may be quoted too (> '/dev/sda'), same `["']?` tolerance before the device.
  { re: />\s*["']?\/dev\/(sd|nvme|disk|rdisk)/, why: "redirect to a raw disk" },
  { re: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/, why: "fork bomb" },
  // chmod: block when (a) chmod is the command AND (b) a recursive flag appears anywhere AND (c) the
  // 777 mode appears anywhere AND (d) a dangerous root/home/system path appears anywhere. Four
  // independent lookaheads, so flag-order, mode-order, and path-order no longer interact, and the
  // dangerous-path predicate is the SAME one rm uses (so /tmp /var/tmp /app /workspace /data are
  // carved out while / /etc /usr /home /var /opt stay blocked). Matches the rm decomposition exactly.
  {
    re: new RegExp(`${CHMOD_CMD}(?=[^\\n]*${CHMOD_RECURSIVE})(?=[^\\n]*${CHMOD_777})(?=[^\\n]*\\s${DANGEROUS_PATH})`),
    why: "recursive 777 on a root/home/system path",
  },
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
