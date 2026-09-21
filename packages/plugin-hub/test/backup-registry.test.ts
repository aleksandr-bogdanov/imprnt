// The off-box copy is declared like every other scheduled piece, and its three
// commands are validated the way the one command that already carries admin
// authority is.
//
// SPEC §6: the registry is the list, and the backup is on it with its schedule
// and its memory limit. SPEC §1: a plain-text dump every hour, with the off-site
// destination a setting and no provider named in code. L13: a scheduled job's
// staleness comes from its own "I ran and it landed" stamp. L4: a piece with no
// measured memory limit is forbidden.
//
// PURE FOR THE LOADER, AND THE SHIPPED RENDERERS FOR THE REST. No store, no
// manager, no unit installed: the renderers are called the way
// `test/os-render.test.ts` calls them, so both flavours are asserted on both
// machines.
//
// THE DESTINATION IS NOT PARSED, and that is asserted rather than promised: a
// URL, a host and a path, a plain path and a string with spaces in it all load
// and read back unchanged. The destination is a value the argvs receive and the
// code never interprets, so a loader that validated its shape would be naming a
// provider, which is the one thing this entry exists not to do.
//
// Red reason: behaviour absent. The loader refuses `kind = "backup"` outright
// with `unsupported-run-kind`, so the everything-declared control is red first
// and every refusal below names the wrong key behind it, and `programForKind`
// throws for the kind.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubPath, seam } from "./helpers/cluster.ts";
import { parsePlistDict } from "./helpers/plist.ts";
import { writeRegistry, type RegistrySpec, type RunSpec } from "./helpers/registry.ts";
import { thisMachine } from "./helpers/os-gate.ts";

const ARGVS = ["dump_argv", "upload_argv", "readback_argv"] as const;
const ID = "backup-copy";
const MEMORY_MB = 321;
const GRACE = 411;

const GOOD: Record<(typeof ARGVS)[number], string[]> = {
  // The shape the contract names for the hub box: the store's own account
  // dumps it, and `pg_dump` is a command name sudo resolves, not a path.
  dump_argv: ["/usr/bin/sudo", "-n", "-u", "postgres", "pg_dump", "--dbname", "hub"],
  upload_argv: ["/opt/example/bin/copy-tool", "--recursive", "{staging}/", "{destination}"],
  readback_argv: ["/opt/example/bin/copy-tool", "{destination}/{path}", "{out}"],
};

const scratch: string[] = [];
afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function backupSpec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    id: ID,
    kind: "backup",
    machine: thisMachine().id,
    schedule: "hourly",
    memory_limit_mb: MEMORY_MB,
    destination: "/copies/household",
    ...GOOD,
    ...over,
  };
}

function household(run: RunSpec, machines = [thisMachine()]): RegistrySpec {
  const dir = mkdtempSync(join(tmpdir(), "hub-backup-registry-"));
  scratch.push(dir);
  return {
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: dir, job_grace_seconds: GRACE },
    machines,
    people: [{ id: "p1", tree: join(dir, "p1") }],
    presets: {},
    agents: [],
    run: [run],
  };
}

function write(spec: RegistrySpec): string {
  return writeRegistry(String(spec.hub!.state_dir), spec);
}

/** The good file with one key's line of the backup entry replaced, or dropped when `raw` is null. */
function withLine(key: string, raw: string | null, run: RunSpec = backupSpec()): string {
  const file = write(household(run));
  const lines = readFileSync(file, "utf8").split("\n");
  const at = lines.findIndex((line) => line.startsWith(`${key} =`));
  if (at < 0) throw new Error(`the fixture has no ${key} line to replace`);
  if (raw === null) lines.splice(at, 1);
  else lines[at] = `${key} = ${raw}`;
  writeFileSync(file, lines.join("\n"), "utf8");
  return file;
}

async function loader() {
  const { loadRegistry, RegistryRefused } = await seam("src/registry/load.ts");
  const { listRunEntries } = await seam("src/registry/entries.ts");
  return {
    load: loadRegistry as (file: string) => unknown,
    Refused: RegistryRefused as new (...args: unknown[]) => Error,
    entries: listRunEntries as (registry: unknown) => Record<string, unknown>[],
  };
}

/** The refusal a file earns, or a throw saying it loaded. */
async function refusalOf(file: string): Promise<{ key: string; reason: string; message: string }> {
  const { load, Refused } = await loader();
  try {
    load(file);
  } catch (error) {
    expect(error).toBeInstanceOf(Refused);
    const it = error as { key: string; reason: string; message: string };
    return { key: it.key, reason: it.reason, message: it.message };
  }
  throw new Error(`${file} loaded, and a refusal was expected`);
}

async function backupOf(file: string): Promise<Record<string, unknown>> {
  const { load, entries } = await loader();
  const found = entries(load(file)).find((one) => one.id === ID);
  if (!found) throw new Error(`${ID} is not among the loaded entries`);
  return found;
}

// --- the declaration --------------------------------------------------------

test("ROLL-32 a backup entry with three argvs, a destination, a schedule and a memory limit loads and reads back by value", async () => {
  const entry = await backupOf(write(household(backupSpec())));
  expect(entry.kind).toBe("backup");
  expect(entry.schedule).toBe("hourly");
  expect(entry.memory_limit_mb).toBe(MEMORY_MB);
  expect(entry.machine).toBe(thisMachine().id);
  expect(entry.destination).toBe("/copies/household");
  for (const key of ARGVS) expect(entry[key]).toEqual(GOOD[key]);
});

for (const key of ARGVS) {
  test(`ROLL-32 a backup entry with no ${key} refuses naming ${key}`, async () => {
    const refused = await refusalOf(withLine(key, null));
    expect(refused.key).toBe(`run[0].${key}`);
    expect(refused.reason).toContain(key);
  });
}

// The four shapes `install.admin_argv` refuses, asked of each argv on its own.
const BAD_SHAPES: [string, string][] = [
  ["an empty list", "[]"],
  ["a list carrying an empty string", '["/opt/example/bin/copy-tool", ""]'],
  ["a list carrying a non-string", '["/opt/example/bin/copy-tool", 1]'],
  ["a list carrying a password literal", '["/opt/example/bin/copy-tool", "postgres://p1:synthetic-secret@localhost/hub"]'],
];
for (const key of ARGVS) {
  for (const [shape, raw] of BAD_SHAPES) {
    test(`ROLL-32 ${key} as ${shape} refuses naming ${key}`, async () => {
      const refused = await refusalOf(withLine(key, raw));
      expect(refused.key).toBe(`run[0].${key}`);
      expect(refused.reason).toContain(`run[0].${key}`);
    });
  }
}

test("ROLL-32 a password handed in through the environment is a password literal too, in every argv", async () => {
  for (const key of ARGVS) {
    const refused = await refusalOf(withLine(key, '["/usr/bin/env", "PGPASSWORD=synthetic-secret", "/opt/example/bin/copy-tool"]'));
    expect(refused.key).toBe(`run[0].${key}`);
    expect(refused.reason).toContain("password");
  }
});

for (const key of ARGVS) {
  test(`ROLL-32 a relative path in ${key} refuses naming ${key}, as the program and as an argument`, async () => {
    // A relative path is a different file in every directory a process starts in.
    for (const raw of ['["./copy-tool", "{destination}"]', '["/opt/example/bin/copy-tool", "../elsewhere"]', '["bin/copy-tool"]']) {
      const refused = await refusalOf(withLine(key, raw));
      expect(refused.key).toBe(`run[0].${key}`);
      expect(refused.reason).toContain("relative");
    }
  });
}

for (const key of ARGVS) {
  test(`ROLL-32 an unknown placeholder in ${key} refuses and the sentence lists the four`, async () => {
    const refused = await refusalOf(withLine(key, '["/opt/example/bin/copy-tool", "{nonsense}"]'));
    expect(refused.key).toBe(`run[0].${key}`);
    for (const known of ["{staging}", "{destination}", "{path}", "{out}"]) expect(refused.reason).toContain(known);
    // A typo in a known one is unknown too, so it is never passed through as a literal.
    const typo = await refusalOf(withLine(key, '["/opt/example/bin/copy-tool", "{Destination}"]'));
    expect(typo.key).toBe(`run[0].${key}`);
  });
}

test("ROLL-32 a brace that is not a placeholder, such as a filter's alternation, is an ordinary argument", async () => {
  const entry = await backupOf(write(household(backupSpec({
    upload_argv: ["/opt/example/bin/copy-tool", "--include", "*.{md,json}", "{staging}/", "{destination}"],
  }))));
  expect(entry.upload_argv).toEqual(["/opt/example/bin/copy-tool", "--include", "*.{md,json}", "{staging}/", "{destination}"]);
});

test("ROLL-32 a read-back that names {staging} refuses, because it would read the copy on this box and always match", async () => {
  const refused = await refusalOf(withLine("readback_argv", '["/bin/cp", "{staging}/{path}", "{out}"]'));
  expect(refused.key).toBe("run[0].readback_argv");
  expect(refused.reason).toContain("{staging}");
  // The control: the same command reading the destination loads.
  expect((await backupOf(withLine("readback_argv", '["/bin/cp", "{destination}/{path}", "{out}"]'))).readback_argv)
    .toEqual(["/bin/cp", "{destination}/{path}", "{out}"]);
});

test("ROLL-32 {path} and {out} name the one file being read back, so the dump and the upload refuse them", async () => {
  for (const key of ["dump_argv", "upload_argv"] as const) {
    for (const token of ["{path}", "{out}"]) {
      const refused = await refusalOf(withLine(key, `["/opt/example/bin/copy-tool", "${token}"]`));
      expect(refused.key).toBe(`run[0].${key}`);
      expect(refused.reason).toContain(token);
    }
  }
});

test("ROLL-32 a backup entry with no destination refuses naming run[n].destination, and an empty or non-string one does too", async () => {
  for (const raw of [null, '""', "1", "[]"]) {
    const refused = await refusalOf(withLine("destination", raw));
    expect(refused.key).toBe("run[0].destination");
  }
});

test("ROLL-32 the destination is NOT parsed: a URL, a host and a path, a plain path and a string with spaces all load unchanged", async () => {
  // The destination is a value the argvs receive and the code never
  // interprets. A loader that checked its shape would be naming a provider.
  for (const destination of [
    "copies://example.invalid/household",
    "mac:/copies/household",
    "/copies/household",
    "/copies/the household; $HOME and all",
  ]) {
    expect((await backupOf(write(household(backupSpec({ destination }))))).destination).toBe(destination);
  }
});

test("ROLL-32 the shipped memory-limit and machine refusals reach the new kind with no rule of its own", async () => {
  const memory = await refusalOf(withLine("memory_limit_mb", null));
  expect(memory.key).toBe("run[0].memory_limit_mb");
  expect(memory.reason).toBe(`${ID} has no memory_limit_mb, and every piece the hub runs carries one`);

  const two = household(backupSpec({ machine: undefined }), [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }]);
  const machine = await refusalOf(write(two));
  expect(machine.key).toBe("run[0].machine");
  expect(machine.reason).toBe(`${ID} says no machine, and this file declares 2, so nothing would ever run it`);
});

test("ROLL-32 a backup runs on a cadence: hourly and every 30m load as scheduled, always and on demand refuse naming run[n].schedule", async () => {
  const { wantedState } = await seam("src/os/diff.ts");
  for (const schedule of ["hourly", "every 30m"]) {
    const entry = await backupOf(write(household(backupSpec({ schedule }))));
    expect(entry.schedule).toBe(schedule);
    expect((wantedState as (entry: unknown) => string)(entry)).toBe("scheduled");
  }
  // A copy that never stops is not a copy, and one nobody starts is not hourly.
  for (const schedule of ["always", "on demand"]) {
    const refused = await refusalOf(write(household(backupSpec({ schedule }))));
    expect(refused.key).toBe("run[0].schedule");
    expect(refused.reason).toContain(schedule);
  }
});

// --- the render -------------------------------------------------------------

/** A systemd unit as sections of `Key=Value`, so a value is read and never searched for. */
function sections(text: string): Map<string, [string, string][]> {
  const out = new Map<string, [string, string][]>();
  let current = "";
  for (const line of text.split("\n")) {
    if (line.trim() === "" || line.startsWith("#")) continue;
    const header = /^\[([A-Za-z]+)\]$/.exec(line.trim());
    if (header) {
      current = header[1];
      out.set(current, out.get(current) ?? []);
      continue;
    }
    const cut = line.indexOf("=");
    if (cut <= 0 || current === "") throw new Error(`not a unit line: ${line}`);
    out.get(current)!.push([line.slice(0, cut), line.slice(cut + 1)]);
  }
  return out;
}

function values(unit: Map<string, [string, string][]>, key: string): string[] {
  return [...unit.values()].flat().filter(([name]) => name === key).map(([, value]) => value.trim());
}

async function rendering() {
  const { programForKind } = await seam("src/hub/program.ts");
  const { systemd } = await seam("src/os/systemd.ts");
  const { launchd } = await seam("src/os/launchd.ts");
  const file = write(household(backupSpec()));
  const entry = await backupOf(file);
  const unitDir = join(tmpdir(), "hub-backup-render-units");
  const ctx = {
    machine: thisMachine().id,
    execPath: process.execPath,
    entryScript: (programForKind as (kind: string) => string)("backup"),
    registryFile: file,
    restartDelaySeconds: 3,
    giveUpAfter: 7,
    giveUpWindowSeconds: 411,
  };
  type Renderer = { render(entry: unknown, ctx: unknown): { path: string; text: string }[] };
  return {
    programForKind: programForKind as (kind: string) => string,
    entry,
    ctx,
    linux: (systemd as (o: unknown) => Renderer)({ unitDir }),
    mac: (launchd as (o: unknown) => Renderer)({ unitDir }),
  };
}

test("ROLL-32 programForKind(backup) is a bun entry under src/entry/, and every shipped kind still answers what it did", async () => {
  const { programForKind, entry, ctx, linux } = await rendering();
  const script = programForKind("backup");
  expect(script).toBe(hubPath("src/entry/backup.ts"));
  expect(existsSync(script)).toBe(true);
  // The bun-run shape every other entry has, read off the rendered unit.
  const service = linux.render(entry, ctx).find((one) => one.path.endsWith(".service"))!;
  expect(values(sections(service.text), "ExecStart")).toHaveLength(1);
  expect(values(sections(service.text), "ExecStart")[0].split(" ").map((one) => one.replace(/^"|"$/g, "")))
    .toEqual([process.execPath, "run", script, ctx.registryFile, ID]);
  // The control: the switch was widened, not replaced.
  for (const kind of ["hub", "door", "runner", "sync", "board"]) expect(programForKind(kind)).toBe(hubPath(`src/entry/${kind}.ts`));
  expect(programForKind("transcriber")).toBe(hubPath("tools/transcribe-server.py"));
  for (const kind of ["watcher", "arbitrary-kind"]) expect(() => programForKind(kind)).toThrow(/unsupported-run-kind/);
});

test("ROLL-32 Linux renders a service at the entry's own memory limit with no Restart=always, and a timer at the schedule's seconds", async () => {
  const { entry, ctx, linux } = await rendering();
  const files = linux.render(entry, ctx);
  expect(files).toHaveLength(2);
  const service = sections(files.find((one) => one.path.endsWith(".service"))!.text);
  const timer = sections(files.find((one) => one.path.endsWith(".timer"))!.text);
  expect(values(service, "MemoryMax")).toEqual([`${MEMORY_MB}M`]);
  expect(values(service, "Restart")).not.toContain("always");
  expect(values(timer, "OnUnitActiveSec")).toEqual(["3600"]);
  expect(values(timer, "OnActiveSec")).toEqual(["3600"]);
});

test("ROLL-32 macOS renders a StartInterval at the schedule's seconds and no KeepAlive", async () => {
  const { entry, ctx, mac } = await rendering();
  const files = mac.render(entry, ctx);
  expect(files).toHaveLength(1);
  const plist = parsePlistDict(files[0].text);
  expect(plist.StartInterval).toBe(3600);
  expect(plist.KeepAlive ?? false).toBe(false);
});

// --- freshness is the shipped arithmetic -----------------------------------

test("ROLL-32 the shipped staleJobs reports job-no-stamp, then job-stale keyed on the entry, then nothing, with the dispatch producer alive beside it", async () => {
  const { staleJobs } = await seam("src/check/schedule.ts");
  const { staleDispatchJobs } = await seam("src/check/jobs.ts");
  const { load, entries } = await loader();
  const registry = load(write(household(backupSpec())));
  const backup = entries(registry).filter((one) => one.id === ID);
  expect(backup).toHaveLength(1);
  const machine = thisMachine().id;
  const now = new Date("2026-09-21T12:00:00.000Z");
  const stale = staleJobs as (args: unknown) => { id: string; kind: string; subject: string }[];
  const at = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString();

  const never = stale({ entries: backup, stamps: [], graceSeconds: GRACE, now });
  expect(never.map((one) => one.id)).toEqual([`${machine}/job-no-stamp:${ID}`]);

  const late = stale({ entries: backup, stamps: [{ id: ID, data: { at: at(3600 + GRACE + 1), machine } }], graceSeconds: GRACE, now });
  expect(late.map((one) => [one.id, one.kind, one.subject])).toEqual([[`${machine}/job-stale:${ID}`, "job-stale", ID]]);

  // One second inside the interval plus the grace is not late, which is what
  // says the grace is the one read from the file.
  expect(stale({ entries: backup, stamps: [{ id: ID, data: { at: at(3600 + GRACE - 1), machine } }], graceSeconds: GRACE, now })).toEqual([]);

  // The other producer of the same word, keyed on a job ROW, alive in the same run.
  const job = "job:fake:1000000001:7";
  const dispatch = (staleDispatchJobs as (args: unknown) => { id: string; subject: string }[])({
    jobs: [{ id: job, agent: "p1-research", person: "p1", received_at: new Date(now.getTime() - 10_000_000) }],
    thresholds: () => ({ acked_seconds: 30, started_seconds: 60, answered_seconds: 900, delivered_seconds: 60 }),
    runnerOf: () => "runner-pi",
    graceSeconds: GRACE,
    machine,
    now,
  });
  expect(dispatch.map((one) => one.id)).toEqual([`${machine}/job-stale:${job}`]);
  expect(dispatch[0].id).not.toBe(late[0].id);
});
