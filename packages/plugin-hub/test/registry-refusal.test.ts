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
