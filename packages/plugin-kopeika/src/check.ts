/**
 * kopeika integrity check for `imprnt check --all`.
 *
 * Runs as a standalone node script (built to check.js). It prints a human-readable
 * diagnosis and exits 0 when sound, non-zero when something is actually wrong. The
 * core reads only the exit code, never the text. Per the plugin contract this shares
 * no code with the core or the engine: it re-reads the few files it needs itself.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = basename(HERE) === "src" ? dirname(HERE) : HERE;
const DATA = join(ROOT, "data");

const problems: string[] = [];
const notes: string[] = [];

// The one hard rule for a money tool: financial data must never reach a remote.
// Committing data/ is fine in a remoteless private store (the imprnt vault); it is
// dangerous the moment a remote exists. Fail loudly only in that combination.
function git(args: string[]): string {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : "";
}
const dataTracked = git(["ls-files", "data"]).length > 0;
const hasRemote = git(["remote"]).length > 0;
if (dataTracked && hasRemote) {
  problems.push(
    "data/ is git-tracked in a repo that HAS A REMOTE — your financial data (ledger, raw bank " +
      "exports, profile.json) could be pushed. Add data/ to .gitignore, or remove the remote. " +
      "Committing data/ is only safe in a remoteless local store like the imprnt vault.",
  );
} else if (dataTracked) {
  notes.push("data: committed (no remote — canonical local store, safe)");
} else {
  notes.push("data: not tracked by git");
}

// Profile: optional (absent = generic mode), but if present it must be valid JSON.
const profilePath = join(DATA, "profile.json");
if (existsSync(profilePath)) {
  try {
    JSON.parse(readFileSync(profilePath, "utf8"));
    notes.push("profile: present");
  } catch (e) {
    problems.push(`data/profile.json is not valid JSON (${(e as Error).message})`);
  }
} else {
  notes.push("profile: none (generic mode — no net-worth layer, raw labels)");
}

// Ledger: optional (a fresh install has none), reported for visibility.
const ledgerPath = join(DATA, "ledger.csv");
if (existsSync(ledgerPath)) {
  const lines = readFileSync(ledgerPath, "utf8").split("\n").filter((l) => l.trim() !== "");
  const rows = Math.max(0, lines.length - 1); // minus header
  notes.push(`ledger: ${rows} row(s)`);
} else {
  notes.push("ledger: none yet (import something first)");
}

console.log("kopeika check");
for (const n of notes) console.log(`  ${n}`);
if (problems.length) {
  console.log(`\n⚠ ${problems.length} issue(s):`);
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log("\nsound.");
process.exit(0);
