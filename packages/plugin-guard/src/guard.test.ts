import { test, expect } from "bun:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = join(fileURLToPath(import.meta.url), "..");
const GUARD = join(here, "guard.ts");

function exitOf(cmd: string | null): number {
  const args = cmd === null ? ["bun", GUARD] : ["bun", GUARD, cmd];
  return Bun.spawnSync(args).exitCode;
}

// Table: each row is one command and the exact exit code guard must return.
//   2 = blocked, 0 = allowed, 1 = usage (no arg).
type Row = { label: string; cmd: string | null; expectedExit: number };

const rows: Row[] = [
  // ---- P0 REGRESSIONS (must now block, exit 2) -----------------------------------------------------
  { label: "P0#1 short -f force-push to main", cmd: "git push -f origin main", expectedExit: 2 },
  { label: "P0#1 short -f force-push to master", cmd: "git push -f origin master", expectedExit: 2 },
  { label: "P0#2 force flag AFTER branch (normal order)", cmd: "git push origin main --force", expectedExit: 2 },
  { label: "P0#2 -f after branch", cmd: "git push origin main -f", expectedExit: 2 },
  { label: "P0#3 rm GNU long flags --recursive --force", cmd: "rm --recursive --force ~", expectedExit: 2 },
  { label: "P0#3 rm long flags reordered + path", cmd: "rm --force ~/Documents --recursive", expectedExit: 2 },
  { label: "P0#3 rm long flags on /", cmd: "rm --recursive --force /", expectedExit: 2 },

  // ---- DOCUMENTED BLOCK CASES (verified-clean, must stay blocking, exit 2) -------------------------
  { label: "rm -rf ~", cmd: "rm -rf ~", expectedExit: 2 },
  { label: "rm -rf /", cmd: "rm -rf /", expectedExit: 2 },
  { label: "rm -rf ~/Documents", cmd: "rm -rf ~/Documents", expectedExit: 2 },
  { label: "rm -rf $HOME", cmd: "rm -rf $HOME", expectedExit: 2 },
  { label: "rm -fr ~", cmd: "rm -fr ~", expectedExit: 2 },
  { label: "rm -r -f ~", cmd: "rm -r -f ~", expectedExit: 2 },
  { label: "rm -rf --no-preserve-root /", cmd: "rm -rf --no-preserve-root /", expectedExit: 2 },
  // /var stays blocked except the temp carve-out (see AUDIT4 ALLOW rows). The bare dir and its
  // non-temp subtrees must still trip even after the negative-lookahead carve-out lands.
  { label: "rm -rf /var (bare, still blocked)", cmd: "rm -rf /var", expectedExit: 2 },
  { label: "rm -rf /var/lib (non-temp subtree, still blocked)", cmd: "rm -rf /var/lib", expectedExit: 2 },
  { label: "rm -rf /var/log (non-temp subtree, still blocked)", cmd: "rm -rf /var/log", expectedExit: 2 },
  { label: "sudo", cmd: "sudo rm -rf /tmp/x", expectedExit: 2 },
  { label: "env-prefixed sudo", cmd: "SUDO_ASKPASS=x sudo apt update", expectedExit: 2 },
  { label: "force-push --force origin main", cmd: "git push --force origin main", expectedExit: 2 },
  { label: "force-push --force-with-lease origin main", cmd: "git push --force-with-lease origin main", expectedExit: 2 },
  { label: "fork bomb", cmd: ":(){ :|:& };:", expectedExit: 2 },
  { label: "chmod -R 777 /", cmd: "chmod -R 777 /", expectedExit: 2 },
  { label: "dd of=/dev/sda", cmd: "dd if=/dev/zero of=/dev/sda", expectedExit: 2 },
  { label: "redirect to /dev/sda", cmd: "echo x > /dev/sda", expectedExit: 2 },
  { label: "bare git push -f (current branch)", cmd: "git push -f", expectedExit: 2 },
  { label: "bare git push --force", cmd: "git push --force", expectedExit: 2 },
  // ---- P2 git global options between `git` and `push` (must now block, exit 2) -----------------
  { label: "P2 git -C path push -f main", cmd: "git -C /repo push -f origin main", expectedExit: 2 },
  { label: "P2 git -C path push main --force", cmd: "git -C /repo push origin main --force", expectedExit: 2 },
  { label: "P2 git -c key=val push -f master", cmd: "git -c user.x=y push -f origin master", expectedExit: 2 },
  // ---- P3 many leading global options within the raised 16-token cap (must now block, exit 2) ---
  { label: "P3 git 5x -c push --force main", cmd: "git -c a=1 -c b=2 -c c=3 -c d=4 -c e=5 push --force main", expectedExit: 2 },

  // ---- AUDIT P0: quoted paths + shell-wrapped / delimiter-trailed rm (must now block, exit 2) ----
  { label: 'AUDIT-P0 rm -rf "/" (double-quoted root)', cmd: 'rm -rf "/"', expectedExit: 2 },
  { label: "AUDIT-P0 rm -rf '/' (single-quoted root)", cmd: "rm -rf '/'", expectedExit: 2 },
  { label: 'AUDIT-P0 rm -rf "$HOME" (quoted var)', cmd: 'rm -rf "$HOME"', expectedExit: 2 },
  { label: 'AUDIT-P0 rm -rf "/etc" (quoted system path)', cmd: 'rm -rf "/etc"', expectedExit: 2 },
  { label: 'AUDIT-P0 rm -rf "~/Documents" (quoted home subpath)', cmd: 'rm -rf "~/Documents"', expectedExit: 2 },
  { label: 'AUDIT-P0 rm --recursive --force "/" (quoted, long flags)', cmd: 'rm --recursive --force "/"', expectedExit: 2 },
  { label: "AUDIT-P0 subshell (cd /tmp && rm -rf ~)", cmd: "(cd /tmp && rm -rf ~)", expectedExit: 2 },
  { label: "AUDIT-P0 bash -c 'rm -rf ~'", cmd: "bash -c 'rm -rf ~'", expectedExit: 2 },
  { label: "AUDIT-P0 rm -rf ~; (trailing semicolon)", cmd: "rm -rf ~;", expectedExit: 2 },
  { label: "AUDIT-P0 rm -rf ~& (trailing ampersand)", cmd: "rm -rf ~&", expectedExit: 2 },

  // ---- AUDIT P1: uppercase -R recursive flag (BSD/macOS synonym, must now block, exit 2) ---------
  { label: "AUDIT-P1 rm -Rf ~", cmd: "rm -Rf ~", expectedExit: 2 },
  { label: "AUDIT-P1 rm -fR ~", cmd: "rm -fR ~", expectedExit: 2 },
  { label: "AUDIT-P1 rm -R -f ~", cmd: "rm -R -f ~", expectedExit: 2 },
  { label: "AUDIT-P1 rm -Rf /", cmd: "rm -Rf /", expectedExit: 2 },

  // ---- AUDIT P2: mkfs takes the device positionally, never of= (must now block, exit 2) ----------
  { label: "AUDIT-P2 mkfs.ext4 /dev/sda", cmd: "mkfs.ext4 /dev/sda", expectedExit: 2 },
  { label: "AUDIT-P2 mkfs /dev/sda", cmd: "mkfs /dev/sda", expectedExit: 2 },
  { label: "AUDIT-P2 mkfs -t ext4 /dev/sda1", cmd: "mkfs -t ext4 /dev/sda1", expectedExit: 2 },

  // ---- AUDIT2 #1 [P0]: a non-recursive flag BEFORE the -r/-rf token bypassed the rm rule ----------
  // The old pattern anchored to the FIRST dash-token, so any flag lacking r placed first defeated it.
  { label: "AUDIT2-P0 rm -f -r /", cmd: "rm -f -r /", expectedExit: 2 },
  { label: "AUDIT2-P0 rm -f -r ~", cmd: "rm -f -r ~", expectedExit: 2 },
  { label: "AUDIT2-P0 rm -f -r $HOME", cmd: "rm -f -r $HOME", expectedExit: 2 },
  { label: "AUDIT2-P0 rm -f -R /etc (uppercase R after f)", cmd: "rm -f -R /etc", expectedExit: 2 },
  { label: "AUDIT2-P0 rm -v -rf / (verbose first)", cmd: "rm -v -rf /", expectedExit: 2 },
  { label: "AUDIT2-P0 rm -i -rf / (interactive first)", cmd: "rm -i -rf /", expectedExit: 2 },
  { label: "AUDIT2-P0 rm --no-preserve-root -rf / (the real GNU root wipe)", cmd: "rm --no-preserve-root -rf /", expectedExit: 2 },

  // ---- AUDIT2 #2 [P1]: the brace form ${HOME} bypassed (only $HOME was handled) -------------------
  { label: "AUDIT2-P1 rm -rf ${HOME}", cmd: "rm -rf ${HOME}", expectedExit: 2 },
  { label: "AUDIT2-P1 rm -rf ${HOME}/.cache", cmd: "rm -rf ${HOME}/.cache", expectedExit: 2 },
  { label: 'AUDIT2-P1 rm -rf "${HOME}" (quoted brace)', cmd: 'rm -rf "${HOME}"', expectedExit: 2 },

  // ---- AUDIT2 #3 [P2]: quoted FLAG token + empty-quote path collapse ("")/("") -> / ---------------
  { label: 'AUDIT2-P2 rm "-rf" / (double-quoted flag)', cmd: 'rm "-rf" /', expectedExit: 2 },
  { label: "AUDIT2-P2 rm '-rf' / (single-quoted flag)", cmd: "rm '-rf' /", expectedExit: 2 },
  { label: 'AUDIT2-P2 rm -rf ""/"" (empty-quote path collapses to /)', cmd: 'rm -rf ""/""', expectedExit: 2 },

  // ---- AUDIT2 #4 [P2]: macOS raw device node /dev/rdiskN omitted from the redirect rule -----------
  { label: "AUDIT2-P2 cat img > /dev/rdisk0 (macOS raw node)", cmd: "cat img > /dev/rdisk0", expectedExit: 2 },
  { label: "AUDIT2-P2 redirect to /dev/rdisk1", cmd: "echo x > /dev/rdisk1", expectedExit: 2 },

  // ---- AUDIT3 #1 [P0]: root path FOLLOWED BY a glob / dot - the trailing boundary excluded * and . ---
  // rm -rf /* is THE common catastrophic emission. The old HOME_OR_SYSTEM trailing class did not
  // accept * or a second . after the root token, so /*, /., /.., /*.bak, /.??* all slipped through.
  { label: "AUDIT3-P0 rm -rf /* (root glob, the common wipe)", cmd: "rm -rf /*", expectedExit: 2 },
  { label: "AUDIT3-P0 rm -rf /.", cmd: "rm -rf /.", expectedExit: 2 },
  { label: "AUDIT3-P0 rm -rf /..", cmd: "rm -rf /..", expectedExit: 2 },
  { label: "AUDIT3-P0 rm -rf /*.bak (root glob with suffix)", cmd: "rm -rf /*.bak", expectedExit: 2 },
  { label: "AUDIT3-P0 rm -rf /.??* (root dotglob)", cmd: "rm -rf /.??*", expectedExit: 2 },

  // ---- AUDIT3 #2 [P0]: path BEFORE flags - GNU getopt permutes argv, so this still wipes / on Linux ---
  // The old rule asserted the recursive flag came BEFORE the path. rm / -rf reverses that.
  { label: "AUDIT3-P0 rm / -rf (path before flags)", cmd: "rm / -rf", expectedExit: 2 },
  { label: "AUDIT3-P0 rm /etc -rf (path before flags)", cmd: "rm /etc -rf", expectedExit: 2 },
  { label: "AUDIT3-P0 rm /usr/bin -rf (path before flags)", cmd: "rm /usr/bin -rf", expectedExit: 2 },
  { label: "AUDIT3-P0 rm -f / -r (path between flags)", cmd: "rm -f / -r", expectedExit: 2 },

  // ---- AUDIT3 #3 [P1]: tilde-user home (~root, ~alex) - a username letter was not in the trailing class ---
  { label: "AUDIT3-P1 rm -rf ~root (tilde-user home)", cmd: "rm -rf ~root", expectedExit: 2 },
  { label: "AUDIT3-P1 rm -rf ~alex (tilde-user home)", cmd: "rm -rf ~alex", expectedExit: 2 },
  { label: "AUDIT3-P1 rm ~root -rf (tilde-user, path before flags)", cmd: "rm ~root -rf", expectedExit: 2 },

  // ---- AUDIT4 #1 [P0]: Linux /home and /root were absent from ROOT_TOKEN (false negative) ---------
  // rm -rf /home wipes every Linux user's home, rm -rf /root wipes Linux root's home. The macOS
  // mirror /Users was present but the Linux pair was not, so both exited 0. Same word boundary as the
  // other system dirs, so /rootfs /home-backup /rootkit stay safe (the ALLOW rows below check that).
  { label: "AUDIT4-P0 rm -rf /home (every Linux home)", cmd: "rm -rf /home", expectedExit: 2 },
  { label: "AUDIT4-P0 rm -rf /home/user", cmd: "rm -rf /home/user", expectedExit: 2 },
  { label: "AUDIT4-P0 rm -rf /root (Linux root home)", cmd: "rm -rf /root", expectedExit: 2 },
  { label: "AUDIT4-P0 rm -rf /root/.ssh", cmd: "rm -rf /root/.ssh", expectedExit: 2 },

  // ---- AUDIT5 #1 [P2]: standard system dirs were absent from ROOT_TOKEN (false negative) ----------
  // The macOS set (opt sbin private Applications Volumes) and the rest of the Linux FHS (proc run mnt
  // srv) were not enumerated, so a catastrophic rm of any of them exited 0. /opt/homebrew is the brew
  // reset path (`sudo rm -rf /opt/homebrew`), /private is the macOS backing store for /etc /var /tmp,
  // /Volumes wipes mount points. Same word boundary as the other system dirs, so /opt-local /privateer
  // /sbinx /VolumesX /Applications-old /runner stay safe (the ALLOW rows below check that).
  { label: "AUDIT5-P2 rm -rf /opt (brew + third-party root)", cmd: "rm -rf /opt", expectedExit: 2 },
  { label: "AUDIT5-P2 rm -rf /opt/homebrew (brew reset path)", cmd: "rm -rf /opt/homebrew", expectedExit: 2 },
  { label: "AUDIT5-P2 rm -rf /sbin (sibling of /bin)", cmd: "rm -rf /sbin", expectedExit: 2 },
  { label: "AUDIT5-P2 rm -rf /private (macOS backing store for /etc /var /tmp)", cmd: "rm -rf /private", expectedExit: 2 },
  { label: "AUDIT5-P2 rm -rf /private/etc", cmd: "rm -rf /private/etc", expectedExit: 2 },
  { label: "AUDIT5-P2 rm -rf /Applications", cmd: "rm -rf /Applications", expectedExit: 2 },
  { label: "AUDIT5-P2 rm -rf /Volumes (mount points)", cmd: "rm -rf /Volumes", expectedExit: 2 },
  { label: "AUDIT5-P2 rm -rf /Volumes/Backup", cmd: "rm -rf /Volumes/Backup", expectedExit: 2 },
  { label: "AUDIT5-P2 rm -rf /proc (Linux procfs)", cmd: "rm -rf /proc", expectedExit: 2 },
  { label: "AUDIT5-P2 rm -rf /run (Linux runtime)", cmd: "rm -rf /run", expectedExit: 2 },
  { label: "AUDIT5-P2 rm -rf /mnt (Linux mounts)", cmd: "rm -rf /mnt", expectedExit: 2 },
  { label: "AUDIT5-P2 rm -rf /srv (Linux service data)", cmd: "rm -rf /srv", expectedExit: 2 },

  // ---- AUDIT6 #1 [P1 FALSE NEGATIVE]: chmod recursive 777 in any flag/mode order (must now block, exit 2) ----
  // The old chmod rule demanded the literal token order -R then 777 then /, so every realistic
  // reordering of the SAME catastrophic command bypassed (exited 0). Decomposed like rm into
  // order-independent predicates: chmod cmd + a recursive flag in any token + the 777 mode in any
  // token + a dangerous path in any token. -fR is the natural way an agent writes a recursive forced chmod.
  { label: "AUDIT6-P1 chmod -fR 777 / (forced+recursive run, reordered)", cmd: "chmod -fR 777 /", expectedExit: 2 },
  { label: "AUDIT6-P1 chmod -Rf 777 / (recursive+forced run)", cmd: "chmod -Rf 777 /", expectedExit: 2 },
  { label: "AUDIT6-P1 chmod 777 -R / (mode before flag)", cmd: "chmod 777 -R /", expectedExit: 2 },
  { label: "AUDIT6-P1 chmod --recursive 777 / (GNU long flag)", cmd: "chmod --recursive 777 /", expectedExit: 2 },
  { label: "AUDIT6-P1 chmod -v -R 777 / (verbose flag first)", cmd: "chmod -v -R 777 /", expectedExit: 2 },
  { label: "AUDIT6-P1 chmod -fR 777 /etc (reordered, system dir)", cmd: "chmod -fR 777 /etc", expectedExit: 2 },
  { label: "AUDIT6-P1 chmod 777 -R /etc (mode first, system dir)", cmd: "chmod 777 -R /etc", expectedExit: 2 },
  { label: "AUDIT6-P1 chmod -R 0777 /usr (leading-zero mode, system dir)", cmd: "chmod -R 0777 /usr", expectedExit: 2 },

  // ---- AUDIT7 #1 [P2 FALSE NEGATIVE]: a QUOTED device path after of= / > bypassed dd + redirect (must now block, exit 2) ----
  // The dd rule and the disk-redirect rule required /dev/ as a bare literal immediately after of= (or
  // after >), so a quoted device operand broke the adjacency and the rule missed. The sibling mkfs rule
  // already carried `["']?` quote tolerance; dd and the redirect rule were the two destructive predicates
  // never given it. Quoting a path operand is a common shell reflex (ShellCheck nudges toward it), so
  // these are realistic agent emissions. Same `["']?` insert the mkfs rule uses.
  { label: "AUDIT7-P2 dd of='/dev/sda' (single-quoted device)", cmd: "dd if=/dev/zero of='/dev/sda'", expectedExit: 2 },
  { label: 'AUDIT7-P2 dd of="/dev/disk0" (double-quoted device)', cmd: 'dd if=/dev/zero of="/dev/disk0"', expectedExit: 2 },
  { label: "AUDIT7-P2 echo wipe > '/dev/sda' (single-quoted redirect target)", cmd: "echo wipe > '/dev/sda'", expectedExit: 2 },
  { label: 'AUDIT7-P2 cat x.img > "/dev/rdisk2" (double-quoted raw node redirect)', cmd: 'cat x.img > "/dev/rdisk2"', expectedExit: 2 },

  // ---- ALLOW CASES (must NOT block; exit 0) -------------------------------------------------------
  { label: "rm -rf ./build", cmd: "rm -rf ./build", expectedExit: 0 },
  { label: "rm -rf node_modules", cmd: "rm -rf node_modules", expectedExit: 0 },
  { label: "ls -la", cmd: "ls -la", expectedExit: 0 },
  { label: "rm --recursive --force ./build", cmd: "rm --recursive --force ./build", expectedExit: 0 },
  { label: "git push origin main (no force)", cmd: "git push origin main", expectedExit: 0 },
  { label: "git push origin feature -f (non-main branch)", cmd: "git push origin feature -f", expectedExit: 0 },
  { label: "git push -u origin main (set upstream, no force)", cmd: "git push -u origin main", expectedExit: 0 },
  { label: "git --force-with-lease origin feature (non-main, ALLOW)", cmd: "git push --force-with-lease origin feature", expectedExit: 0 },
  { label: "git -C path status (non-push git -C, ALLOW)", cmd: "git -C /repo status", expectedExit: 0 },
  // ---- AUDIT9 ALLOW [P2 FALSE POSITIVE]: main/master as a COMPONENT of a feature branch must NOT block (exit 0) ----
  // The branch lookahead was `\b(?:main|master)\b`. Regex `\b` sits at every -, /, and _, so `\bmain\b`
  // matched the `main` inside `main-menu`, `feature/main-nav`, etc. A deliberate force-push to a NON-main
  // feature branch was wrongly blocked. Tightening the boundary to treat -, /, and word chars as still
  // part of the branch name means main/master only matches as a WHOLE branch token, not a sub-component.
  { label: "AUDIT9-ALLOW git push -f origin main-menu (main as prefix component)", cmd: "git push -f origin main-menu", expectedExit: 0 },
  { label: "AUDIT9-ALLOW git push --force origin feature/main-nav (main mid-slug)", cmd: "git push --force origin feature/main-nav", expectedExit: 0 },
  { label: "AUDIT9-ALLOW git push -f origin master-detail-view (master as prefix component)", cmd: "git push -f origin master-detail-view", expectedExit: 0 },
  { label: "AUDIT9-ALLOW git push -f origin fix/master-template (master mid-slug)", cmd: "git push -f origin fix/master-template", expectedExit: 0 },
  { label: "AUDIT9-ALLOW git push --force-with-lease origin redesign-main-page (main as suffix component)", cmd: "git push --force-with-lease origin redesign-main-page", expectedExit: 0 },
  // Quoted-path fix must not widen into these benign quote/slash shapes.
  { label: 'benign quoted prose mentioning rm -rf (no path)', cmd: 'git commit -m "fix rm -rf handling in docs"', expectedExit: 0 },
  { label: 'rm -rf "./build" (quoted relative path)', cmd: 'rm -rf "./build"', expectedExit: 0 },
  { label: 'rm -rf "$TMPDIR/build" (quoted non-home var)', cmd: 'rm -rf "$TMPDIR/build"', expectedExit: 0 },
  { label: "mkfs.ext4 disk.img (image file, not a device)", cmd: "mkfs.ext4 disk.img", expectedExit: 0 },
  { label: "dd to an image file (of= is not /dev)", cmd: "dd if=/dev/zero of=out.img", expectedExit: 0 },
  // AUDIT2 false-positive guards: the multi-token / brace / rdisk widenings must NOT block these.
  { label: 'AUDIT2-ALLOW commit msg mentioning rm -rf', cmd: 'git commit -m "fix rm -rf in docs"', expectedExit: 0 },
  { label: "AUDIT2-ALLOW rm -rf ./build", cmd: "rm -rf ./build", expectedExit: 0 },
  { label: "AUDIT2-ALLOW rm -f -r ./build (multi-token, relative)", cmd: "rm -f -r ./build", expectedExit: 0 },
  { label: "AUDIT2-ALLOW rm -v -rf node_modules (verbose, relative)", cmd: "rm -v -rf node_modules", expectedExit: 0 },
  { label: 'AUDIT2-ALLOW rm -rf "$TMPDIR/x" (non-home var)', cmd: 'rm -rf "$TMPDIR/x"', expectedExit: 0 },
  { label: "AUDIT2-ALLOW rm -rf /tmp/scratch", cmd: "rm -rf /tmp/scratch", expectedExit: 0 },
  { label: "AUDIT2-ALLOW rm -rf ./etc/config (relative etc)", cmd: "rm -rf ./etc/config", expectedExit: 0 },
  { label: "AUDIT2-ALLOW dd if=/dev/disk0 of=backup.img (read from device)", cmd: "dd if=/dev/disk0 of=backup.img", expectedExit: 0 },
  { label: "AUDIT2-ALLOW cat x > ./dev/null-ish (relative dev path)", cmd: "cat x > ./dev/null-ish", expectedExit: 0 },

  // ---- AUDIT7 ALLOW: the quote-tolerance insert must NOT widen into a quoted FILE target ----------
  // of= / > pointed at a quoted regular file (not /dev/) must stay allowed - the quote sits before a
  // file path, never a device, so the /dev/ anchor still gates the block.
  { label: "AUDIT7-ALLOW dd of='backup.img' (quoted file, not a device)", cmd: "dd if=/dev/zero of='backup.img'", expectedExit: 0 },
  { label: 'AUDIT7-ALLOW dd of="./out.img" (quoted relative file)', cmd: 'dd if=/dev/zero of="./out.img"', expectedExit: 0 },
  { label: "AUDIT7-ALLOW echo x > './out.txt' (quoted file redirect)", cmd: "echo x > './out.txt'", expectedExit: 0 },

  // ---- AUDIT3 ALLOW: the order-independent rm rework must NOT widen into relative globs / tmp / safe names ---
  // Relative globs (./* src/*) and /tmp are safe targets. The dangerous-path predicate requires the
  // path to START at root or home, never a relative prefix, so these stay allowed.
  { label: "AUDIT3-ALLOW rm -rf /tmp/* (tmp glob, not a system dir)", cmd: "rm -rf /tmp/*", expectedExit: 0 },
  { label: "AUDIT3-ALLOW rm -rf ./* (relative glob)", cmd: "rm -rf ./*", expectedExit: 0 },
  { label: "AUDIT3-ALLOW rm -rf src/* (relative subdir glob)", cmd: "rm -rf src/*", expectedExit: 0 },
  { label: "AUDIT3-ALLOW rm --recursive ./build (long flag, relative)", cmd: "rm --recursive ./build", expectedExit: 0 },
  { label: "AUDIT3-ALLOW mkfs.ext4 ./image.img (image file, relative)", cmd: "mkfs.ext4 ./image.img", expectedExit: 0 },
  { label: "AUDIT3-ALLOW confirm -r option (rm not a command token)", cmd: "confirm -r option", expectedExit: 0 },
  { label: "AUDIT3-ALLOW warm -rf cache (rm not a command token)", cmd: "warm -rf cache", expectedExit: 0 },

  // ---- AUDIT4 ALLOW: the /home /root add + the /var temp carve-out must NOT widen/narrow wrongly ---
  // Word boundary keeps lookalikes safe, and the relative form never reaches a root token.
  { label: "AUDIT4-ALLOW rm -rf /rootfs (rootfs is not /root)", cmd: "rm -rf /rootfs", expectedExit: 0 },
  { label: "AUDIT4-ALLOW rm -rf /home-backup (not /home)", cmd: "rm -rf /home-backup", expectedExit: 0 },
  { label: "AUDIT4-ALLOW rm -rf /rootkit (not /root)", cmd: "rm -rf /rootkit", expectedExit: 0 },
  { label: "AUDIT4-ALLOW rm -rf ./home/cache (relative home)", cmd: "rm -rf ./home/cache", expectedExit: 0 },
  // macOS $TMPDIR resolves under /var/folders/... and /var/tmp is the legacy temp - agents hit these
  // constantly. Carve them out of the /var block while every other /var subdir stays blocked.
  { label: "AUDIT4-ALLOW rm -rf /var/folders/x/y/T/build (resolved $TMPDIR)", cmd: "rm -rf /var/folders/x/y/T/build", expectedExit: 0 },
  { label: "AUDIT4-ALLOW rm -rf /var/tmp/scratch (legacy temp)", cmd: "rm -rf /var/tmp/scratch", expectedExit: 0 },
  { label: 'AUDIT4-ALLOW rm -rf "$TMPDIR/build" (quoted temp var)', cmd: 'rm -rf "$TMPDIR/build"', expectedExit: 0 },

  // ---- AUDIT5 ALLOW: the new system-dir tokens must NOT widen into lookalikes / relative / tmp ------
  // Same word boundary as the rest of ROOT_TOKEN, so a trailing non-boundary char (opt-local privateer
  // sbinx VolumesX) never matches, and a relative prefix never reaches a root token.
  { label: "AUDIT5-ALLOW rm -rf ./opt-local (relative, not /opt)", cmd: "rm -rf ./opt-local", expectedExit: 0 },
  { label: "AUDIT5-ALLOW rm -rf ./privateer (relative, not /private)", cmd: "rm -rf ./privateer", expectedExit: 0 },
  { label: "AUDIT5-ALLOW rm -rf /sbinx (not /sbin)", cmd: "rm -rf /sbinx", expectedExit: 0 },
  { label: "AUDIT5-ALLOW rm -rf /VolumesX (not /Volumes)", cmd: "rm -rf /VolumesX", expectedExit: 0 },
  { label: "AUDIT5-ALLOW rm -rf /Applications-old (not /Applications)", cmd: "rm -rf /Applications-old", expectedExit: 0 },
  { label: "AUDIT5-ALLOW rm -rf /runner (not /run)", cmd: "rm -rf /runner", expectedExit: 0 },
  { label: "AUDIT5-ALLOW rm -rf ./run (relative, not /run)", cmd: "rm -rf ./run", expectedExit: 0 },
  { label: "AUDIT5-ALLOW rm -rf ./opt/cache (relative opt)", cmd: "rm -rf ./opt/cache", expectedExit: 0 },
  { label: "AUDIT5-ALLOW rm -rf /tmp/opt (under /tmp, not a system dir)", cmd: "rm -rf /tmp/opt", expectedExit: 0 },
  { label: "AUDIT5-ALLOW rm -rf src/run (relative subdir)", cmd: "rm -rf src/run", expectedExit: 0 },

  // ---- AUDIT6 ALLOW [P2 FALSE POSITIVE]: chmod 777 on a non-system path must NOT block (exit 0) ---
  // The old chmod rule's trailing \s+\/ matched ANY absolute path, so a recursive 777 on /tmp, /app,
  // /workspace, /data was wrongly blocked - inconsistent with the rm rule's /tmp + /var/tmp carve-out.
  // Reusing the rm DANGEROUS_PATH machinery means only root/home/system paths trip; these stay green.
  { label: "AUDIT6-ALLOW chmod -R 777 /tmp (tmp, not a system dir)", cmd: "chmod -R 777 /tmp", expectedExit: 0 },
  { label: "AUDIT6-ALLOW chmod -R 777 /tmp/shared (under /tmp)", cmd: "chmod -R 777 /tmp/shared", expectedExit: 0 },
  { label: "AUDIT6-ALLOW chmod -R 777 /var/tmp/cache (legacy temp)", cmd: "chmod -R 777 /var/tmp/cache", expectedExit: 0 },
  { label: "AUDIT6-ALLOW chmod -R 777 /app (non-system absolute path)", cmd: "chmod -R 777 /app", expectedExit: 0 },
  { label: "AUDIT6-ALLOW chmod -R 777 /workspace (non-system absolute path)", cmd: "chmod -R 777 /workspace", expectedExit: 0 },
  { label: "AUDIT6-ALLOW chmod -R 777 /data (non-system absolute path)", cmd: "chmod -R 777 /data", expectedExit: 0 },
  { label: "AUDIT6-ALLOW chmod -R 777 ./build (relative path)", cmd: "chmod -R 777 ./build", expectedExit: 0 },
  { label: "AUDIT6-ALLOW chmod 755 ./bin (non-777 mode, relative)", cmd: "chmod 755 ./bin", expectedExit: 0 },
  { label: "AUDIT6-ALLOW chmod +x script.sh (no recursive, no 777)", cmd: "chmod +x script.sh", expectedExit: 0 },
  { label: "AUDIT6-ALLOW chmod -R 777 node_modules (relative target)", cmd: "chmod -R 777 node_modules", expectedExit: 0 },

  // ---- AUDIT8 ALLOW [P2 FALSE POSITIVE]: a system-dir NAME inside a RELATIVE path must NOT block (exit 0) ----
  // The chmod path lookahead reused DANGEROUS_PATH but dropped the leading whitespace boundary the rm
  // rule carries, so a ROOT_TOKEN (/bin /etc /usr /lib /Library ...) matched as a SUBSTRING inside a
  // relative path. chmod -R 777 ./bin contains "/bin", chmod -R 777 vendor/bin contains "/bin", and so on,
  // so every benign recursive 777 on a relative subdir whose name shadows a system dir was wrongly blocked.
  // The rm rule's `\s` before DANGEROUS_PATH forces the root token to START a fresh argument, so the rm
  // equivalents (rm -rf ./bin, rm -rf vendor/bin) already returned 0 - an rm/chmod asymmetry. Mirroring the
  // rm boundary into the chmod rule closes it. chmod -R 777 node_modules/.bin fixes exec bits after npm install.
  { label: "AUDIT8-ALLOW chmod -R 777 ./bin (relative dir, contains /bin)", cmd: "chmod -R 777 ./bin", expectedExit: 0 },
  { label: "AUDIT8-ALLOW chmod -R 777 vendor/bin (relative dir, contains /bin)", cmd: "chmod -R 777 vendor/bin", expectedExit: 0 },
  { label: "AUDIT8-ALLOW chmod -R 777 dist/lib (relative dir, contains /lib)", cmd: "chmod -R 777 dist/lib", expectedExit: 0 },
  { label: "AUDIT8-ALLOW chmod -R 777 out/usr/share (relative dir, contains /usr)", cmd: "chmod -R 777 out/usr/share", expectedExit: 0 },
  { label: "AUDIT8-ALLOW chmod -R 777 rootfs/etc (relative dir, contains /etc)", cmd: "chmod -R 777 rootfs/etc", expectedExit: 0 },
  { label: "AUDIT8-ALLOW chmod -R 777 node_modules/.bin (fix exec bits after npm install)", cmd: "chmod -R 777 node_modules/.bin", expectedExit: 0 },

  // ---- USAGE (no arg, exit 1) --------------------------------------------------------------------
  { label: "no-arg usage", cmd: null, expectedExit: 1 },
];

// ReDoS guard: a long crafted input must complete quickly (not hang). Exit code may be 0 or 2,
// but the process must return well under a generous timeout.
test("ReDoS guard: 30k-char crafted input returns quickly", () => {
  const evil = "git " + " push".repeat(6000); // ~30k chars of repeated `git`/`push`-ish tokens
  const start = Date.now();
  const code = exitOf(evil);
  const elapsed = Date.now() - start;
  expect(code === 0 || code === 2).toBe(true);
  expect(elapsed).toBeLessThan(5000);
});

for (const { label, cmd, expectedExit } of rows) {
  test(`${label} -> exit ${expectedExit}`, () => {
    expect(exitOf(cmd)).toBe(expectedExit);
  });
}
