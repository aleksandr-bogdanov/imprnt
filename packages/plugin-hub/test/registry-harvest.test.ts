// HARV-05. Three knobs per person plus the vault and the line back, and a bad
// one refuses the file by name and by line.
//
// SPEC §4's Forbidden carries "a harvest cost that cannot be changed in the
// registry". SPEC §6's Forbidden carries "a setting nothing in production
// reads" and "a quiet default on a bad value". L19: "Three knobs in the
// registry: the harvester preset, the quiet timeout, and the minimum slice.
// Defaults ship per model so a plan login can run a strong model on every slice
// and a per-token key runs a cheaper preset with a larger minimum slice."
//
// Pure. No Postgres and no operating system: the registry is a file and the
// loader is a file loader.
//
// "Names the line" is the behaviour, so every refusal here binds the KEY and
// the LINE and never merely that something threw, exactly as
// test/registry-thresholds.test.ts binds the. Every bad file below is
// valid in every OTHER respect, for the same reason.
//
// THE CONVENTION FOR AN ABSENT KEY, which the shipped loader already uses: a
// key that is not in the file has no line of its own, so the refusal names the
// line of the entry it should have been under, which is that entry's own id
// line.
//
// CONTAINMENT IS CHECKED AND EXISTENCE IS NOT.
// Whether a path exists is a question about a MACHINE and one file loads on
// three of them. Whether one path lies inside another is string arithmetic
// decidable from the file alone, and it is what makes the harvester's session
// able to read the vault at all, because the box fences the person's tree.
//
// Red reason: behaviour absent. `loadRegistry` parses `[[people]]` for `id`,
// `tree` and the five fields and looks at none of these, so every bad
// file below loads with no complaint, and `harvestFor` does not exist. The
// assertion that is red first is refusal 1.

import { test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts";
import { listPeople } from "../src/registry/entries.ts";

/**
 * The tests' own copy of the accessor's answer, for the reason
 * `test/helpers/finding.ts` gives about its own: a shape imported from the code
 * under test agrees with every build, including one that renamed a field away.
 */
interface HarvestSettings {
  harvester: string;
  vault: string;
  quiet_minutes: number;
  min_messages: number;
  report: boolean;
}

let dir: string;

function write(lines: string[]): string {
  dir ??= mkdtempSync(join(tmpdir(), "hub-harvest-registry-"));
  const file = join(dir, `registry-${crypto.randomUUID().slice(0, 8)}.toml`);
  writeFileSync(file, lines.join("\n") + "\n", "utf8");
  return file;
}

/** One-based line of the nth line whose text is exactly this. */
function lineOf(lines: string[], text: string, nth = 1): number {
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === text && ++seen === nth) return i + 1;
  }
  throw new Error(`the fixture has no ${nth} occurrence of ${JSON.stringify(text)}`);
}

/** Replace the nth occurrence of a line. */
function replace(lines: string[], text: string, withText: string, nth = 1): string[] {
  const out = [...lines];
  out[lineOf(lines, text, nth) - 1] = withText;
  return out;
}

/** Drop the nth occurrence of a line, keeping every other line's number. */
function drop(lines: string[], text: string, nth = 1): string[] {
  return replace(lines, text, "# this line was removed by the check", nth);
}

// The scratch directory goes with the file, whichever way the check ended. The
// shipped refusal checks leave theirs behind and the temp directory fills up
// with them over a suite's lifetime, which is a side effect of running the
// suite and outside the package.
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

function refusalOf(file: string): RegistryRefused {
  try {
    loadRegistry(file);
  } catch (error) {
    return error as RegistryRefused;
  }
  throw new Error(`${file} loaded, and it should have been refused`);
}

/**
 * The two presets every fixture below carries: one paid for by a plan and one
 * by a per-token key, so "defaults per model" can be a behaviour over ONE file
 * rather than a sentence.
 */
const PRESETS: string[] = [
  "[presets.harvest]",
  'adapter = "a-loop"',
  'model = "a-stronger-model-name"',
  'provider = "a-provider"',
  'effort = "high"',
  'paid = "plan"',
  "window_pause_at = 85",
  "window_notice_at = 95",
  "window_hold_at = 100",
  "",
  "[presets.harvest-key]",
  'adapter = "a-loop"',
  'model = "a-cheaper-model-name"',
  'provider = "a-provider"',
  'effort = "low"',
  'paid = "key"',
];

/**
 * Two people whose every harvest field DIFFERS, so a build that reads one
 * person's row for everybody fails, and not one of the numbers is a default, so
 * a build that answers with the defaults fails too. The second person's report
 * is off, which is HARV-04's ruling written as the shipped example writes it:
 * on by default for the owner, off for the second person.
 */
function peopleLines(): string[] {
  return [
    "# the hub's registry",
    "",
    "[hub]",
    "tick_seconds = 5",
    "",
    "[[people]]",
    'id = "p1"',
    'tree = "/var/lib/imprnt-hub/p1"',
    'language = "en"',
    'harvester = "harvest"',
    'vault = "/var/lib/imprnt-hub/p1/vault-project"',
    "harvest_quiet_minutes = 31",
    "harvest_min_messages = 3",
    "harvest_report = true",
    "",
    "[[people]]",
    'id = "p2"',
    'tree = "/var/lib/imprnt-hub/p2"',
    'language = "ru"',
    'harvester = "harvest-key"',
    'vault = "/var/lib/imprnt-hub/p2/notes"',
    "harvest_quiet_minutes = 90",
    "harvest_min_messages = 25",
    "harvest_report = false",
    "",
    ...PRESETS,
  ];
}

test(
  "HARV-05 a person says which preset harvests their chats, where their vault is, how long quiet means, how small a slice is too small and whether a line comes back, and every bad answer refuses the file by name and by line, while a person who names no harvester still loads (SPEC §4 and §6, L19, D-137 to D-139)",
  async () => {
    const base = peopleLines();

    // ---------------------------------------------------------------------
    // The seven refusals. Each binds the key and the line, and each is
    // asserted on its own rather than as a group.
    // ---------------------------------------------------------------------

    // --- 1. a harvester naming a preset this file does not define. Nothing can
    //     harvest through a preset that is not there, and the file is the one
    //     place that could have said so.
    {
      const lines = replace(base, 'harvester = "harvest"', 'harvester = "nobody"');
      const refusal = refusalOf(write(lines));
      expect(refusal).toBeInstanceOf(RegistryRefused);
      expect(refusal.key).toContain("people[0]");
      expect(refusal.key).toContain("harvester");
      expect(refusal.line).toBe(lineOf(lines, 'harvester = "nobody"'));
      expect(String(refusal.message)).toContain(String(refusal.line));
      expect(refusal.reason).toContain("nobody");
    }

    // --- 2. a harvester with NO vault on that entry. Nothing can file into a
    //     vault the file does not name. The absent key names the entry's own
    //     id line, which is the shipped convention.
    {
      const lines = drop(base, 'vault = "/var/lib/imprnt-hub/p1/vault-project"');
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toContain("people[0]");
      expect(refusal.key).toContain("vault");
      expect(refusal.line).toBe(lineOf(lines, 'id = "p1"'));
    }

    // --- 3. A vault may supply filing rules without enabling harvest.
    {
      const lines = drop(base, 'harvester = "harvest"');
      const registry = loadRegistry(write(lines));
      const { filingRulesFor, harvestFor } = await seam("src/registry/entries.ts");
      expect((harvestFor as Function)(registry, "p1")).toBeNull();
      expect((filingRulesFor as Function)(registry, "p1")).toBe(
        "/var/lib/imprnt-hub/p1/vault-project/CLAUDE.md",
      );
    }

    // --- 4. a vault that is not an absolute path. A relative path is resolved
    //     against whatever directory the process happens to be in, which is a
    //     different vault on every machine.
    {
      const lines = replace(
        base,
        'vault = "/var/lib/imprnt-hub/p1/vault-project"',
        'vault = "relative/path"',
      );
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toContain("people[0]");
      expect(refusal.key).toContain("vault");
      expect(refusal.line).toBe(lineOf(lines, 'vault = "relative/path"'));
    }

    // --- 5. a vault outside that person's own tree. The harvester's session
    //     runs in the agent's box and the box fences the tree, so a vault
    //     outside it is a vault the loop cannot read: the model would file
    //     nothing and every person link it wrote would be an orphan.
    {
      const lines = replace(
        base,
        'vault = "/var/lib/imprnt-hub/p1/vault-project"',
        'vault = "/var/lib/imprnt-hub/p2/vault-project"',
      );
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toContain("people[0]");
      expect(refusal.key).toContain("vault");
      expect(refusal.line).toBe(lineOf(lines, 'vault = "/var/lib/imprnt-hub/p2/vault-project"'));
      expect(refusal.reason).toContain("/var/lib/imprnt-hub/p1");
    }

    // --- 6. the two numbers. Four bad values each, one assertion per value
    //     per key, never as a group: a zero, a negative, a fraction and a word.
    //     A quiet period of zero is a chat that is always quiet and a minimum
    //     of zero is a slice of nothing, so both are a quiet default
    //     rather than a number a household chose.
    for (const [key, good] of [
      ["harvest_quiet_minutes", "harvest_quiet_minutes = 31"],
      ["harvest_min_messages", "harvest_min_messages = 3"],
    ] as [string, string][]) {
      for (const bad of [`${key} = 0`, `${key} = -1`, `${key} = 1.5`, `${key} = "soon"`]) {
        const lines = replace(base, good, bad);
        const refusal = refusalOf(write(lines));
        expect(refusal.key).toContain("people[0]");
        expect(refusal.key).toContain(key);
        expect(refusal.line).toBe(lineOf(lines, bad));
        expect(refusal.reason).toContain(key);
      }
    }

    // --- 7. a report switch that is not a boolean. It is a yes or a no and
    //     the file's own words for those two are `true` and `false`.
    {
      const lines = replace(base, "harvest_report = true", 'harvest_report = "yes"');
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toContain("people[0]");
      expect(refusal.key).toContain("harvest_report");
      expect(refusal.line).toBe(lineOf(lines, 'harvest_report = "yes"'));
      expect(refusal.reason).toContain("harvest_report");
    }

    // ---------------------------------------------------------------------
    // The controls. Without them this is a check on a loader that refuses
    // everything, which proves nothing at all.
    // ---------------------------------------------------------------------
    const { harvestFor } = await seam("src/registry/entries.ts");
    expect(typeof harvestFor).toBe("function");
    const read = harvestFor as (registry: unknown, person: string) => HarvestSettings | null;
    const { HARVEST_DEFAULTS } = await seam("src/registry/load.ts");

    // --- (a) the whole file loads and each person reads back their OWN row,
    //     every field differing between the two.
    {
      const registry = loadRegistry(write(base));
      expect(read(registry, "p1")).toEqual({
        harvester: "harvest",
        vault: "/var/lib/imprnt-hub/p1/vault-project",
        quiet_minutes: 31,
        min_messages: 3,
        report: true,
      });
      expect(read(registry, "p2")).toEqual({
        harvester: "harvest-key",
        vault: "/var/lib/imprnt-hub/p2/notes",
        quiet_minutes: 90,
        min_messages: 25,
        report: false,
      });
    }

    // --- (b) THE ABSENCE TOLERANCE, which is what keeps every shipped check
    //     green. A file whose people carry `id` and `tree` only loads,
    //     `harvestFor` answers null for each, and `listPeople`'s rows gain NO
    //     keys. That last clause is the one that matters:
    //     test/registry-machines.test.ts asserts that exact shape today, and a
    //     build that always spreads five more keys onto the entry breaks it.
    {
      const bare = [
        "[hub]",
        "tick_seconds = 5",
        "",
        "[[people]]",
        'id = "p1"',
        'tree = "/var/lib/imprnt-hub/p1"',
        "",
        "[[people]]",
        'id = "p2"',
        'tree = "/var/lib/imprnt-hub/p2"',
        "",
        ...PRESETS,
      ];
      const registry = loadRegistry(write(bare));
      expect(read(registry, "p1")).toBeNull();
      expect(read(registry, "p2")).toBeNull();
      for (const person of listPeople(registry)) {
        expect(Object.keys(person).sort()).toEqual(["id", "tree"]);
      }
    }

    // --- (c) THE DEFAULTS, PER MODEL. One file, two presets, two answers: the
    //     minimum slice comes off the HARVESTER preset's own `paid`, because
    //     the cost L19 is talking about is the harvest's own. A plan login can
    //     run a strong model on every slice, and a per-token key waits for a
    //     bigger one.
    {
      const defaults = [
        "[hub]",
        "tick_seconds = 5",
        "",
        "[[people]]",
        'id = "p1"',
        'tree = "/var/lib/imprnt-hub/p1"',
        'harvester = "harvest"',
        'vault = "/var/lib/imprnt-hub/p1/vault-project"',
        "",
        "[[people]]",
        'id = "p2"',
        'tree = "/var/lib/imprnt-hub/p2"',
        'harvester = "harvest-key"',
        'vault = "/var/lib/imprnt-hub/p2/vault-project"',
        "",
        ...PRESETS,
      ];
      const registry = loadRegistry(write(defaults));
      expect(read(registry, "p1")).toEqual({
        harvester: "harvest",
        vault: "/var/lib/imprnt-hub/p1/vault-project",
        quiet_minutes: 30,
        min_messages: 1,
        report: true,
      });
      expect(read(registry, "p2")).toEqual({
        harvester: "harvest-key",
        vault: "/var/lib/imprnt-hub/p2/vault-project",
        quiet_minutes: 30,
        min_messages: 20,
        report: true,
      });
    }

    // --- the constant itself, asserted as an object, so a build that
    //     renumbers a default is caught here rather than in a chat six months
    //     later.
    expect(HARVEST_DEFAULTS).toEqual({
      quiet_minutes: 30,
      report: true,
      min_messages: { plan: 1, key: 20 },
    });

    // --- (d) containment, three ways, all decidable from the file alone: the
    //     vault EQUAL to the tree, one directory under it, and one carrying a
    //     `..` segment that RESOLVES to inside it.
    for (const vault of [
      "/var/lib/imprnt-hub/p1",
      "/var/lib/imprnt-hub/p1/vault-project",
      "/var/lib/imprnt-hub/p1/notes/../vault-project",
    ]) {
      const lines = replace(
        base,
        'vault = "/var/lib/imprnt-hub/p1/vault-project"',
        `vault = ${JSON.stringify(vault)}`,
      );
      const registry = loadRegistry(write(lines));
      expect(read(registry, "p1")?.harvester).toBe("harvest");
    }

    // --- (e) a person with an EMPTY tree and a vault anywhere loads. Whether
    // a person has a tree is a question about a machine, their
    //     agents already run unboxed and `check` already says `agent-unboxed`,
    //     and refusing here would take the hub down over a second thing.
    {
      const lines = drop(base, 'tree = "/var/lib/imprnt-hub/p1"');
      const registry = loadRegistry(write(lines));
      expect(read(registry, "p1")?.vault).toBe("/var/lib/imprnt-hub/p1/vault-project");
    }

    // --- (f) an unrelated extra key on an entry still loads, so the loader
    //     tolerates a key it has no rule about exactly as it already does.
    {
      const lines = [...base];
      lines.splice(lineOf(base, 'id = "p1"'), 0, 'some_future_key = "a value"');
      const registry = loadRegistry(write(lines));
      expect(read(registry, "p1")?.quiet_minutes).toBe(31);
    }

    // --- (g) a vault that does NOT exist on this machine still loads. The
    //     path below is under a directory this check never creates, and
    //     existence is never asked: the same file loads on three machines.
    {
      const nowhere = join(dir, "no-such-directory-ever", "vault-project");
      const lines = replace(
        base,
        'tree = "/var/lib/imprnt-hub/p1"',
        `tree = ${JSON.stringify(join(dir, "no-such-directory-ever"))}`,
      );
      const registry = loadRegistry(
        write(replace(lines, 'vault = "/var/lib/imprnt-hub/p1/vault-project"', `vault = ${JSON.stringify(nowhere)}`)),
      );
      expect(read(registry, "p1")?.vault).toBe(nowhere);
    }
  },
);
