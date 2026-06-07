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
