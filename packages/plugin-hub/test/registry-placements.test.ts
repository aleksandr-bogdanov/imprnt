// The rest of what a machine may say about itself in the one registry: the
// command that files a note there, where a repository's checkout is there, and
// where a person's instruction files are there.
//
// The four files a person may name are read by a launch, and a launch happens
// on the machine an agent's runner is on. So they are checked readable on the
// view of a machine one of the person's agents runs on, and on the file as
// written when it declares fewer than two machines. A file with two machines
// read as written is a door's or a sync's read, which opens none of them, and
// a hub machine's path checked on the other machine would refuse that
// machine's copy of the file whole.

import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRegistry, readSetting, RegistryRefused } from "../src/registry/load.ts";
import { filingRulesFor, listPeople, listRepositories, repositoriesFor } from "../src/registry/entries.ts";
import { storeMachineOf } from "../src/hub/digest.ts";

let dir: string;
function write(lines: string[]): string {
  dir ??= mkdtempSync(join(tmpdir(), "hub-placements-"));
  const file = join(dir, `registry-${crypto.randomUUID().slice(0, 8)}.toml`);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/** A readable file of this check's own, so a placement can name one. */
function readableFile(name: string): string {
  dir ??= mkdtempSync(join(tmpdir(), "hub-placements-"));
  const file = join(dir, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "# rules\n");
  return file;
}

function lines(extra: { p1?: string[]; p2?: string[]; mac?: string[]; repo?: string[]; hub?: string[] } = {}): string[] {
  return [
    "[hub]",
    "tick_seconds = 5",
    'store_url = "postgres://127.0.0.1:5432/hub"',
    'state_dir = "/var/lib/imprnt-hub"',
    'imprnt = "/usr/local/bin/imprnt"',
    'store_machine = "pi"',
    ...(extra.hub ?? []),
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
    ...(extra.mac ?? []),
    "",
    "[[people]]",
    'id = "p1"',
    'tree = "/var/lib/imprnt-hub/p1"',
    'vault = "/var/lib/imprnt-hub/p1/vault-project"',
    ...(extra.p1 ?? []),
    "",
    "[[people]]",
    'id = "p2"',
    'tree = "/var/lib/imprnt-hub/p2"',
    ...(extra.p2 ?? []),
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
    'runner = "runner-mac"',
    "",
    "[[agents]]",
    'id = "p2-lair"',
    'person = "p2"',
    'preset = "daily"',
    'chat = "0000000001"',
    'door = "door-fake"',
    'runner = "runner-pi"',
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
    "[[run]]",
    'id = "vault-sync-mac"',
    'kind = "sync"',
    'machine = "mac"',
    'repositories = ["p1-vault"]',
    'schedule = "every 15m"',
    "memory_limit_mb = 128",
    "",
    "[[repositories]]",
    'id = "p1-vault"',
    'person = "p1"',
    'path = "/var/lib/imprnt-hub/p1/vault-project"',
    'remote = "origin"',
    'branch = "main"',
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

test("the command that files a note is the machine's own, a bare word allowed, and the store machine is the one with no store url of its own", () => {
  const file = write(lines({ mac: ['imprnt = "imprnt"'] }));
  expect(readSetting(loadRegistry(file), "hub.imprnt")).toBe("/usr/local/bin/imprnt");
  expect(readSetting(loadRegistry(file, { machine: "pi" }), "hub.imprnt")).toBe("/usr/local/bin/imprnt");
  expect(readSetting(loadRegistry(file, { machine: "mac" }), "hub.imprnt")).toBe("imprnt");
  expect(storeMachineOf(loadRegistry(file))).toBe("pi");
  // An empty command is refused where it is written.
  const refusal = refusalOf(write(lines({ mac: ['imprnt = ""'] })));
  expect(refusal.key).toBe("machines[1].imprnt");
});

test("a repository's checkout on a machine replaces its path and remote there, and a sync entry there reads the placed ones", () => {
  const file = write(lines({ repo: ['on = { mac = { path = "/Users/owner/vault-project", remote = "home" } }'] }));
  const base = loadRegistry(file);
  expect(listRepositories(base)[0]).toMatchObject({ path: "/var/lib/imprnt-hub/p1/vault-project", remote: "origin" });
  expect(Object.keys(listRepositories(base)[0])).not.toContain("on");
  const mac = loadRegistry(file, { machine: "mac" });
  expect(listRepositories(mac)[0]).toMatchObject({ path: "/Users/owner/vault-project", remote: "home", branch: "main" });
  expect(repositoriesFor(mac, "vault-sync-mac")[0].path).toBe("/Users/owner/vault-project");
  expect(mac.placed.repositories).toEqual(["p1-vault"]);
  expect(loadRegistry(file, { machine: "pi" }).placed.repositories).toEqual([]);
  // A relative path and an empty remote are refused by key.
  expect(refusalOf(write(lines({ repo: ['on = { mac = { path = "vault-project" } }'] }))).key).toBe("repositories[0].on.mac.path");
  expect(refusalOf(write(lines({ repo: ['on = { mac = { path = "/Users/owner/vault-project", remote = "" } }'] }))).key).toBe("repositories[0].on.mac.remote");
  expect(refusalOf(write(lines({ repo: ['on = { mac = { path = "/Users/owner/vault-project", branch = "dev" } }'] }))).key).toBe("repositories[0].on.mac.branch");
});

test("a zone checkout placed on a machine sits at the mount inside the person's vault there", () => {
  const zone = (path: string) => [
    "[zone]",
    'mount = "shared-notes"',
    'remote = "origin"',
    'url = "git@example.invalid:household/shared-notes.git"',
    "",
    ...lines({
      p1: ['on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project" } }'],
      repo: [
        "",
        "[[repositories]]",
        'id = "p1-zone"',
        'person = "p1"',
        'path = "/var/lib/imprnt-hub/p1/vault-project/vault/shared-notes"',
        'remote = "origin"',
        'branch = "main"',
        "zone = true",
        `on = { mac = { path = ${JSON.stringify(path)} } }`,
      ],
    }),
  ];
  const good = loadRegistry(write(zone("/Users/owner/vault-project/vault/shared-notes")), { machine: "mac" });
  expect(listRepositories(good).find((one) => one.id === "p1-zone")?.path).toBe("/Users/owner/vault-project/vault/shared-notes");
  const refusal = refusalOf(write(zone("/Users/owner/elsewhere/shared-notes")));
  expect(refusal.key).toBe("repositories[1].on.mac.path");
  expect(refusal.reason).toContain("/Users/owner/vault-project/vault/shared-notes");
});

test("a person's files are checked readable where their agents run, and a placement replaces them there", () => {
  const rules = readableFile("mac/CLAUDE.md");
  const macMcp = readableFile("mac/mcp.json");
  const missing = "/nowhere-on-this-machine/CLAUDE.md";
  // p1's agent runs on the Mac and p2's on the Pi. Both name a filing_rules
  // file only the Pi has, and p1 places its own on the Mac.
  const file = write(lines({
    p1: [`filing_rules = ${JSON.stringify(missing)}`, `mcp = ${JSON.stringify(missing)}`,
      `on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project", filing_rules = ${JSON.stringify(rules)}, mcp = ${JSON.stringify(macMcp)} } }`],
    p2: [`filing_rules = ${JSON.stringify(missing)}`],
  }));
  // The file as written declares two machines, so it is a door's read and no
  // file is opened.
  expect(() => loadRegistry(file)).not.toThrow();
  // The Mac's view: p1's placed files are read there and are readable, and
  // p2's are not read there at all.
  const mac = loadRegistry(file, { machine: "mac" });
  expect(listPeople(mac).find((one) => one.id === "p1")).toMatchObject({ filing_rules: rules, mcp: macMcp });
  expect(filingRulesFor(mac, "p1")).toBe(rules);
  expect(listPeople(mac).find((one) => one.id === "p2")?.filing_rules).toBe(missing);
  expect(mac.placed.people).toEqual(["p1"]);
  // The Pi's view: p2's agent runs there and p2's file is not there, refused
  // by key and line.
  const refusal = refusalOf(file, "pi");
  expect(refusal.key).toBe("people[1].filing_rules");
  // A placed file that is not readable on its own machine is refused there,
  // and only there.
  const broken = write(lines({
    p1: [`on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project", filing_rules = ${JSON.stringify(missing)} } }`],
  }));
  expect(() => loadRegistry(broken, { machine: "pi" })).not.toThrow();
  expect(refusalOf(broken, "mac").key).toBe("people[0].on.mac.filing_rules");
  // A relative placed file is refused on every view.
  const relative = write(lines({
    p1: ['on = { mac = { tree = "/Users/owner/vault-project", vault = "/Users/owner/vault-project", instructions = ["rules.md"] } }'],
  }));
  expect(refusalOf(relative, "pi").key).toBe("people[0].on.mac.instructions[0]");
  // A single-machine file is the one machine there is, so its files are
  // checked as written.
  const single = write(lines({ p2: [`filing_rules = ${JSON.stringify(missing)}`] })
    .filter((line) => !/^(\[\[machines\]\]|id = "(pi|mac)"|os = "(linux|macos)"|state_dir = "\/Users|store_url = "postgres:\/\/100|store_machine = |machine = )/.test(line))
    .filter((line) => !line.startsWith("[[run]]") || true));
  expect(refusalOf(single).key).toBe("people[1].filing_rules");
});
