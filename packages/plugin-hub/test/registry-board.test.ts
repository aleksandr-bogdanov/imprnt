// A board is a `[[run]]` entry the hub knows, bound to one specific address.
// (SPEC §6, L4, L13, RUN-05)
//
// TAILNET ONLY IS A BIND TO ONE SPECIFIC ADDRESS, and the loader cannot check
// that the address belongs to a tailnet. So the refusals are about the SHAPE of
// the naming and never about the range: no bind, an empty bind, either
// wildcard, and a bind that is a name rather than an address. Anything else
// specific is accepted, because a loader that validated a tailnet range would
// carry a behaviour constant it cannot verify and would refuse a household that
// reaches its board another way.
//
// EVERY REFUSAL IS ASSERTED BY NAME AND BY LINE, and the line is looked up in
// the rendered file rather than typed, so a fixture that moved a key does not
// turn this red for the wrong reason. And every refusal has a control beside
// it, because a loader that refused every board-shaped file would pass all ten.
//
// NOTHING IS INSTALLED OR STARTED. No Postgres, no manager call, no acting
// verb anywhere. The unit halves render through the real seams with a unit
// directory this file owns and an entry script handed in as a value.
//
// Red reason: behaviour absent. `loadRegistry` refuses `kind = "board"` with
// `unsupported-run-kind`, and `programForKind` throws the same name, so the
// first refusal below is red before `boardFor` is ever read.

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubPath, seam } from "./helpers/cluster.ts";
import { writeRegistry, type RegistrySpec, type RunSpec } from "./helpers/registry.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import { loadRegistry, RegistryRefused, type RunEntry } from "../src/registry/load.ts";
import { systemd } from "../src/os/systemd.ts";
import { launchd } from "../src/os/launchd.ts";
import { unitName } from "../src/os/names.ts";
import type { RenderContext, UnitFile } from "../src/os/types.ts";

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function ownDir(what: string): string {
  const dir = mkdtempSync(join(tmpdir(), what));
  scratch.push(dir);
  return dir;
}

/**
 * The two answers this wave adds, read through the seam rather than imported at
 * the top of the file, so an absent export fails the ONE test that reads it and
 * the refusals below are red for the behaviour they are about.
 */
async function boardOf(registry: unknown, machine: string): Promise<RunEntry | null> {
  const { boardFor } = await seam("src/registry/entries.ts");
  expect(typeof boardFor, "boardFor must be a function").toBe("function");
  return (boardFor as (r: unknown, m: string) => RunEntry | null)(registry, machine);
}

async function programOf(kind: string): Promise<string> {
  const { programForKind } = await seam("src/hub/program.ts");
  return (programForKind as (k: string) => string)(kind);
}

const MACHINES = [
  { id: "pi", os: "linux" },
  { id: "mac", os: "macos" },
];

const DOOR: RunSpec = {
  id: "door-fake",
  kind: "door",
  machine: "pi",
  platform: "fake",
  person: "p1",
  token_file: "/dev/null",
  schedule: "always",
  memory_limit_mb: 192,
};

const RUNNER: RunSpec = {
  id: "runner-pi",
  kind: "runner",
  machine: "pi",
  schedule: "always",
  memory_limit_mb: 512,
  child_memory_limit_mb: 2048,
};

const SYNC: RunSpec = {
  id: "vault-sync",
  kind: "sync",
  machine: "pi",
  schedule: "every 15m",
  memory_limit_mb: 128,
};

const HUB: RunSpec = { id: "hub-pi", kind: "hub", machine: "pi", schedule: "always", memory_limit_mb: 128 };

/** A board entry with every field the contract's own example block carries. */
const EXAMPLE_BOARD: RunSpec = {
  id: "board",
  kind: "board",
  machine: "pi",
  schedule: "always",
  memory_limit_mb: 128,
  // A documentation address. The example's value is an example, and what makes
  // a board tailnet only is that it binds to this machine's one tailnet
  // address, which no loader can verify from the file.
  bind: "100.64.0.1",
  port: 8794,
};

function specFor(run: RunSpec[]): RegistrySpec {
  return {
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: "/var/lib/imprnt-hub" },
    machines: MACHINES,
    people: [{ id: "p1", tree: "/var/lib/imprnt-hub/p1" }],
    presets: { daily: { adapter: "scripted", model: "m", provider: "p", effort: "medium", paid: "plan" } },
    agents: [{ id: "p1-lair", person: "p1", preset: "daily", chat: "0000000000", door: "door-fake", runner: "runner-pi" }],
    run,
  };
}

// A sync entry carries a repository list and the file declares what it names,
// and the fixture renders neither, so both are appended here the way every
// other check that stages a sync entry appends them.
const REPOSITORY = [
  "",
  "[[repositories]]",
  'id = "p1-vault"',
  'person = "p1"',
  'path = "/var/lib/imprnt-hub/p1/vault-project"',
  'remote = "origin"',
  'branch = "main"',
  "required = true",
  "",
].join("\n");

function write(run: RunSpec[]): { file: string; text: string } {
  const file = writeRegistry(ownDir("hub-board-registry-"), specFor(run));
  let text = readFileSync(file, "utf8");
  if (run.some((entry) => entry.kind === "sync")) {
    text = text.replace(`id = "${SYNC.id}"\n`, `id = "${SYNC.id}"\nrepositories = ["p1-vault"]\n`) + REPOSITORY;
    writeFileSync(file, text, "utf8");
  }
  return { file, text };
}

/** The 1-based line a key sits on inside the entry that carries the given id. */
function lineOf(text: string, id: string, key: string): number {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === `id = ${JSON.stringify(id)}`);
  expect(start, `the fixture must carry an entry whose id is ${id}`).toBeGreaterThanOrEqual(0);
  if (key === "id") return start + 1;
  for (let i = start + 1; i < lines.length && lines[i].trim() !== ""; i++) {
    if (new RegExp(`^\\s*${key}\\s*=`).test(lines[i])) return i + 1;
  }
  throw new Error(`the fixture must carry ${key} on the entry ${id}`);
}

function refusalOf(run: RunSpec[]): { error: RegistryRefused; text: string } {
  const { file, text } = write(run);
  let caught: unknown;
  try {
    loadRegistry(file);
  } catch (error) {
    caught = error;
  }
  expect(caught, "the loader must refuse this file").toBeInstanceOf(RegistryRefused);
  return { error: caught as RegistryRefused, text };
}

test("D-241 a board with no bind, an empty bind, either wildcard or a name is refused by key and by line", () => {
  // 1. No bind at all. The refusal lands on the entry's own id line, because a
  //    key the file never carries has no line of its own to name.
  {
    const board = { ...EXAMPLE_BOARD };
    delete (board as Record<string, unknown>).bind;
    const { error, text } = refusalOf([DOOR, RUNNER, board]);
    expect(error.key).toBe("run[2].bind");
    expect(error.line).toBe(lineOf(text, "board", "id"));
    expect(error.reason).toBe("board has no bind, and a board listens on one specific address.");
  }

  // 2. An empty string is no address, and it has a line.
  {
    const { error, text } = refusalOf([DOOR, RUNNER, { ...EXAMPLE_BOARD, bind: "" }]);
    expect(error.key).toBe("run[2].bind");
    expect(error.line).toBe(lineOf(text, "board", "bind"));
    expect(error.reason).toBe("board has no bind, and a board listens on one specific address.");
  }

  // 3 and 4. The two wildcards, each asserted on its own.
  for (const wide of ["0.0.0.0", "::"]) {
    const { error, text } = refusalOf([DOOR, RUNNER, { ...EXAMPLE_BOARD, bind: wide }]);
    expect(error.key).toBe("run[2].bind");
    expect(error.line).toBe(lineOf(text, "board", "bind"));
    expect(error.reason).toBe(
      `board binds to ${wide}, and a board listens on one specific address, never a wildcard.`,
    );
  }

  // 5. A NAME is refused where an address is not, and this is why: a name
  //    resolves at bind time to whatever the resolver says, which can be a
  //    wildcard by another route, and a file that read as one specific address
  //    would then be serving every interface the box has.
  {
    const { error, text } = refusalOf([DOOR, RUNNER, { ...EXAMPLE_BOARD, bind: "board.example" }]);
    expect(error.key).toBe("run[2].bind");
    expect(error.line).toBe(lineOf(text, "board", "bind"));
    expect(error.reason).toBe("board binds to board.example, and bind is an IP address, not a name.");
  }
});

test("D-241 a board with no port, or a port that is not a whole number in range, is refused by key and by line", () => {
  // 6. No port at all.
  {
    const board = { ...EXAMPLE_BOARD };
    delete (board as Record<string, unknown>).port;
    const { error, text } = refusalOf([DOOR, RUNNER, board]);
    expect(error.key).toBe("run[2].port");
    expect(error.line).toBe(lineOf(text, "board", "id"));
    expect(error.reason).toBe(
      "board has port undefined, and a board's port is a whole number from 1 to 65535.",
    );
  }

  // 7 to 10, one assertion per value and never as a group, so a build that
  // caught three of the four still fails on the fourth.
  for (const port of [0, -1, 1.5, "8794"] as const) {
    const { error, text } = refusalOf([
      DOOR,
      RUNNER,
      { ...EXAMPLE_BOARD, port: port as unknown as number },
    ]);
    expect(error.key).toBe("run[2].port");
    expect(error.line).toBe(lineOf(text, "board", "port"));
    expect(error.reason).toBe(
      `board has port ${port}, and a board's port is a whole number from 1 to 65535.`,
    );
  }
});

test("a board's artifacts port is its own port and no other, refused by key and by line", () => {
  // What it buys: an agent writes what is served there, so a page an agent
  // wrote must not arrive on the origin the acts are on. Sharing the board's
  // own port would be exactly that, and it is refused beside the shapes that
  // are not a port at all.
  for (const value of [0, -1, 1.5, "8795", 65536, EXAMPLE_BOARD.port] as const) {
    const { error, text } = refusalOf([
      DOOR,
      RUNNER,
      { ...EXAMPLE_BOARD, artifacts_port: value as unknown as number },
    ]);
    expect(error.key).toBe("run[2].artifacts_port");
    expect(error.line).toBe(lineOf(text, "board", "artifacts_port"));
    expect(error.reason).toBe(
      `board has artifacts_port ${value}, and it is a whole number from 1 to 65535 that is not the board's own port.`,
    );
  }

  // The controls: a port of its own loads onto the entry, and a board that
  // names none carries no such key at all, which is the board that serves no
  // artifact.
  const { file } = write([DOOR, RUNNER, { ...EXAMPLE_BOARD, artifacts_port: 8795 }]);
  const board = listRunEntries(loadRegistry(file)).find((one) => one.id === "board")!;
  expect((board as { artifacts_port?: number }).artifacts_port).toBe(8795);
  const silent = write([DOOR, RUNNER, EXAMPLE_BOARD]);
  const quiet = listRunEntries(loadRegistry(silent.file)).find((one) => one.id === "board")!;
  expect(Object.hasOwn(quiet, "artifacts_port")).toBe(false);
});

test("D-244 whether the hub keeps an entry running is asked of every kind, by key and by line", () => {
  // The field is not a board's. It is the one place a household says it does
  // not want a piece up, and the hub re-reads the file on every tick, so it is
  // asked of every entry and refused by name where it is there and wrong.
  for (const entry of [DOOR, RUNNER, HUB, EXAMPLE_BOARD]) {
    const nth = [DOOR, RUNNER, HUB, EXAMPLE_BOARD].indexOf(entry);
    const { error, text } = refusalOf(
      [DOOR, RUNNER, HUB, EXAMPLE_BOARD].map((one, i) =>
        i === nth ? { ...one, enabled: "no" as unknown as boolean } : one,
      ),
    );
    expect(error.key).toBe(`run[${nth}].enabled`);
    expect(error.line).toBe(lineOf(text, entry.id, "enabled"));
    expect(error.reason).toBe(
      `${entry.id} has enabled no, and whether the hub keeps it running is a true or a false.`,
    );
  }
  // The control: both booleans load, and the field reaches the entry only when
  // the file carries it.
  for (const enabled of [true, false]) {
    const { file } = write([{ ...RUNNER, enabled }, DOOR, HUB]);
    const row = listRunEntries(loadRegistry(file)).find((one) => one.id === RUNNER.id)!;
    expect(row.enabled).toBe(enabled);
  }
  const { file } = write([RUNNER, DOOR, HUB]);
  expect(Object.hasOwn(listRunEntries(loadRegistry(file)).find((one) => one.id === RUNNER.id)!, "enabled")).toBe(
    false,
  );
});

test("D-244 an entry that says nothing about enabled is enabled", async () => {
  const { enabledOf } = await seam("src/registry/entries.ts");
  expect(typeof enabledOf, "enabledOf must be a function").toBe("function");
  const asked = enabledOf as (entry: { enabled?: boolean }) => boolean;
  const { file } = write([{ ...RUNNER, enabled: false }, { ...DOOR, enabled: true }, HUB]);
  const rows = listRunEntries(loadRegistry(file));
  // A file written before the field existed says what it always said.
  expect(asked(rows.find((one) => one.id === HUB.id)!)).toBe(true);
  expect(asked(rows.find((one) => one.id === DOOR.id)!)).toBe(true);
  expect(asked(rows.find((one) => one.id === RUNNER.id)!)).toBe(false);
});

test("D-241 the example block loads whole and boardFor answers the machine that has one", async () => {
  // The control on the ten refusals. A build that refused every board-shaped
  // file passes all of them and fails here.
  const { file } = write([DOOR, RUNNER, SYNC, HUB, EXAMPLE_BOARD]);
  const registry = loadRegistry(file);

  const board = await boardOf(registry, "pi");
  expect(board).toEqual({
    id: "board",
    kind: "board",
    machine: "pi",
    schedule: "always",
    memory_limit_mb: 128,
    bind: "100.64.0.1",
    port: 8794,
  } as RunEntry);

  // A machine with no board entry has none, and that is an answer rather than
  // a missing one.
  expect(await boardOf(registry, "mac")).toBeNull();
});

test("D-241 every other specific address is accepted, because the range is not the loader's to know", async () => {
  // Documentation addresses, on purpose: what the loader accepts is any
  // specific address, and naming a real range here would read as a rule.
  for (const bind of ["127.0.0.1", "10.0.0.5", "2001:db8::1", "::1"]) {
    const { file } = write([DOOR, RUNNER, { ...EXAMPLE_BOARD, bind }]);
    const board = await boardOf(loadRegistry(file), "pi");
    expect(board?.bind, `${bind} must load`).toBe(bind);
  }
});

test("D-241 a board is an ordinary entry, so the shipped memory refusal reaches it and a stray bind elsewhere is ignored", async () => {
  // (c) L4's "a long-running piece with no measured peak is forbidden" reaches
  //     the board for free, through the refusal every entry already meets.
  // The fixture fills a memory limit in for every entry it renders, so the line
  // is taken back out of the file by hand rather than left out of the spec.
  const staged = write([DOOR, RUNNER, EXAMPLE_BOARD]);
  writeFileSync(
    staged.file,
    staged.text
      .split("\n")
      .filter((line, i) => i + 1 !== lineOf(staged.text, "board", "memory_limit_mb"))
      .join("\n"),
    "utf8",
  );
  let caught: unknown;
  try {
    loadRegistry(staged.file);
  } catch (error) {
    caught = error;
  }
  expect(caught, "a board with no memory limit must be refused").toBeInstanceOf(RegistryRefused);
  expect((caught as RegistryRefused).key).toBe("run[2].memory_limit_mb");
  expect((caught as RegistryRefused).reason).toContain("memory_limit_mb");

  // (d) The loader has always tolerated a key it has no rule about, and `bind`
  //     and `port` on a non-board entry are two more of those. The rows for the
  //     shipped kinds carry exactly the keys they carry today.
  const { file } = write([
    { ...DOOR, bind: "0.0.0.0", port: 1 },
    RUNNER,
    SYNC,
    HUB,
  ]);
  const rows = listRunEntries(loadRegistry(file));
  expect(rows.find((one) => one.id === "door-fake")).toEqual({
    id: "door-fake",
    kind: "door",
    machine: "pi",
    schedule: "always",
    memory_limit_mb: 192,
    token_file: "/dev/null",
  } as RunEntry);
  expect(rows.find((one) => one.id === "runner-pi")).toEqual({
    id: "runner-pi",
    kind: "runner",
    machine: "pi",
    schedule: "always",
    memory_limit_mb: 512,
    child_memory_limit_mb: 2048,
  } as RunEntry);
  expect(rows.find((one) => one.id === "hub-pi")).toEqual({
    id: "hub-pi",
    kind: "hub",
    machine: "pi",
    schedule: "always",
    memory_limit_mb: 128,
  } as RunEntry);

  // (e) A file with no board entry at all loads, and nothing about any shipped
  //     entry changes.
  const plain = write([DOOR, RUNNER, SYNC, HUB]);
  const registry = loadRegistry(plain.file);
  for (const machine of ["pi", "mac"]) expect(await boardOf(registry, machine)).toBeNull();
  expect(listRunEntries(registry).map((one) => one.id)).toEqual([
    "door-fake",
    "runner-pi",
    "vault-sync",
    "hub-pi",
  ]);
});

test("D-241 the board's program is src/entry/board.ts and the shipped four are unmoved", async () => {
  expect(await programOf("board")).toBe(hubPath("src/entry/board.ts"));
  // ITS EXISTENCE IS NOT ASSERTED HERE. The file arrives in the wave that owns
  // the process, all four waves land on one branch, and the check that owns
  // the process is where `existsSync` belongs.
  for (const kind of ["hub", "door", "runner", "sync"]) {
    expect(await programOf(kind)).toBe(hubPath(`src/entry/${kind}.ts`));
  }
  await expect(programOf("watcher")).rejects.toThrow(/unsupported-run-kind/);
});

/** The render seam, pointed at a directory this file owns, with no manager. */
function seamFor(flavour: "systemd" | "launchd") {
  const unitDir = ownDir(`hub-board-units-${flavour}-`);
  const os = flavour === "systemd" ? systemd({ unitDir }) : launchd({ unitDir });
  return { os, unitDir };
}

function contextFor(script: string): RenderContext {
  return {
    machine: "pi",
    stateDir: "/var/lib/imprnt-hub",
    execPath: process.execPath,
    entryScript: script,
    registryFile: "/var/lib/imprnt-hub/registry.toml",
    restartDelaySeconds: 1,
    giveUpAfter: 5,
    giveUpWindowSeconds: 300,
  };
}

/** The `Key=value` pairs of a systemd unit, section headers kept as markers. */
function sections(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
}

test("D-241 the systemd unit is the ordinary resident render, and it is ONE file", () => {
  const { file } = write([DOOR, RUNNER, EXAMPLE_BOARD]);
  const entry = listRunEntries(loadRegistry(file)).find((one) => one.id === "board")!;
  const { os, unitDir } = seamFor("systemd");
  const script = hubPath("src/entry/board.ts");
  const files: UnitFile[] = os.render(entry, contextFor(script));

  // No timer, no socket, no second unit, said by count and again by name.
  expect(files).toHaveLength(1);
  expect(files.map((one) => one.path)).toEqual([join(unitDir, "imprnt-hub-board.service")]);

  const lines = sections(files[0].text);
  expect(lines).toContain("[Service]");
  expect(lines).toContain("Restart=always");
  expect(lines).toContain("MemoryMax=128M");
  expect(lines).toContain("[Install]");
  expect(lines).toContain("WantedBy=default.target");
  expect(lines).toContain("StandardOutput=journal");
  expect(lines.filter((one) => one.startsWith("Environment="))).not.toHaveLength(0);
  const exec = lines.find((one) => one.startsWith("ExecStart="))!;
  expect(exec.slice("ExecStart=".length).split(" ")).toEqual([
    process.execPath,
    "run",
    script,
    "/var/lib/imprnt-hub/registry.toml",
    "board",
  ]);
});

test("D-241 the launchd plist is the ordinary resident plist and enforces no memory limit at all", () => {
  const { file } = write([DOOR, RUNNER, EXAMPLE_BOARD]);
  const entry = listRunEntries(loadRegistry(file)).find((one) => one.id === "board")!;
  const { os } = seamFor("launchd");
  const files = os.render(entry, contextFor(hubPath("src/entry/board.ts")));
  expect(files).toHaveLength(1);
  const text = files[0].text;
  expect(text).toContain("<key>Label</key>");
  expect(text).toContain("<string>imprnt-hub-board</string>");
  expect(text).toContain("<key>RunAtLoad</key>");
  expect(text.split("<key>RunAtLoad</key>")[1].trimStart().startsWith("<true/>")).toBe(true);
  expect(text).toContain("<key>KeepAlive</key>");
  expect(text).toContain("/var/lib/imprnt-hub/service-log/board.out.log");
  expect(text).toContain("/var/lib/imprnt-hub/service-log/board.err.log");
  // LAUNCHD ENFORCES NOTHING HERE, and the honest thing is to say so rather
  // than render a key that reads as a limit. `memory_limit_mb` is what the hub
  // records a peak against and what `check` compares a reading to. The plist
  // is not a second place that number lives.
  expect(text).not.toContain("Memory");
  expect(text).not.toContain("128");
});

test("D-241 the rendered name can never be the live v2's", () => {
  expect(unitName("board")).toBe("imprnt-hub-board");
  expect(unitName("board")).not.toBe("imprnt-board");
});

test("D-241 the four shipped kinds render byte-identically beside a board entry", () => {
  const without = write([DOOR, RUNNER, SYNC, HUB]);
  const with_ = write([DOOR, RUNNER, SYNC, HUB, EXAMPLE_BOARD]);
  for (const flavour of ["systemd", "launchd"] as const) {
    const { os } = seamFor(flavour);
    const ctx = contextFor(hubPath("src/entry/hub.ts"));
    const before = listRunEntries(loadRegistry(without.file));
    const after = listRunEntries(loadRegistry(with_.file));
    for (const id of ["door-fake", "runner-pi", "vault-sync", "hub-pi"]) {
      const one = before.find((entry) => entry.id === id)!;
      const two = after.find((entry) => entry.id === id)!;
      const a = os.render(one, ctx).map((unit) => unit.text);
      const b = os.render(two, ctx).map((unit) => unit.text);
      expect(b, `${flavour} ${id} must render byte-identically`).toEqual(a);
    }
  }
});

test("D-241 a file naming a board with every field set loads with no refusal at all", async () => {
  // The control on the controls, written out so a build that refused any
  // board-shaped file fails one assertion that is only about acceptance.
  const dir = ownDir("hub-board-verbatim-");
  const file = join(dir, "registry.toml");
  writeFileSync(
    file,
    [
      "[hub]",
      "tick_seconds = 5",
      'store_url = "postgres://127.0.0.1:5432/hub"',
      'state_dir = "/var/lib/imprnt-hub"',
      "tail_hours = 24",
      "tail_tokens = 8000",
      "claim_lease_seconds = 300",
      "",
      "[[machines]]",
      'id = "pi"',
      'os = "linux"',
      "",
      "[[run]]",
      'id = "board"',
      'kind = "board"',
      'machine = "pi"',
      'schedule = "always"',
      "memory_limit_mb = 128",
      'bind = "100.64.0.1"',
      "port = 8794",
      "enabled = true",
      "",
    ].join("\n"),
    "utf8",
  );
  const entry = (await boardOf(loadRegistry(file), "pi"))!;
  expect(entry.id).toBe("board");
  expect(entry.kind).toBe("board");
  expect(entry.machine).toBe("pi");
  expect(entry.schedule).toBe("always");
  expect(entry.memory_limit_mb).toBe(128);
  expect(entry.bind).toBe("100.64.0.1");
  expect(entry.port).toBe(8794);
  expect(entry.enabled).toBe(true);
});
