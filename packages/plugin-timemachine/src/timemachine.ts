// imprnt timemachine - an opt-in local snapshot safety net for skip-permissions sessions.
//
// Before any mutating tool runs, timemachine snapshots your git working tree (respecting
// .gitignore, skipping obvious secrets) to a side ref under refs/timemachine/. So if the
// agent deletes or overwrites something git can't otherwise bring back - an untracked
// file, an uncommitted change - the version from a moment earlier is recoverable.
//
// It NEVER blocks a tool (it always exits 0), NEVER captures anything .gitignore hides,
// and NEVER leaves your machine (refs/timemachine/* are not pushed). Recovery is plain git.
//
//   node timemachine.js --hook               # PreToolUse hook: snapshot the pre-tool state, exit 0
//   node timemachine.js list                 # snapshots here, newest first
//   node timemachine.js restore <id> [path]  # restore a path (or all) from a snapshot into the tree
//   node timemachine.js show <id>            # what a snapshot changed (git show --stat)
//   node timemachine.js wipe                 # delete every timemachine snapshot in this repo
//   node timemachine.js status               # where snapshots live, how many, when last
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REF = "refs/timemachine"; // side ref namespace - not pushed by default, not on any branch
const LATEST = `${REF}/latest`;
const KEEP = 200; // bound .git growth: keep the most recent N snapshots

// Belt-and-suspenders on top of .gitignore: never capture obvious secrets even if the user forgot
// to ignore them. These go in a throwaway excludes file layered on top of the repo's own .gitignore
// (which still applies), so a secret is skipped without ever being named in a pathspec - naming an
// ignored path in a pathspec makes `git add` error.
const SECRET_PATTERNS = [
  ".env", "*.env", "*.pem", "*.key", "*.p12", "*.pfx",
  "id_rsa", "id_ed25519", "*credentials*", "*.secret",
];

function git(args: string[], cwd: string, allowFail = false): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    if (allowFail) return "";
    throw new Error(`git ${args[0]} failed`);
  }
}

export function repoRoot(cwd: string): string | null {
  return git(["rev-parse", "--show-toplevel"], cwd, true) || null;
}

// Snapshot the working tree WITHOUT touching the real index, HEAD, or the files on disk.
// Returns the new snapshot commit SHA, or null if there was nothing new to capture.
export function snapshot(cwd: string): string | null {
  const root = repoRoot(cwd);
  if (!root) return null; // not a git repo: nothing to protect, skip silently

  // cheap gate: is anything uncommitted or untracked? (porcelain already excludes .gitignored files)
  if (!git(["status", "--porcelain"], root, true)) return null;

  // build a tree from a THROWAWAY index so the real index is never disturbed. `git add -A`
  // respects .gitignore (ignored files are never staged), and the excludes drop secret shapes.
  const tmp = mkdtempSync(join(tmpdir(), "timemachine-"));
  const excludes = join(tmp, "excludes");
  writeFileSync(excludes, SECRET_PATTERNS.join("\n") + "\n");
  const env = { ...process.env, GIT_INDEX_FILE: join(tmp, "index") };
  try {
    execFileSync("git", ["-c", `core.excludesFile=${excludes}`, "add", "-A", "--", "."], { cwd: root, env, stdio: "ignore" });
    const tree = execFileSync("git", ["write-tree"], { cwd: root, env, encoding: "utf8" }).trim();

    // nothing new since the last snapshot? skip (so identical states are not re-stored)
    if (tree === git(["rev-parse", `${LATEST}^{tree}`], root, true)) return null;

    const head = git(["rev-parse", "HEAD"], root, true);
    const commit = execFileSync(
      "git",
      ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `timemachine ${new Date().toISOString()}`],
      { cwd: root, env, encoding: "utf8" },
    ).trim();

    git(["update-ref", `${REF}/${Date.now()}`, commit], root);
    git(["update-ref", LATEST, commit], root);
    prune(root);
    return commit;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function prune(root: string) {
  const refs = git(["for-each-ref", "--sort=-committerdate", "--format=%(refname)", `${REF}/`], root, true)
    .split("\n")
    .filter((r) => r && r !== LATEST);
  for (const ref of refs.slice(KEEP)) git(["update-ref", "-d", ref], root, true);
}

// ---- CLI ----------------------------------------------------------------------------------------

function refOf(id: string): string {
  return id.startsWith("refs/") ? id : id.startsWith("timemachine/") ? `refs/${id}` : `${REF}/${id}`;
}

function cli(argv: string[]): void {
  const cwd = process.cwd();
  const root = repoRoot(cwd);
  const cmd = argv[0];

  if (cmd === "list") {
    if (!root) return console.log("timemachine: not inside a git repo here.");
    const rows = git(["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)\t%(committerdate:relative)", `${REF}/`], root, true)
      .split("\n").filter((l) => l && !l.startsWith("timemachine/latest"));
    console.log(rows.length ? rows.join("\n") : "timemachine: no snapshots yet.");
    return;
  }
  if (cmd === "restore") {
    const id = argv[1];
    if (!root || !id) { console.error("usage: timemachine restore <id> [path]"); process.exit(1); }
    const path = argv[2] ?? ".";
    git(["checkout", refOf(id), "--", path], root);
    console.log(`timemachine: restored ${argv[2] ?? "all files"} from ${id}`);
    return;
  }
  if (cmd === "show") {
    const id = argv[1];
    if (!root || !id) { console.error("usage: timemachine show <id>"); process.exit(1); }
    console.log(git(["show", "--stat", refOf(id)], root, true));
    return;
  }
  if (cmd === "wipe") {
    if (!root) return console.log("timemachine: not inside a git repo here.");
    const refs = git(["for-each-ref", "--format=%(refname)", `${REF}/`], root, true).split("\n").filter(Boolean);
    for (const ref of refs) git(["update-ref", "-d", ref], root, true);
    console.log(`timemachine: wiped ${refs.length} snapshot ref(s).`);
    return;
  }
  // status (default)
  if (!root) return console.log("timemachine: not inside a git repo (nothing to protect here).");
  const count = git(["for-each-ref", "--format=%(refname)", `${REF}/`], root, true)
    .split("\n").filter((r) => r && r !== LATEST).length;
  const last = git(["log", "-1", "--format=%cr", LATEST], root, true);
  console.log(`timemachine: ${count} snapshot(s) in ${root}/.git (refs/timemachine/*, local only, never pushed).`);
  if (last) console.log(`timemachine: last snapshot ${last}.`);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  if (argv[0] === "--hook") {
    // PreToolUse: the harness pipes a JSON payload on stdin; cwd tells us which repo.
    let cwd = process.cwd();
    try {
      const p = JSON.parse(readFileSync(0, "utf8")) as { cwd?: unknown };
      if (typeof p.cwd === "string") cwd = p.cwd;
    } catch { /* no/garbled payload: fall back to process.cwd */ }
    try { snapshot(cwd); } catch { /* a snapshot must never break a tool call */ }
    process.exit(0); // never block
  }
  cli(argv);
}
