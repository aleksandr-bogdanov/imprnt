// A value that does not parse refuses the file and names the line.
//
// SPEC §6: "a file with a bad value is refused loudly." L14's Forbidden list, as
// added 2026-09-14: "A value that does not parse being defaulted quietly: the
// file is refused and the line named." The ruling: "yes, agreed. Every error
// must be very loud. Hundred percent."
//
// Behind the rule: in v2 a garbage staleness value turned the check that detects
// a dead vault sync into silence, and nobody noticed for 35 hours.
//
// "Names the line" is the behaviour, so every check here asserts the exact line
// number. A check that only asserts something was thrown cannot fail when the
// line number is wrong.

import { test, expect } from "bun:test";
import { seam } from "./helpers/cluster.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

async function scratch(lines: string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hub-registry-"));
  const file = join(dir, "registry.toml");
  await Bun.write(file, lines.join("\n") + "\n");
  return file;
}

/** One-based line number of the first line containing the needle. */
function lineOf(lines: string[], needle: string): number {
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) throw new Error(`the fixture does not contain ${needle}`);
  return index + 1;
}

const GOOD_VALUE = "memory_limit_mb = 256";
const BAD_VALUE = 'memory_limit_mb = "as much as it likes"';

function fixture(valueLine: string): string[] {
  return [
    "# the hub's registry",
    "",
    "[hub]",
    "tick_seconds = 5",
    "",
    "[[run]]",
    'id = "door-telegram"',
    'kind = "door"',
    'schedule = "always"',
    "memory_limit_mb = 192",
    "",
    "[[run]]",
    'id = "runner-pi"',
    'kind = "runner"',
    'schedule = "always"',
    valueLine,
    // A runner entry carries the CHILD's limit in
    // every file, whether or not the file declares its machines. Added as a
    // fixture line, not an assertion: the bad value above is still the line
    // this check names, and it is still the last line whose number it asserts.
    "child_memory_limit_mb = 512",
  ];
}

test("RUN-08 a file with a bad value is refused loudly: the whole file is refused and the refusal names the exact line (SPEC §6, L14)", async () => {
  const { loadRegistry, RegistryRefused } = await seam("src/registry/load.ts");
  expect(typeof loadRegistry).toBe("function");

  const lines = fixture(BAD_VALUE);
  const badLine = lineOf(lines, "as much as it likes");
  const file = await scratch(lines);

  let refusal: unknown;
  try {
    (loadRegistry as Function)(file);
  } catch (err) {
    refusal = err;
  }

  expect(refusal).toBeInstanceOf(RegistryRefused as Function);
  expect((refusal as { line: number }).line).toBe(badLine);
  expect((refusal as { key: string }).key).toContain("memory_limit_mb");
  expect((refusal as { file: string }).file).toBe(file);

  // Loudly means a human reading the terminal sees the line, not only a
  // structured field an agent could read.
  expect(String((refusal as Error).message)).toContain(String(badLine));

  await rm(dirname(file), { recursive: true, force: true });
});

test("RUN-08 no quiet default: the loader throws RegistryRefused rather than returning nothing, and no part of the file is reachable afterwards (SPEC §6 Forbidden, L14)", async () => {
  const { loadRegistry, RegistryRefused, readSetting } = await seam(
    "src/registry/load.ts",
  );
  expect(typeof loadRegistry).toBe("function");

  const file = await scratch(fixture(BAD_VALUE));

  // A loader that quietly returns undefined would satisfy "did not give me a
  // registry" while giving the caller nothing to log and no line to fix. The
  // rule is that the error is loud, so the throw itself is the assertion.
  let threw = false;
  let refusal: unknown;
  let returned: unknown = "the loader returned instead of throwing";
  try {
    returned = (loadRegistry as Function)(file);
  } catch (err) {
    threw = true;
    refusal = err;
  }

  expect(threw).toBe(true);
  expect(refusal).toBeInstanceOf(RegistryRefused as Function);
  expect(returned).toBe("the loader returned instead of throwing");

  // And nothing partial is reachable. The good entry earlier in the same file
  // is not readable either, because the file is refused as a whole. A loader
  // that hands back the parts it liked is the quiet default the rule forbids.
  const salvage = (refusal as { registry?: unknown; partial?: unknown; value?: unknown })
    ?? {};
  expect(salvage.registry).toBeUndefined();
  expect(salvage.partial).toBeUndefined();

  let readThrew = false;
  try {
    (readSetting as Function)(returned, "hub.tick_seconds");
  } catch {
    readThrew = true;
  }
  expect(readThrew).toBe(true);

  await rm(dirname(file), { recursive: true, force: true });
});

test("RUN-08 the control: the same file with the value corrected loads and the value reads back (SPEC §6, L14)", async () => {
  const { loadRegistry, readSetting } = await seam("src/registry/load.ts");
  const { listRunEntries } = await seam("src/registry/entries.ts");
  expect(typeof loadRegistry).toBe("function");

  const file = await scratch(fixture(GOOD_VALUE));
  const registry = (loadRegistry as Function)(file);

  expect((readSetting as Function)(registry, "hub.tick_seconds")).toBe(5);

  const entries = (await (listRunEntries as Function)(registry)) as {
    id: string;
    memory_limit_mb: number;
  }[];
  const runner = entries.find((e) => e.id === "runner-pi");
  expect(runner).toBeDefined();
  expect(runner!.memory_limit_mb).toBe(256);

  await rm(dirname(file), { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A watch entry. The same rule, line by line: what it reads with has to be a
// declared key, whose chat it writes into has to be that person's agent with a
// door and a chat, the source is a closed list, and each count is a whole
// number above zero. Every refusal names the key and the line it sits on.
// ---------------------------------------------------------------------------

/** A household with one watch, each line replaceable by the check that needs it changed. */
function watchFixture(over: Record<string, string | null> = {}): string[] {
  const line = (key: string, fallback: string): string[] => {
    const said = Object.hasOwn(over, key) ? over[key] : fallback;
    return said === null ? [] : [said];
  };
  return [
    "[hub]",
    "tick_seconds = 5",
    'store_url = "postgres://127.0.0.1:5432/hub"',
    'state_dir = "/var/lib/imprnt-hub"',
    "",
    "[[machines]]",
    'id = "pi"',
    'os = "linux"',
    "",
    "[[people]]",
    'id = "p1"',
    'tree = "/var/lib/imprnt-hub/p1"',
    "",
    "[[people]]",
    'id = "p2"',
    'tree = "/var/lib/imprnt-hub/p2"',
    "",
    "[[credentials]]",
    'id = "sentry"',
    ...line("credential.kind", 'kind = "api-key"'),
    'file = "/var/lib/imprnt-hub/secrets/sentry.token"',
    'owner = "p1"',
    "",
    "[presets.daily]",
    'adapter = "scripted"',
    'model = "m"',
    'provider = "p"',
    'effort = "medium"',
    'paid = "key"',
    "",
    "[[agents]]",
    'id = "p1-lair"',
    'person = "p1"',
    'preset = "daily"',
    'chat = "1000000001"',
    'door = "door-fake"',
    'runner = "runner-pi"',
    "",
    "[[agents]]",
    'id = "p2-lair"',
    'person = "p2"',
    'preset = "daily"',
    'chat = "2000000001"',
    'door = "door-fake"',
    'runner = "runner-pi"',
    "",
    "# takes jobs alone",
    "[[agents]]",
    'id = "p1-batch"',
    'person = "p1"',
    'preset = "daily"',
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
    'id = "sentry-digest"',
    'kind = "watch"',
    ...line("source", 'source = "sentry"'),
    'machine = "pi"',
    ...line("schedule", 'schedule = "daily at 07:00"'),
    ...line("person", 'person = "p1"'),
    ...line("agent", 'agent = "p1-lair"'),
    ...line("credential", 'credential = "sentry"'),
    ...line("org", 'org = "example-org"'),
    ...line("query", 'query = "is:unresolved"'),
    ...line("min_events", "min_events = 1"),
    ...line("notify_events", "notify_events = 10"),
    ...line("reminder_days", "reminder_days = 7"),
    "memory_limit_mb = 128",
  ];
}

async function watchRefusal(lines: string[]): Promise<{ key: string; line: number; reason: string; file: string }> {
  const { loadRegistry, RegistryRefused } = await seam("src/registry/load.ts");
  const file = await scratch(lines);
  try {
    (loadRegistry as Function)(file);
  } catch (error) {
    expect(error).toBeInstanceOf(RegistryRefused as Function);
    const it = error as { key: string; line: number; reason: string };
    await rm(dirname(file), { recursive: true, force: true });
    return { key: it.key, line: it.line, reason: it.reason, file };
  }
  await rm(dirname(file), { recursive: true, force: true });
  throw new Error("the watch fixture loaded, and a refusal was expected");
}

test("a watch entry loads with its fields on the row and the defaults left to the reader", async () => {
  const { loadRegistry } = await seam("src/registry/load.ts");
  const { listRunEntries } = await seam("src/registry/entries.ts");
  const lines = watchFixture({ query: null, min_events: null, notify_events: null, reminder_days: null });
  const file = await scratch(lines);
  const entries = (listRunEntries as Function)((loadRegistry as Function)(file)) as Record<string, unknown>[];
  const watch = entries.find((one) => one.id === "sentry-digest")!;
  expect(watch).toMatchObject({
    kind: "watch", source: "sentry", machine: "pi", schedule: "daily at 07:00",
    person: "p1", agent: "p1-lair", credential: "sentry", org: "example-org", memory_limit_mb: 128,
  });
  // Absent means the reader's default, never a value the loader invented.
  for (const key of ["query", "min_events", "notify_events", "reminder_days"]) expect(watch).not.toHaveProperty(key);
  // And a file that says them carries them by value.
  const said = await scratch(watchFixture({ min_events: "min_events = 3", notify_events: "notify_events = 25", reminder_days: "reminder_days = 14" }));
  const full = ((listRunEntries as Function)((loadRegistry as Function)(said)) as Record<string, unknown>[])
    .find((one) => one.id === "sentry-digest")!;
  expect(full).toMatchObject({ query: "is:unresolved", min_events: 3, notify_events: 25, reminder_days: 14 });
  // The door's own row carries none of a watch's fields.
  expect(entries.find((one) => one.id === "door-fake")).not.toHaveProperty("source");
  await rm(dirname(file), { recursive: true, force: true });
  await rm(dirname(said), { recursive: true, force: true });
});

test("a watch with a source this hub does not read is refused by key and by line", async () => {
  const lines = watchFixture({ source: 'source = "github"' });
  const refused = await watchRefusal(lines);
  expect(refused.key).toBe("run[2].source");
  expect(refused.line).toBe(lineOf(lines, 'source = "github"'));
  expect(refused.reason).toContain("unsupported-watch-source: github");
});

test("a watch with no source, person, agent, credential or org is refused naming the key on the entry's own line", async () => {
  for (const key of ["source", "person", "agent", "credential", "org"]) {
    const lines = watchFixture({ [key]: null });
    const refused = await watchRefusal(lines);
    expect(refused.key, key).toBe(`run[2].${key}`);
    expect(refused.line, key).toBe(lineOf(lines, 'id = "sentry-digest"'));
    expect(refused.reason).toContain(`no ${key}`);
  }
});

test("a watch whose agent is another person's, or takes jobs alone, or is not an agent at all, is refused on the agent line", async () => {
  for (const [agent, said] of [
    ['agent = "p2-lair"', "p2's agent and not p1's"],
    ['agent = "p1-batch"', "names no door and no chat"],
    ['agent = "nobody"', "is not an agent of this file"],
  ]) {
    const lines = watchFixture({ agent });
    const refused = await watchRefusal(lines);
    expect(refused.key, agent).toBe("run[2].agent");
    expect(refused.line, agent).toBe(lineOf(lines, agent));
    expect(refused.reason, agent).toContain(said);
  }
});

test("a watch whose person the file does not declare is refused on the person line", async () => {
  const lines = watchFixture({ person: 'person = "p3"' });
  const refused = await watchRefusal(lines);
  expect(refused.key).toBe("run[2].person");
  expect(refused.line).toBe(lineOf(lines, 'person = "p3"'));
});

test("a watch reading with a credential that is not declared, or is not a key, is refused on the credential line", async () => {
  {
    const lines = watchFixture({ credential: 'credential = "nothing"' });
    const refused = await watchRefusal(lines);
    expect(refused.key).toBe("run[2].credential");
    expect(refused.line).toBe(lineOf(lines, 'credential = "nothing"'));
    expect(refused.reason).toContain("no [[credentials]] entry declares");
  }
  {
    const lines = watchFixture({ "credential.kind": 'kind = "telegram"' });
    const refused = await watchRefusal(lines);
    expect(refused.key).toBe("run[2].credential");
    expect(refused.line).toBe(lineOf(lines, 'credential = "sentry"'));
    expect(refused.reason).toContain("must be an api-key");
  }
});

test("a watch count that is not a whole number above zero, and a schedule that is not a cadence, are refused by key and by line", async () => {
  for (const [key, raw] of [
    ["min_events", "min_events = 0"],
    ["notify_events", 'notify_events = "ten"'],
    ["reminder_days", "reminder_days = 1.5"],
    ["query", 'query = ""'],
  ]) {
    const lines = watchFixture({ [key]: raw });
    const refused = await watchRefusal(lines);
    expect(refused.key, raw).toBe(`run[2].${key}`);
    expect(refused.line, raw).toBe(lineOf(lines, raw));
  }
  const lines = watchFixture({ schedule: 'schedule = "always"' });
  const refused = await watchRefusal(lines);
  expect(refused.key).toBe("run[2].schedule");
  // The watch's own line, which is the LAST `always` in the fixture: the door
  // and the runner carry the same words above it.
  expect(refused.line).toBe(lines.lastIndexOf('schedule = "always"') + 1);
  expect(refused.reason).toContain("cadence");
});
