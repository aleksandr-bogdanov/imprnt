/**
 * kopeika integrity check for `imprnt check --all`.
 *
 * Runs as a standalone node script (built to check.js). It prints a human-readable
 * diagnosis and exits 0 when sound, non-zero when something is actually wrong. The
 * core reads only the exit code, never the text. Per the plugin contract this shares
 * no code with the core or the engine: it re-reads the few files it needs itself.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = basename(HERE) === "src" ? dirname(HERE) : HERE;
const DATA = join(ROOT, "data");

const problems: string[] = [];
const notes: string[] = [];

// The one hard rule for a money tool: financial data must never reach a remote.
// That covers data/ (ledger, raw exports, profile) AND deploy/ (the rendered
// dashboard carries the same numbers). Committing either is fine in a remoteless
// private store (the imprnt vault); it is dangerous the moment a remote exists.
// Fail loudly only in that combination. A failed git call (git missing, not a
// repo) returns null so the guard admits it could not check instead of quietly
// reporting "not tracked".
function git(args: string[]): string | null {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  return r.status === 0 ? (r.stdout ?? "").trim() : null;
}
const dataLs = git(["ls-files", "data"]);
const deployLs = git(["ls-files", "deploy"]);
const profilesLs = git(["ls-files", "profiles"]);
const remoteLs = git(["remote"]);
if (dataLs === null || deployLs === null || profilesLs === null || remoteLs === null) {
  notes.push("data: could not check git tracking (git unavailable or not a repo)");
} else {
  const dataTracked = dataLs.length > 0;
  const deployTracked = deployLs.length > 0;
  const profilesTracked = profilesLs.length > 0;
  const hasRemote = remoteLs.length > 0;
  if (profilesTracked && hasRemote) {
    problems.push(
      "profiles/ is git-tracked in a repo that HAS A REMOTE — the consolidated PII zone (tax " +
        "identities, Steuernummern, pins, the forward book) could be pushed. Add profiles/ to " +
        ".gitignore, or remove the remote. Committing profiles/ is only safe in a remoteless " +
        "local store like the imprnt vault.",
    );
  } else if (profilesTracked) {
    notes.push("profiles: committed (no remote — canonical local store, safe)");
  }
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
  if (deployTracked && hasRemote) {
    problems.push(
      "deploy/ is git-tracked in a repo that HAS A REMOTE — the rendered dashboard (net worth, " +
        "savings, transactions) could be pushed. Add deploy/ to .gitignore, or remove the remote.",
    );
  } else if (deployTracked) {
    notes.push("deploy: committed (no remote — safe)");
  }
}

// Profile: optional (absent = generic mode), but if present it must be valid JSON.
// profiles/household.json is the post-tax-face home; data/profile.json still counts.
const profileCandidates = [join(ROOT, "profiles", "household.json"), join(DATA, "profile.json")];
const profilePath = profileCandidates.find((p) => existsSync(p));
if (profilePath !== undefined) {
  try {
    JSON.parse(readFileSync(profilePath, "utf8"));
    notes.push(`profile: present (${basename(dirname(profilePath))}/${basename(profilePath)})`);
  } catch (e) {
    problems.push(`${profilePath} is not valid JSON (${(e as Error).message})`);
  }
} else {
  notes.push("profile: none (generic mode — no net-worth layer, raw labels)");
}

// Tax profiles: every JSON in profiles/<person>/ must parse — a broken pins.json
// would silently strand decisions.
const profilesDir = join(ROOT, "profiles");
if (existsSync(profilesDir)) {
  let persons = 0;
  for (const entry of readdirSync(profilesDir)) {
    const dir = join(profilesDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    persons += 1;
    for (const f of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
      try {
        JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch (e) {
        problems.push(`profiles/${entry}/${f} is not valid JSON (${(e as Error).message})`);
      }
    }
  }
  if (persons > 0) notes.push(`tax profiles: ${persons} person(s)`);
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
