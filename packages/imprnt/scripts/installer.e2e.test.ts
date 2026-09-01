// The installer gate (task 15674): the novice first-run path, exercised against the PACKED
// artifact - the exact tarball npm would deliver - never the source tree. Every other test file
// runs scripts/*.ts under bun, so a files[] omission, a bun-ism surviving into dist/, a template
// that resolves only in the repo, or a broken bin shebang would pass the whole suite and still
// break `npm i -g imprnt && imprnt init` on a clean machine. This file is where the installer
// cannot lie: pack, install into a throwaway prefix, then walk the first-run commands under
// plain node with a fenced HOME/XDG.
//
// Deliberately offline-safe: the package has zero runtime dependencies, so `npm install -g`
// from a local tarball touches no registry.
import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const PKG = join(import.meta.dir, "..");

let prefix: string; // npm --prefix target: bin/ + lib/node_modules land here
let home: string; // fenced HOME + XDG_CONFIG_HOME, so registration never touches the real one
let tarball: string;

// The env every child in this file gets: the operator's shell MINUS every pointer that would steer
// the CLI at real data. This is not hygiene, it is the whole premise of the file. `imprnt check`
// resolves its vault from IMPRNT_VAULT (and the legacy IMPRINT_VAULT spelling) BEFORE it looks at
// the registry, so a bare `{ ...process.env }` pointed the e2e's inner check at the developer's own
// vault - reading it and REWRITING its control files (index.md, _tags.md, _needs-review.md) on every
// run, then failing on that vault's health instead of the scaffold under test. CLAUDE_CONFIG_DIR and
// IMPRNT_HOST_MEMORY_DIR go the same way: they steer the host-memory sweep out of the fenced HOME
// and back at the real ~/.claude, which is the other way a clean-machine assertion reads real state.
// A clean machine has none of these set, and that machine is exactly what this suite claims to prove.
const STEERING = /^(IMPRI?NT_(VAULT|ROOT|HOST_MEMORY_DIR)|CLAUDE_CONFIG_DIR)$/i;
function fencedEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !STEERING.test(k)) env[k] = v;
  return { ...env, ...extra };
}

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: fencedEnv() });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// Run the INSTALLED bin the way a user's shell would: the prefix's bin entry, under node via its
// shebang, with a fenced environment. Never bun, never the source tree.
function imprnt(args: string[], cwd: string) {
  return spawnSync(join(prefix, "bin", "imprnt"), args, {
    cwd,
    encoding: "utf8",
    env: fencedEnv({ HOME: home, XDG_CONFIG_HOME: join(home, ".config") }),
  });
}

beforeAll(() => {
  const tmp = mkdtempSync(join(tmpdir(), "imprnt-e2e-"));
  prefix = join(tmp, "prefix");
  home = join(tmp, "home");
  mkdirSync(prefix, { recursive: true });
  mkdirSync(home, { recursive: true });
  // The same steps prepublishOnly runs before a real publish, minus the recursion into this suite.
  sh("bun", ["run", "shipdocs"], PKG);
  sh("bun", ["run", "build"], PKG);
  const packed = sh("npm", ["pack", "--pack-destination", tmp], PKG).trim().split("\n").pop()!;
  tarball = join(tmp, packed);
  sh("npm", ["install", "-g", "--prefix", prefix, "--no-audit", "--no-fund", tarball], tmp);
});

test("the tarball ships the runtime and only the runtime", () => {
  const listing = sh("tar", ["-tzf", tarball], PKG);
  // What a user needs: the two bins, the templates init copies, the vault contract.
  for (const f of [
    "package/dist/cli.js",
    "package/dist/imp.js",
    "package/templates/index.md",
    "package/templates/hot.md",
    "package/templates/log.md",
    "package/templates/_tags.md",
    "package/CLAUDE.md",
  ])
    expect(listing).toContain(f);
  // What must never ship: source, tests, this file.
  expect(listing).not.toContain("package/scripts/");
  expect(listing).not.toContain(".test.");
});

test("the child env is fenced: no shell variable can steer the installed CLI at real data", () => {
  const saved = { ...process.env };
  try {
    process.env.IMPRNT_VAULT = "/real/vault";
    process.env.IMPRINT_VAULT = "/real/vault"; // the legacy spelling the CLI still honours
    process.env.CLAUDE_CONFIG_DIR = "/real/.claude";
    process.env.IMPRNT_HOST_MEMORY_DIR = "/real/memory";
    process.env.IMPRNT_E2E_KEEPME = "kept";
    const env = fencedEnv({ HOME: "/tmp/fenced" });
    for (const k of ["IMPRNT_VAULT", "IMPRINT_VAULT", "CLAUDE_CONFIG_DIR", "IMPRNT_HOST_MEMORY_DIR"])
      expect(env[k]).toBeUndefined();
    // Only the steering vars go: PATH and the rest of the shell still reach the child, or npm and
    // node would not resolve at all.
    expect(env.IMPRNT_E2E_KEEPME).toBe("kept");
    expect(env.HOME).toBe("/tmp/fenced");
    expect(env.PATH).toBe(process.env.PATH ?? "");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test("first run: init in an empty dir scaffolds a working vault", () => {
  const proj = mkdtempSync(join(tmpdir(), "imprnt-e2e-proj-"));
  const r = imprnt(["init"], proj);
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("initialized vault at");
  for (const f of ["vault/index.md", "vault/hot.md", "vault/log.md", "vault/_tags.md"])
    expect(existsSync(join(proj, f))).toBe(true);
  expect(existsSync(join(proj, "raw"))).toBe(true);
  // The privacy floor: init locks the project root owner-only.
  expect(statSync(proj).mode & 0o777).toBe(0o700);
  // Registration landed in the FENCED config dir, not the real one.
  expect(existsSync(join(home, ".config", "imprnt", "config.json"))).toBe(true);

  // A fresh scaffold is clean by check's own standard.
  const fresh = imprnt(["check"], proj);
  expect(fresh.status).toBe(0);
  expect(fresh.stdout).toContain("clean");

  // Re-init is idempotent and says so; a user's note survives byte-identical.
  const note = join(proj, "vault", "note.md");
  writeFileSync(note, "---\ntype: note\nkind: reference\ntags: [e2e]\nsummary: \"e2e fixture\"\n---\n\n# E2E note\n");
  const again = imprnt(["init"], proj);
  expect(again.status).toBe(0);
  expect(again.stdout).toContain("left untouched");
  expect(readFileSync(note, "utf8")).toContain("# E2E note");

  // The integrity pass a novice hits next: the unlinked note is FLAGGED (soft-fail, exit 1,
  // routed to needs-review) rather than silently accepted or fatally rejected.
  const check = imprnt(["check"], proj);
  expect(check.status).toBe(1);
  expect(check.stdout).toContain("disconnected notes");
  expect(check.stdout).toContain("_needs-review.md");
  // And recall finds the note by its tag, BM25 over the packed artifact.
  const recall = imprnt(["recall", "e2e"], proj);
  expect(recall.status).toBe(0);
  expect(recall.stdout).toContain("note");
});

test("plugin add works against the installed CLI", () => {
  const proj = mkdtempSync(join(tmpdir(), "imprnt-e2e-plug-"));
  expect(imprnt(["init"], proj).status).toBe(0);
  // A minimal plugin package dir, the --from path (same shape install.test.ts packs).
  const src = mkdtempSync(join(tmpdir(), "imprnt-e2e-plugsrc-"));
  writeFileSync(
    join(src, "package.json"),
    JSON.stringify({ name: "imprnt-plugin-e2e", version: "0.0.1", files: ["agent.md", "check.js"] }),
  );
  writeFileSync(join(src, "agent.md"), "# e2e agent\n");
  writeFileSync(join(src, "check.js"), "console.log('e2e ok');\n");
  const r = imprnt(["plugin", "add", "e2e", "--from", src], proj);
  expect(r.status).toBe(0);
  expect(existsSync(join(proj, "plugins", "e2e", "agent.md"))).toBe(true);
});
