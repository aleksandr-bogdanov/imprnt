// A Claude Code login kept in the macOS keychain is a credential the hub can
// open, fingerprint and hand to the loop.
//
// On a Mac the login is a keychain item, `Claude Code-credentials`, and
// `~/.claude/.credentials.json` holds only MCP entries, so a `claude-login`
// entry that named a file there was honestly unreadable. The entry may now
// name the item, and three things read it: `check` opens the item and judges
// the login in it, the copy scan takes its tokens from the item and reports a
// copy anywhere else, and a launch copies the item into the entry's file, mode
// 600, on every spawn, because the boxed loop reads a file under
// `CLAUDE_SECURESTORAGE_CONFIG_DIR` and never the owner's keychain item.
//
// THE KEYCHAIN THESE CHECKS READ IS A SCRATCH FILE OF THEIR OWN, made with
// `security create-keychain` under a temporary directory, never added to the
// account's search list, and deleted at the end. The account's login keychain
// is not touched, which is why every reader takes a keychain file as a seam
// that production never sets. What is asserted is the outcome against the real
// `security` tool: what it answers for an item that is there, one that is not,
// and one that was replaced.
//
// On a box that is not a Mac the whole set is skipped by name, and the one
// case that holds everywhere, that a keychain login is unreadable where there
// is no keychain, runs there.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { loopFixture, launchInput } from "./helpers/rollout-loop.ts";
import { copyFindings, credentialFindings, realProber } from "../src/check/credentials.ts";
import { exportKeychainLogin, readKeychainItem } from "../src/adapters/keychain.ts";
import { makeLoopLaunch, validateCredentialSource } from "../src/adapters/launch.ts";
import type { CredentialEntry } from "../src/registry/load.ts";

const onMac = process.platform === "darwin" && existsSync("/usr/bin/security");
const suffix = onMac ? "" : ` [skipped: no keychain on ${process.platform}]`;

/** The service name of this run's items, so nothing here can collide with a real one. */
const SERVICE = `hub-check-login-${crypto.randomUUID().slice(0, 8)}`;

let dir = "";
let keychain = "";

function security(args: string[]): { code: number; out: string; err: string } {
  const answer = Bun.spawnSync(["/usr/bin/security", ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: answer.exitCode ?? 1, out: answer.stdout?.toString() ?? "", err: answer.stderr?.toString() ?? "" };
}

/** Put this text into the scratch keychain under `SERVICE`, replacing what was there. */
function keep(text: string, service = SERVICE): void {
  const put = security(["add-generic-password", "-U", "-a", "hub", "-s", service, "-w", text, keychain]);
  if (put.code !== 0) throw new Error(`add-generic-password: ${put.err}`);
}

function loginText(tag: string): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: `access-${tag}-${crypto.randomUUID()}`, refreshToken: `refresh-${tag}-${crypto.randomUUID()}`, refreshTokenExpiresAt: 4102444800000 } });
}

beforeAll(() => {
  if (!onMac) return;
  dir = mkdtempSync(join(tmpdir(), "hub-keychain-"));
  keychain = join(dir, "scratch.keychain-db");
  const made = security(["create-keychain", "-p", "", keychain]);
  if (made.code !== 0) throw new Error(`create-keychain: ${made.err}`);
  // A fresh keychain locks itself after a while; this one is read for the
  // length of the file and is deleted after, so it never locks.
  security(["set-keychain-settings", keychain]);
});

afterAll(() => {
  if (keychain !== "") security(["delete-keychain", keychain]);
  if (dir !== "") rmSync(dir, { recursive: true, force: true });
});

test("a keychain login is unreadable where there is no keychain, and says so rather than reading nothing", async () => {
  const { readKeychainItem: read } = await seam("src/adapters/keychain.ts");
  expect(typeof read).toBe("function");
  if (onMac) {
    // An item nobody made, in a keychain this check owns.
    const missing = readKeychainItem("nothing-of-this-name", { keychain });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.says).toContain("no keychain item");
    const prober = realProber({ keychain });
    const health = await prober.open({ id: "login", kind: "claude-login", file: join(dir, "login", ".credentials.json"), owner: "household", keychain: "nothing-of-this-name" });
    expect(health).toMatchObject({ ok: false, kind: "unreadable" });
    if (!health.ok) expect(health.says).toContain("nothing-of-this-name");
    return;
  }
  const answer = readKeychainItem("Claude Code-credentials");
  expect(answer.ok).toBe(false);
  if (!answer.ok) expect(answer.says).toContain("macOS");
  const health = await realProber().open({ id: "login", kind: "claude-login", file: "/nowhere/.credentials.json", owner: "household", keychain: "Claude Code-credentials" });
  expect(health).toMatchObject({ ok: false, kind: "unreadable" });
});

test.skipIf(!onMac)(
  `check opens the keychain item itself: a login in it is healthy, an item with no login is blank, and the finding names the item rather than a file${suffix}`,
  async () => {
    const file = join(dir, "login", ".credentials.json");
    const entry: CredentialEntry = { id: "household-claude", kind: "claude-login", file, owner: "household", keychain: SERVICE };
    const prober = realProber({ keychain });

    keep(loginText("live"));
    expect(await prober.open(entry)).toEqual({ ok: true });
    // The file the launch would make is not there, and the login is judged
    // healthy all the same: the item is the source.
    expect(existsSync(file)).toBe(false);

    keep(JSON.stringify({ mcpOAuth: {} }));
    const blank = await prober.open(entry);
    expect(blank).toMatchObject({ ok: false, kind: "blank" });
    if (!blank.ok) expect(blank.says).toContain(SERVICE);
    const findings = await credentialFindings({ entries: [entry], prober, machine: "mac" });
    expect(findings.length).toBe(1);
    expect(findings[0].kind).toBe("credential-blank");
    expect(findings[0].says).toContain(`in the keychain item ${JSON.stringify(SERVICE)}`);
    expect(findings[0].says).not.toContain(file);
    expect(findings[0].fix).toContain("log in with claude on the Mac");

    keep(JSON.stringify({ claudeAiOauth: { accessToken: "a", refreshToken: "b", refreshTokenExpiresAt: 1 } }));
    expect(await prober.open(entry)).toMatchObject({ ok: false, kind: "expired" });
  },
);

test.skipIf(!onMac)(
  `the copy scan takes the tokens from the keychain item and reports a copy in a root, never the entry's own file${suffix}`,
  async () => {
    const file = join(dir, "login", ".credentials.json");
    const entry: CredentialEntry = { id: "household-claude", kind: "claude-login", file, owner: "household", keychain: SERVICE };
    const prober = realProber({ keychain });
    const text = loginText("scan");
    keep(text);
    const secrets = await prober.secrets(entry);
    expect(secrets.length).toBe(2);
    expect(secrets.every((one) => text.includes(one))).toBe(true);

    const root = join(dir, "tree");
    mkdirSync(join(root, "notes"), { recursive: true });
    const copy = join(root, "notes", "pasted.md");
    writeFileSync(copy, `a login pasted into a note: ${JSON.parse(text).claudeAiOauth.accessToken}\n`);
    // The entry's own file, made from the item the way a launch makes it, is
    // where the login belongs and is never reported.
    exportKeychainLogin({ service: SERVICE, file, keychain });
    const found = await copyFindings({ entries: [entry], prober, roots: [root, { path: dirname(file), depth: 1 }], machine: "mac" });
    expect(found.map((one) => one.subject)).toEqual([copy]);
    expect(found[0].fix).toContain(file);
  },
);

test.skipIf(!onMac)(
  `a launch copies the keychain item into the entry's file, mode 600, on every spawn, and refuses when the item is gone${suffix}`,
  async () => {
    const f = loopFixture();
    try {
      const file = join(f.dir, "keychain-login", ".credentials.json");
      const credential: CredentialEntry = { ...f.credential, keychain: SERVICE, file };
      const first = loginText("first");
      keep(first);
      validateCredentialSource(credential, { keychain });

      const input = () => ({ ...launchInput(f), purpose: "ordinary" as const, credential, keychain });
      const one = await makeLoopLaunch(input());
      expect(readFileSync(file, "utf8")).toBe(first);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
      // The loop is pointed at the FILE, the way it is on every box, and never
      // at the keychain: a session's config directory is its own and the CLI
      // keys its keychain item by that directory.
      expect(one.env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(dirname(file));
      expect(one.env.CLAUDE_CONFIG_DIR!.startsWith(f.stateDir)).toBe(true);

      // A login renewed on the Mac replaces the item, and the next launch
      // carries the renewed one with nobody copying anything.
      const second = loginText("second");
      keep(second);
      await makeLoopLaunch(input());
      expect(readFileSync(file, "utf8")).toBe(second);
      expect(statSync(file).mode & 0o777).toBe(0o600);

      // The item gone is a login that cannot be handed to anything, said by
      // name, and the stale file is not read in its place.
      security(["delete-generic-password", "-s", SERVICE, keychain]);
      await expect(makeLoopLaunch(input())).rejects.toThrow(/credential-source-unreadable/);
      expect(() => validateCredentialSource(credential, { keychain })).toThrow(/credential-source-unreadable/);
    } finally {
      f.stop();
    }
  },
);
