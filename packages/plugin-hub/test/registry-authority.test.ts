// Whose copy of the registry is the one, and what else a copy carries per
// machine: the store machine is named in the file and never inferred, an
// agent's own files are checked readable only where its runner is, and a
// repository's ssh command never follows a checkout onto another machine.

import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts";
import { listAgents, listRepositories } from "../src/registry/entries.ts";
import { storeMachineOf } from "../src/hub/digest.ts";

let dir: string;
function write(lines: string[]): string {
  dir ??= mkdtempSync(join(tmpdir(), "hub-authority-"));
  const file = join(dir, `registry-${crypto.randomUUID().slice(0, 8)}.toml`);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

function lines(extra: { hub?: string[]; mac?: string[]; agent?: string[]; repo?: string[] } = {}): string[] {
  return [
    "[hub]",
    "tick_seconds = 5",
    'store_url = "postgres://127.0.0.1:5432/hub"',
    'state_dir = "/var/lib/imprnt-hub"',
    ...(extra.hub ?? []),
    "",
    "[[machines]]",
    'id = "pi"',
    'os = "linux"',
    "",
    "[[machines]]",
    'id = "mac"',
    'os = "macos"',
    ...(extra.mac ?? []),
    "",
    "[[people]]",
    'id = "p1"',
    'tree = "/var/lib/imprnt-hub/p1"',
    "",
    "[presets.daily]",
    'adapter = "fake"',
    'model = "a-model-name"',
    'provider = "a-provider"',
    'effort = "medium"',
    'paid = "key"',
    "",
    "[[agents]]",
    'id = "p1-lair"',
    'person = "p1"',
    'preset = "daily"',
    'chat = "0000000000"',
    'door = "door-fake"',
    'runner = "runner-pi"',
    ...(extra.agent ?? []),
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
    'id = "runner-pi"',
    'kind = "runner"',
    'machine = "pi"',
    'schedule = "always"',
    "memory_limit_mb = 512",
    "child_memory_limit_mb = 2048",
    "",
    "[[run]]",
    'id = "runner-mac"',
    'kind = "runner"',
    'machine = "mac"',
    'schedule = "always"',
    "memory_limit_mb = 512",
    "child_memory_limit_mb = 2048",
    "",
    "[[repositories]]",
    'id = "p1-vault"',
    'person = "p1"',
    'path = "/var/lib/imprnt-hub/p1"',
    'remote = "origin"',
    'branch = "main"',
    'ssh_command = "ssh -i /var/lib/imprnt-hub/keys/vault -o IdentitiesOnly=yes"',
    ...(extra.repo ?? []),
  ];
}

function refusalOf(file: string, machine?: string): RegistryRefused {
  try {
    loadRegistry(file, machine === undefined ? {} : { machine });
  } catch (error) {
    return error as RegistryRefused;
  }
  throw new Error(`${file} loaded, and it should have been refused`);
}

test("the store machine is the one the file names, required as soon as a machine reaches the store by its own route, and never inferred", () => {
  // One route to the store: no authority is needed and none is inferred.
  expect(storeMachineOf(loadRegistry(write(lines())))).toBeNull();
  // A machine with its own route and no authority named is refused, by key.
  const routed = ['store_url = "postgres://100.64.0.1:5432/hub"'];
  const refusal = refusalOf(write(lines({ mac: routed })));
  expect(refusal).toBeInstanceOf(RegistryRefused);
  expect(refusal.key).toBe("hub.store_machine");
  expect(refusal.reason).toContain("mac");
  // Named and declared: that machine, and nothing about who has an override.
  expect(storeMachineOf(loadRegistry(write(lines({ mac: routed, hub: ['store_machine = "pi"'] }))))).toBe("pi");
  expect(storeMachineOf(loadRegistry(write(lines({ hub: ['store_machine = "mac"'] }))))).toBe("mac");
  // Named and not declared: refused where it is written.
  const unknown = refusalOf(write(lines({ hub: ['store_machine = "laptop"'] })));
  expect(unknown.key).toBe("hub.store_machine");
  expect(unknown.line).toBe(lines({ hub: ['store_machine = "laptop"'] }).indexOf('store_machine = "laptop"') + 1);
});

test("an agent's files are checked readable on the machine its runner is on, and a path on another machine does not refuse this one's copy", () => {
  const missing = "/nowhere-on-this-machine/fragment.md";
  const file = write(lines({ agent: [`fragment = ${JSON.stringify(missing)}`] }));
  // The agent runs on the Pi: the Pi's view refuses, the Mac's does not, and
  // the file as written, with two machines declared, opens nothing.
  expect(refusalOf(file, "pi").key).toBe("agents[0].fragment");
  expect(listAgents(loadRegistry(file, { machine: "mac" }))[0].fragment).toBe(missing);
  expect(() => loadRegistry(file)).not.toThrow();
  // A relative path is refused on every view.
  expect(refusalOf(write(lines({ agent: ['fragment = "fragment.md"'] })), "mac").key).toBe("agents[0].fragment");
});

test("a repository's ssh command is the machine's own: the entry's never follows the checkout, a placement names its own, and an empty one means the account's ssh", () => {
  const base = loadRegistry(write(lines()));
  expect(listRepositories(base)[0].ssh_command).toContain("IdentitiesOnly");
  // Placed on the Mac with no ssh command of its own: none there.
  const none = loadRegistry(write(lines({ repo: ['on = { mac = { path = "/Users/owner/vault" } }'] })), { machine: "mac" });
  expect(listRepositories(none)[0].path).toBe("/Users/owner/vault");
  expect(listRepositories(none)[0].ssh_command).toBeUndefined();
  // Placed with its own.
  const own = loadRegistry(write(lines({ repo: ['on = { mac = { path = "/Users/owner/vault", ssh_command = "ssh -i /Users/owner/.ssh/vault" } }'] })), { machine: "mac" });
  expect(listRepositories(own)[0].ssh_command).toBe("ssh -i /Users/owner/.ssh/vault");
  // An empty string says so on purpose, and reads the same as none.
  const cleared = loadRegistry(write(lines({ repo: ['on = { mac = { path = "/Users/owner/vault", ssh_command = "" } }'] })), { machine: "mac" });
  expect(listRepositories(cleared)[0].ssh_command).toBeUndefined();
  // The Pi keeps its own.
  expect(listRepositories(loadRegistry(write(lines({ repo: ['on = { mac = { path = "/Users/owner/vault" } }'] })), { machine: "pi" }))[0].ssh_command).toContain("IdentitiesOnly");
  // Not a string: refused by key.
  expect(refusalOf(write(lines({ repo: ['on = { mac = { path = "/Users/owner/vault", ssh_command = 3 } }'] }))).key).toBe("repositories[0].on.mac.ssh_command");
});
