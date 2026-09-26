// One registry file, read for the machine a process is on.
//
// A spoke keeps its state, its role passwords and its people's vault checkouts
// on its own disk and reaches the one store over the tailnet, and none of that
// is at the path the `[hub]` table and the `[[people]]` entries name for the
// hub machine. So a `[[machines]]` entry may carry its own `state_dir`,
// `secrets_dir` and `store_url`, a person may say where their tree and vault
// are on a machine under `on.<machine>`, and a credential may say where its
// file is there. A process loads the
// file FOR its machine and every reader below the loader sees one file with
// one answer, exactly as before.
//
// The placement is data in the file and nothing else: no environment
// variable, no command-line switch, no hostname read off the process, which is
// the same rule `[[machines]].os` already follows. Every wrong value is
// refused by KEY and LINE, because a placement that loaded and applied to
// nothing would be a spoke silently keeping the hub machine's paths.

import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { loadRegistry, readSetting, RegistryRefused } from "../src/registry/load.ts";
import { filingRulesFor, harvestFor, listCredentials, listMachines, listPeople, chatStateFor } from "../src/registry/entries.ts";
import { secretsDirOf, storeUrlFor } from "../src/store/secrets.ts";

let dir: string;
function write(lines: string[]): string {
  dir ??= mkdtempSync(join(tmpdir(), "hub-machine-view-"));
  const file = join(dir, `registry-${crypto.randomUUID().slice(0, 8)}.toml`);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/** A two-machine household whose second machine is a Mac with its own paths. */
function goodLines(): string[] {
  return [
    "[hub]",
    "tick_seconds = 5",
    'store_url = "postgres://127.0.0.1:5432/hub"',
    'state_dir = "/var/lib/imprnt-hub"',
    'secrets_dir = "/var/lib/imprnt-hub/secrets"',
    'store_machine = "pi"',
    "",
    "[[machines]]",
    'id = "pi"',
    'os = "linux"',
    "",
    "[[machines]]",
    'id = "mac"',
    'os = "macos"',
    'state_dir = "/Users/owner/.imprnt-hub"',
    'store_url = "postgres://100.64.0.1:5432/hub"',
    "",
    "[[people]]",
    'id = "p1"',
    'tree = "/var/lib/imprnt-hub/p1"',
    'vault = "/var/lib/imprnt-hub/p1/vault-project"',
    'harvester = "harvest"',
    'on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project" } }',
    "",
    "[[people]]",
    'id = "p2"',
    'tree = "/var/lib/imprnt-hub/p2"',
    "",
    "[[credentials]]",
    'id = "household-claude"',
    'kind = "claude-login"',
    'file = "/var/lib/imprnt-hub/credentials/.credentials.json"',
    'owner = "household"',
    'on = { mac = { file = "/Users/owner/.imprnt-hub/login/.credentials.json" } }',
    "",
    "[presets.daily]",
    'credential = "household-claude"',
    'adapter = "claude-code"',
    'model = "a-model-name"',
    'provider = "a-provider"',
    'effort = "medium"',
    'paid = "plan"',
    "window_pause_at = 85",
    "window_notice_at = 95",
    "window_hold_at = 100",
    "",
    "[presets.harvest]",
    'credential = "household-claude"',
    'adapter = "claude-code"',
    'model = "a-stronger-model-name"',
    'provider = "a-provider"',
    'effort = "high"',
    'paid = "plan"',
    "window_pause_at = 85",
    "window_notice_at = 95",
    "window_hold_at = 100",
    "",
    "[[agents]]",
    'id = "p1-lair"',
    'person = "p1"',
    'preset = "daily"',
    'chat = "0000000000"',
    'door = "door-fake"',
    'runner = "runner-mac"',
    "",
    "[[run]]",
    'id = "door-fake"',
    'kind = "door"',
    'machine = "pi"',
    'platform = "fake"',
    'person = "p1"',
    'token_file = "/dev/null"',
    'schedule = "always"',
    "memory_limit_mb = 192",
    "",
    "[[run]]",
    'id = "runner-mac"',
    'kind = "runner"',
    'machine = "mac"',
    'schedule = "always"',
    "memory_limit_mb = 512",
    "child_memory_limit_mb = 2048",
  ];
}

function lineOf(lines: string[], text: string): number {
  const at = lines.indexOf(text);
  if (at < 0) throw new Error(`the fixture has no line ${JSON.stringify(text)}`);
  return at + 1;
}

function replace(lines: string[], text: string, withText: string): string[] {
  const out = [...lines];
  out[lineOf(lines, text) - 1] = withText;
  return out;
}

function refusalOf(file: string, machine?: string): RegistryRefused {
  try {
    loadRegistry(file, machine === undefined ? {} : { machine });
  } catch (error) {
    return error as RegistryRefused;
  }
  throw new Error(`${file} loaded, and it should have been refused`);
}

test("the file as written is the hub machine's view, and a view for another machine carries that machine's own paths", async () => {
  const { MACHINE_SETTINGS } = await seam("src/registry/load.ts");
  expect(MACHINE_SETTINGS).toEqual(["state_dir", "secrets_dir", "store_url", "imprnt"]);
  const file = write(goodLines());

  // --- the file as written: nothing about the Mac shows through.
  const base = loadRegistry(file);
  expect(base.machine).toBeNull();
  expect(readSetting(base, "hub.state_dir")).toBe("/var/lib/imprnt-hub");
  expect(readSetting(base, "hub.secrets_dir")).toBe("/var/lib/imprnt-hub/secrets");
  expect(readSetting(base, "hub.store_url")).toBe("postgres://127.0.0.1:5432/hub");
  expect(listPeople(base).find((one) => one.id === "p1")).toMatchObject({
    tree: "/var/lib/imprnt-hub/p1",
    vault: "/var/lib/imprnt-hub/p1/vault-project",
  });
  // The placement is not a field on the entry: a person is `id` and `tree`
  // and whatever else the file set, and `on` is the loader's to apply.
  for (const person of listPeople(base)) expect(Object.keys(person)).not.toContain("on");
  for (const credential of listCredentials(base)) expect(Object.keys(credential)).not.toContain("on");
  expect(listCredentials(base)[0]).toEqual({
    id: "household-claude",
    kind: "claude-login",
    file: "/var/lib/imprnt-hub/credentials/.credentials.json",
    owner: "household",
  });
  expect(listMachines(base).find((one) => one.id === "mac")).toEqual({
    id: "mac",
    os: "macos",
    state_dir: "/Users/owner/.imprnt-hub",
    store_url: "postgres://100.64.0.1:5432/hub",
  });
  expect(listMachines(base).find((one) => one.id === "pi")).toEqual({ id: "pi", os: "linux" });

  // --- the hub machine's own view is the file as written.
  const pi = loadRegistry(file, { machine: "pi" });
  expect(pi.machine).toBe("pi");
  expect(readSetting(pi, "hub.state_dir")).toBe("/var/lib/imprnt-hub");
  expect(listPeople(pi)).toEqual(listPeople(base));
  expect(listCredentials(pi)).toEqual(listCredentials(base));

  // --- the Mac's view: its own three settings, its people's trees, its
  //     credential's file and source, and everything else the file's.
  const mac = loadRegistry(file, { machine: "mac" });
  expect(mac.machine).toBe("mac");
  expect(readSetting(mac, "hub.state_dir")).toBe("/Users/owner/.imprnt-hub");
  expect(readSetting(mac, "hub.store_url")).toBe("postgres://100.64.0.1:5432/hub");
  // A machine with a state directory of its own keeps its secrets under it,
  // because the hub machine's secrets directory is a path on the hub's disk.
  expect(readSetting(mac, "hub.secrets_dir")).toBeUndefined();
  expect(secretsDirOf(mac)).toBe("/Users/owner/.imprnt-hub/secrets");
  expect(readSetting(mac, "hub.tick_seconds")).toBe(5);
  expect(listPeople(mac).find((one) => one.id === "p1")).toEqual({
    id: "p1",
    tree: "/Users/owner/vault-project",
    vault: "/Users/owner/vault-project",
    harvester: "harvest",
  });
  // A person who says nothing about the Mac keeps the file's paths there.
  expect(listPeople(mac).find((one) => one.id === "p2")).toEqual({ id: "p2", tree: "/var/lib/imprnt-hub/p2" });
  expect(harvestFor(mac, "p1")?.vault).toBe("/Users/owner/vault-project");
  expect(filingRulesFor(mac, "p1")).toBe("/Users/owner/vault-project/CLAUDE.md");
  expect(listCredentials(mac)[0]).toEqual({
    id: "household-claude",
    kind: "claude-login",
    file: "/Users/owner/.imprnt-hub/login/.credentials.json",
    owner: "household",
  });
  // The reader of a chat is still decided by the two entries' machines, and
  // reads the same on every view.
  expect(chatStateFor(mac, "p1-lair")).toBe("store");
  expect(chatStateFor(base, "p1-lair")).toBe("store");
  // The store url a process opens carries the Mac's host and the Mac's role
  // password, read from the Mac's own secrets directory.
  const url = new URL(storeUrlFor(mac, "hub_runner", "runner-mac"));
  expect(url.hostname).toBe("100.64.0.1");
  expect(url.username).toBe("hub_runner");
});

test("a role's password on a spoke is read from that machine's own secrets directory", () => {
  const home = mkdtempSync(join(tmpdir(), "hub-machine-secrets-"));
  try {
    const secrets = join(home, "secrets");
    mkdirSync(secrets, { mode: 0o700 });
    writeFileSync(join(secrets, "hub_runner.password"), "spoke-runner-password\n", { mode: 0o600 });
    chmodSync(join(secrets, "hub_runner.password"), 0o600);
    const lines = replace(goodLines(), 'state_dir = "/Users/owner/.imprnt-hub"', `state_dir = ${JSON.stringify(home)}`);
    const mac = loadRegistry(write(lines), { machine: "mac" });
    const url = new URL(storeUrlFor(mac, "hub_runner", "runner-mac"));
    expect(url.password).toBe("spoke-runner-password");
    expect(url.hostname).toBe("100.64.0.1");
    // And the hub machine's view reads nothing from there.
    const pi = loadRegistry(write(lines), { machine: "pi" });
    expect(new URL(storeUrlFor(pi, "hub_runner", "runner-pi")).password).toBe("");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a view for a machine the file does not declare is refused by name", () => {
  const refusal = refusalOf(write(goodLines()), "macc");
  expect(refusal).toBeInstanceOf(RegistryRefused);
  expect(refusal.reason).toContain("macc");
  expect(refusal.key).toBe("machines");
  // A file that declares no machines has nothing to check a view against, and
  // a runner on it asks for the one machine there is.
  const lines = goodLines().filter((line) => !line.startsWith("[[machines]]") && !/^(id = "(pi|mac)"|os = "(linux|macos)"|state_dir = "\/Users|store_url = "postgres:\/\/100|store_machine = )/.test(line))
    .filter((line) => !line.startsWith("machine = ") && !line.startsWith("on = "));
  expect(() => loadRegistry(write(lines), { machine: "anything" })).not.toThrow();
});

test("every wrong placement is refused by key and by line", () => {
  const base = goodLines();
  const cases: { name: string; lines: string[]; key: string; line: string; reason: string }[] = [
    {
      name: "a relative state directory on a machine",
      lines: replace(base, 'state_dir = "/Users/owner/.imprnt-hub"', 'state_dir = "imprnt-hub"'),
      key: "machines[1].state_dir",
      line: 'state_dir = "imprnt-hub"',
      reason: "absolute",
    },
    {
      name: "a store url carrying a password",
      lines: replace(base, 'store_url = "postgres://100.64.0.1:5432/hub"', 'store_url = "postgres://hub_runner:secret@100.64.0.1:5432/hub"'),
      key: "machines[1].store_url",
      line: 'store_url = "postgres://hub_runner:secret@100.64.0.1:5432/hub"',
      reason: "password",
    },
    {
      name: "a store url that is not one",
      lines: replace(base, 'store_url = "postgres://100.64.0.1:5432/hub"', 'store_url = "not a url"'),
      key: "machines[1].store_url",
      line: 'store_url = "not a url"',
      reason: "not a url",
    },
    {
      name: "a person placed on a machine the file does not declare",
      lines: replace(base, 'on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project" } }',
        'on = { laptop = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project" } }'),
      key: "people[0].on.laptop",
      line: 'on = { laptop = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project" } }',
      reason: "laptop",
    },
    {
      name: "a placement with no tree",
      lines: replace(base, 'on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project" } }',
        'on = { mac = { vault = "/Users/owner/vault-project" } }'),
      key: "people[0].on.mac.tree",
      line: 'on = { mac = { vault = "/Users/owner/vault-project" } }',
      reason: "absolute",
    },
    {
      name: "a placement whose vault is outside its tree",
      lines: replace(base, 'on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project" } }',
        'on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/elsewhere" } }'),
      key: "people[0].on.mac.vault",
      line: 'on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/elsewhere" } }',
      reason: "outside",
    },
    {
      name: "a person with a vault whose placement names none",
      lines: replace(base, 'on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project" } }',
        'on = { mac = { tree = "/Users/owner/vault-project" } }'),
      key: "people[0].on.mac.vault",
      line: 'on = { mac = { tree = "/Users/owner/vault-project" } }',
      reason: "names a vault",
    },
    {
      name: "a placement carrying a key a placement cannot carry",
      lines: replace(base, 'on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project" } }',
        'on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project", language = "ru" } }'),
      key: "people[0].on.mac.language",
      line: 'on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project", language = "ru" } }',
      reason: "language",
    },
    {
      name: "a placement that is not a table",
      lines: replace(base, 'on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project" } }',
        'on = { mac = "/Users/owner/vault-project" }'),
      key: "people[0].on.mac",
      line: 'on = { mac = "/Users/owner/vault-project" }',
      reason: "table",
    },
    {
      name: "a credential placement with no file",
      lines: replace(base, 'on = { mac = { file = "/Users/owner/.imprnt-hub/login/.credentials.json" } }',
        'on = { mac = { file = "login/.credentials.json" } }'),
      key: "credentials[0].on.mac.file",
      line: 'on = { mac = { file = "login/.credentials.json" } }',
      reason: "absolute",
    },
    {
      name: "a credential placement naming a source a placement cannot carry",
      lines: replace(base, 'on = { mac = { file = "/Users/owner/.imprnt-hub/login/.credentials.json" } }',
        'on = { mac = { file = "/Users/owner/.imprnt-hub/login/.credentials.json", keychain = "Claude Code-credentials" } }'),
      key: "credentials[0].on.mac.keychain",
      line: 'on = { mac = { file = "/Users/owner/.imprnt-hub/login/.credentials.json", keychain = "Claude Code-credentials" } }',
      reason: "keychain",
    },
  ];
  for (const one of cases) {
    // A file with a key written on two lines is re-split, so a line index of
    // the file as written is what is compared against.
    const lines = one.lines.flatMap((line) => line.split("\n"));
    const refusal = refusalOf(write(lines));
    expect(refusal, one.name).toBeInstanceOf(RegistryRefused);
    expect(refusal.key, one.name).toBe(one.key);
    expect(refusal.line, one.name).toBe(lineOf(lines, one.line));
    expect(refusal.reason, one.name).toContain(one.reason);
    expect(String(refusal.message), one.name).toContain(String(refusal.line));
  }
});

test("a file with no placements loads to the same people and credentials it always did, on every view", () => {
  const lines = goodLines()
    .filter((line) => !line.startsWith("on = "))
    .filter((line) => !line.startsWith('state_dir = "/Users') && !line.startsWith('store_url = "postgres://100'));
  const file = write(lines);
  const base = loadRegistry(file);
  const mac = loadRegistry(file, { machine: "mac" });
  expect(listPeople(mac)).toEqual(listPeople(base));
  expect(listCredentials(mac)).toEqual(listCredentials(base));
  expect(readSetting(mac, "hub.state_dir")).toBe("/var/lib/imprnt-hub");
  expect(readSetting(mac, "hub.secrets_dir")).toBe("/var/lib/imprnt-hub/secrets");
  expect(readSetting(mac, "hub.store_url")).toBe("postgres://127.0.0.1:5432/hub");
});
