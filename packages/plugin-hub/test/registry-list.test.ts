// RUN-01. The registry is the list of what runs.
//
// SPEC §6: "The registry is the list: one file names everything the hub runs for
// a household (doors, runners, watcher timers, the vault sync, the backup, the
// transcriber, the board), each with its schedule and memory limit. Nothing runs
// because it is on disk." L17 names the registry as a state sheet, so "a second
// row for the same id is forbidden".
//
// Behind the rule: the vault sync and the backup were v1 leftovers outside v2's
// unit set. A session stopped them and nobody noticed for 35 hours, with one person's
// vault having no backup at all meanwhile.

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

function lineOf(lines: string[], needle: string, from = 0): number {
  const index = lines.findIndex((line, i) => i >= from && line.includes(needle));
  if (index < 0) throw new Error(`the fixture does not contain ${needle}`);
  return index + 1;
}

// D-81 as phase 3b makes it: `child_memory_limit_mb` is required on every
// `kind = "runner"` entry, whether or not the file declares its machines, so the
// runner of the seven carries one. A fixture field: every line number this file
// asserts is computed from the array it just built, so nothing below it moves.
/** The seven kinds L13 names, each with a schedule and a memory limit. */
const SEVEN: {
  id: string;
  kind: string;
  schedule: string;
  mb: number;
  childMb?: number;
}[] = [
  { id: "door-telegram", kind: "door", schedule: "always", mb: 192 },
  { id: "runner-pi", kind: "runner", schedule: "always", mb: 512, childMb: 512 },
  { id: "watch-bikes", kind: "watcher", schedule: "every 30m", mb: 128 },
  { id: "vault-sync", kind: "sync", schedule: "every 15m", mb: 128 },
  { id: "backup", kind: "backup", schedule: "hourly", mb: 256 },
  { id: "transcriber", kind: "transcriber", schedule: "on demand", mb: 1024 },
  { id: "board", kind: "board", schedule: "always", mb: 256 },
];

function header(): string[] {
  return ["[hub]", "tick_seconds = 5", ""];
}

function entry(e: {
  id: string;
  kind: string;
  schedule: string;
  mb?: number;
  childMb?: number;
}): string[] {
  const lines = [
    "[[run]]",
    `id = "${e.id}"`,
    `kind = "${e.kind}"`,
    `schedule = "${e.schedule}"`,
  ];
  if (e.mb !== undefined) lines.push(`memory_limit_mb = ${e.mb}`);
  if (e.childMb !== undefined) lines.push(`child_memory_limit_mb = ${e.childMb}`);
  lines.push("");
  return lines;
}

test("RUN-01 a registry entry names each thing the hub runs with its schedule and its memory limit (SPEC §6, L13)", async () => {
  const { loadRegistry } = await seam("src/registry/load.ts");
  const { listRunEntries } = await seam("src/registry/entries.ts");
  expect(typeof listRunEntries).toBe("function");

  const lines = [...header(), ...SEVEN.flatMap(entry)];
  const file = await scratch(lines);

  const entries = (await (listRunEntries as Function)(
    (loadRegistry as Function)(file),
  )) as { id: string; kind: string; schedule: string; memory_limit_mb: number }[];

  // Compared both ways, so an entry the loader invented fails as well as one it
  // dropped. Nothing runs because it is on disk, and nothing on the list is lost.
  const got = entries.map((e) => e.id).sort();
  const want = SEVEN.map((e) => e.id).sort();
  expect(got).toEqual(want);

  for (const wanted of SEVEN) {
    const found = entries.find((e) => e.id === wanted.id);
    expect(found).toBeDefined();
    expect(found!.kind).toBe(wanted.kind);
    expect(found!.schedule).toBe(wanted.schedule);
    expect(typeof found!.memory_limit_mb).toBe("number");
    expect(found!.memory_limit_mb).toBeGreaterThan(0);
    expect(found!.memory_limit_mb).toBe(wanted.mb);
  }

  await rm(dirname(file), { recursive: true, force: true });
});

test("RUN-01 an entry with no memory limit refuses the file and names its line (SPEC §6, L13 and L14)", async () => {
  const { loadRegistry, RegistryRefused } = await seam("src/registry/load.ts");
  expect(typeof loadRegistry).toBe("function");

  const broken = { id: "transcriber", kind: "transcriber", schedule: "on demand" };
  const lines = [
    ...header(),
    ...entry(SEVEN[0]),
    ...entry(broken),
    ...entry(SEVEN[1]),
  ];
  const file = await scratch(lines);

  let refusal: unknown;
  try {
    (loadRegistry as Function)(file);
  } catch (err) {
    refusal = err;
  }

  expect(refusal).toBeInstanceOf(RegistryRefused as Function);
  expect((refusal as { line: number }).line).toBe(lineOf(lines, '"transcriber"'));
  expect(String((refusal as Error).message)).toContain("memory_limit_mb");

  await rm(dirname(file), { recursive: true, force: true });
});

test("RUN-01 the registry is a state sheet: a second entry reusing an id refuses the file and names the line of the duplicate (SPEC §6 and §7, L13 and L17)", async () => {
  const { loadRegistry, RegistryRefused } = await seam("src/registry/load.ts");
  expect(typeof loadRegistry).toBe("function");

  const duplicate = { ...SEVEN[0], schedule: "every 5m", mb: 64 };
  const lines = [
    ...header(),
    ...entry(SEVEN[0]),
    ...entry(SEVEN[1]),
    ...entry(duplicate),
  ];
  const file = await scratch(lines);

  const firstIdLine = lineOf(lines, `"${SEVEN[0].id}"`);
  const secondIdLine = lineOf(lines, `"${SEVEN[0].id}"`, firstIdLine);
  expect(secondIdLine).toBeGreaterThan(firstIdLine);

  let refusal: unknown;
  try {
    (loadRegistry as Function)(file);
  } catch (err) {
    refusal = err;
  }

  expect(refusal).toBeInstanceOf(RegistryRefused as Function);
  // The line of the duplicate, not of the original. The first one is fine.
  expect((refusal as { line: number }).line).toBe(secondIdLine);
  expect(String((refusal as Error).message)).toContain(SEVEN[0].id);

  await rm(dirname(file), { recursive: true, force: true });
});
