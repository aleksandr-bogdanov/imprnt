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
