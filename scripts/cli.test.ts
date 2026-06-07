import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// cli.ts resolves the repo root from import.meta.url and edits CLAUDE.local.md there. To exercise
// the real binary without ever touching the real CLAUDE.local.md, we copy the scripts/ tree plus a
// fake plugins/ into a throwaway root and run the copied cli.ts. Each test wires that copy.
const realRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function tmpRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "imprint-cli-"));
  // The CLI only imports from scripts/ for the paths we test (plugin + vaultArg). Copy scripts/.
  cpSync(join(realRoot, "scripts"), join(root, "scripts"), { recursive: true });
  // Fake plugins gallery: a real entry, plus a guard-style dir with no agent.md.
  mkdirSync(join(root, "plugins", "anti-slop"), { recursive: true });
  writeFileSync(join(root, "plugins", "anti-slop", "agent.md"), "x");
  mkdirSync(join(root, "plugins", "character"), { recursive: true });
  writeFileSync(join(root, "plugins", "character", "scribe.md"), "x");
  mkdirSync(join(root, "plugins", "guard"), { recursive: true });
  writeFileSync(join(root, "plugins", "guard", "guard.ts"), "x");
  return root;
}

type Run = { code: number; stdout: string; stderr: string };

async function runCli(root: string, args: string[], env: Record<string, string> = {}): Promise<Run> {
  const proc = Bun.spawn(["bun", join(root, "scripts", "cli.ts"), ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

function readLocal(root: string): string {
  const p = join(root, "CLAUDE.local.md");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
}

let bunOk = true;
beforeAll(() => {
  bunOk = Bun.which("bun") !== null;
});

// --- bug 2: dangling --vault ---

test("hot with a dangling --vault exits 1 with a clean usage error (no stack trace)", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["hot", "--vault"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("--vault <dir>");
  expect(r.stderr).not.toContain("TypeError");
  expect(r.stderr).not.toMatch(/at .*cli\.ts/);
});

// --- bug 1 + bug 3: multi-spec add end to end ---

test("plugin add a b wires BOTH (bug 1)", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "add", "character/scribe.md", "anti-slop"]);
  expect(r.code).toBe(0);
  const local = readLocal(root);
  expect(local).toContain("@plugins/character/scribe.md");
  expect(local).toContain("@plugins/anti-slop/agent.md");
});

test("plugin add nonexistent errors, exits 1, wires nothing (bug 3)", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "add", "doesnotexist"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no such plugin entry");
  expect(readLocal(root)).not.toContain("@plugins/doesnotexist");
});

test("plugin add guard (no agent.md) errors (bug 3)", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "add", "guard"]);
  expect(r.code).toBe(1);
  expect(r.stderr).toContain("no such plugin entry");
  expect(readLocal(root)).not.toContain("@plugins/guard");
});

test("multi-spec add: bad spec skipped with error, good one wired, overall exit 1", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "add", "anti-slop", "doesnotexist"]);
  expect(r.code).toBe(1);
  expect(r.stdout).toContain("wired @plugins/anti-slop/agent.md");
  expect(r.stderr).toContain("no such plugin entry");
  const local = readLocal(root);
  expect(local).toContain("@plugins/anti-slop/agent.md");
  expect(local).not.toContain("@plugins/doesnotexist");
});

test("plugin add _personal/<file.md> wires the documented personalization path (exit 0)", async () => {
  const root = tmpRepo();
  // The documented "make it yours" flow: drop a private file under plugins/_personal/ and wire it.
  // listPluginDirs hides _personal from the gallery, but add must still wire it. This end-to-end
  // test would FAIL if the cli/add path ever excluded _-prefixed specs - exit would be 1 and no
  // @plugins/_personal line would land in CLAUDE.local.md.
  mkdirSync(join(root, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(root, "plugins", "_personal", "voice.md"), "x");
  const r = await runCli(root, ["plugin", "add", "_personal/voice.md"]);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain("wired @plugins/_personal/voice.md");
  expect(readLocal(root)).toContain("@plugins/_personal/voice.md");
  // The gallery listing still does not surface _personal as a toggleable plugin.
  const list = await runCli(root, ["plugin", "list"]);
  expect(list.stdout).not.toContain("_personal");
});

test("plugin add a a (duplicate spec in one call) is idempotent: a single line", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "add", "anti-slop", "anti-slop"]);
  expect(r.code).toBe(0);
  const lines = readLocal(root)
    .split("\n")
    .filter((l) => l.trim() === "@plugins/anti-slop/agent.md");
  expect(lines.length).toBe(1);
});

test("plugin rm accepts multiple specs", async () => {
  const root = tmpRepo();
  await runCli(root, ["plugin", "add", "anti-slop", "character/scribe.md"]);
  const r = await runCli(root, ["plugin", "rm", "anti-slop", "character"]);
  expect(r.code).toBe(0);
  const local = readLocal(root);
  expect(local).not.toContain("@plugins/anti-slop/agent.md");
  expect(local).not.toContain("@plugins/character/scribe.md");
});

test("unknown plugin subcommand exits 1", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["plugin", "bogus"]);
  expect(r.code).toBe(1);
});

test("unknown top-level subcommand exits 1", async () => {
  const root = tmpRepo();
  const r = await runCli(root, ["nonsense"]);
  expect(r.code).toBe(1);
});
