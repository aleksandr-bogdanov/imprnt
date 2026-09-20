// The machine and people registry fields are refused BY NAME, and a
// file carrying all of them loads.
//
// SPEC §6: "a file with a bad value is refused loudly." L14's Forbidden: "A
// value that does not parse being defaulted quietly: the file is refused and the
// line named." L13: "the registry is the list." The file carries `[[machines]]`,
// `[[run]].machine`, `child_memory_limit_mb` on a runner entry and `[[people]]`.
//
// "Names the line" is the behaviour, so every refusal here binds the KEY and the
// LINE, never merely that something threw: the shipped loader already throws for
// other reasons, and a check that only caught a throw could not tell a correct
// refusal from an accidental one. Every bad file below is valid in every OTHER
// respect, for the same reason.
//
// THE TWO TOLERANCES ARE THE LOAD-BEARING CONTROLS. A file that declares fewer
// than two machines needs no `machine` anywhere, and a file that declares no
// people is not asked about them. That is the same move made with
// `inbound.kind`'s default, and it is what keeps the 65 shipped checks green: a
// loader that made either fact unconditional would fail every one of them on
// contact.
//
// Red reason: behaviour absent. `loadRegistry` today parses `[[run]]` and never
// looks at `machine`, `child_memory_limit_mb` or `[[people]]`, so every one of
// the six bad files loads with no complaint. The assertion that is red is the
// refusal, not an import, so the refusals come first in this file.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts";

function goodLines(): string[] {
  return [
    "# the hub's registry",
    "",
    "[hub]",
    "tick_seconds = 5",
    'shared_zone = "/var/lib/imprnt-hub/shared"',
    "restart_delay_seconds = 1",
    "give_up_after = 5",
    "give_up_window_seconds = 300",
    "job_grace_seconds = 300",
    "silent_runner_hours = 6",
    "",
    "[[machines]]",
    'id = "pi"',
    'os = "linux"',
    "",
    "[[machines]]",
    'id = "mac"',
    'os = "macos"',
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
    'id = "test-login"',
    'kind = "claude-login"',
    'file = "/var/lib/imprnt-hub/credentials/.credentials.json"',
    'owner = "household"',
    "",
    "[presets.daily]",
    'credential = "test-login"',
    'adapter = "claude-code"',
    'model = "a-model-name"',
    'provider = "a-provider"',
    'effort = "medium"',
    'paid = "plan"',
    // The three window thresholds are required
    // on every plan preset, by name.
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
    "child_memory_limit_mb = 512",
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

let dir: string;
function write(lines: string[]): string {
  dir ??= mkdtempSync(join(tmpdir(), "hub-machines-"));
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

function refusalOf(file: string): RegistryRefused {
  try {
    loadRegistry(file);
  } catch (error) {
    return error as RegistryRefused;
  }
  throw new Error(`${file} loaded, and it should have been refused`);
}

test(
  "RUN-08 and RUN-04 the phase 3 registry fields are refused by name and by line: an entry with no machine where two are declared, a machine that is not declared, a runner with no child memory limit, two people with one id, an agent naming an undeclared person and a machine whose os is neither linux nor macos (SPEC §6, L13, L14, D-76, D-81, D-93)",
  async () => {
    const base = goodLines();

    // --- 1. two machines declared and an entry that names none. Without this
    //     the entry belongs to no machine and nothing ever runs it, silently.
    {
      const lines = drop(base, 'machine = "mac"');
      const refusal = refusalOf(write(lines));
      expect(refusal).toBeInstanceOf(RegistryRefused);
      expect(refusal.key).toContain("machine");
      expect(refusal.key).toContain("run[2]");
      // A key that is ABSENT has no line of its own, so the refusal names the
      // entry's id line, which is the convention the shipped loader already uses
      // for a missing `memory_limit_mb`.
      expect(refusal.line).toBe(lineOf(base, 'id = "runner-mac"'));
      expect(String(refusal.message)).toContain(String(refusal.line));
    }

    // --- 2. a machine that no [[machines]] declares. A typo would otherwise
    //     mean "runs nowhere", quietly, which is a forbidden quiet default.
    {
      const lines = replace(base, 'machine = "mac"', 'machine = "macc"');
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toContain("machine");
      expect(refusal.key).toContain("run[2]");
      expect(refusal.line).toBe(lineOf(lines, 'machine = "macc"'));
      expect(refusal.reason).toContain("macc");
    }

    // --- 3. a runner with no child memory limit. A child that could
    //     never be watched cannot be configured.
    {
      const lines = drop(base, "child_memory_limit_mb = 2048");
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toContain("child_memory_limit_mb");
      expect(refusal.key).toContain("run[2]");
      expect(refusal.line).toBe(lineOf(base, 'id = "runner-mac"'));
    }

    // --- 4. two [[people]] with one id, the way a duplicate [[run]] id already
    //     refuses.
    {
      const lines = replace(base, 'id = "p2"', 'id = "p1"');
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toContain("people[1]");
      expect(refusal.key).toContain("id");
      expect(refusal.line).toBe(lineOf(base, 'id = "p2"'));
      expect(refusal.reason).toContain("p1");
    }

    // --- 5. an agent naming a person the file declares none of, in a file that
    //     declares people. The same shape as the undefined-preset refusal.
    {
      const lines = replace(base, 'person = "p1"', 'person = "p9"');
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toContain("agents[0]");
      expect(refusal.key).toContain("person");
      expect(refusal.line).toBe(lineOf(lines, 'person = "p9"'));
      expect(refusal.reason).toContain("p9");
    }

    // --- 6. an os outside the two. The os is in the FILE rather than taken from
    // process.platform, so a mis-set one is caught here rather than
    //     by writing systemd units onto a Mac.
    {
      const lines = replace(base, 'os = "macos"', 'os = "plan9"');
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toContain("machines[1]");
      expect(refusal.key).toContain("os");
      expect(refusal.line).toBe(lineOf(lines, 'os = "plan9"'));
      expect(refusal.reason).toContain("plan9");
    }

    // --- control (a): the whole file loads, and every accessor returns what the
    //     FILE said. A loader that refuses correctly and reads nothing fails
    //     from here on.
    const { listMachines, listPeople, runEntriesFor, personOf } = await seam(
      "src/registry/entries.ts",
    );
    expect(typeof listMachines).toBe("function");
    expect(typeof listPeople).toBe("function");
    expect(typeof runEntriesFor).toBe("function");
    expect(typeof personOf).toBe("function");

    // The production preset's credential is explicit and required.
    const absentLogin = refusalOf(write(base.filter(line => line !== 'credential = "test-login"')));
    expect(absentLogin.key).toBe("presets.daily.credential");

    const registry = loadRegistry(write(base));
    expect((listMachines as Function)(registry)).toEqual([
      { id: "pi", os: "linux" },
      { id: "mac", os: "macos" },
    ]);
    expect((listPeople as Function)(registry)).toEqual([
      { id: "p1", tree: "/var/lib/imprnt-hub/p1" },
      { id: "p2", tree: "/var/lib/imprnt-hub/p2" },
    ]);
    const onPi = (runEntriesFor as Function)(registry, "pi") as { id: string }[];
    expect(onPi.map((e) => e.id).sort()).toEqual(["door-fake", "runner-pi"]);
    const onMac = (runEntriesFor as Function)(registry, "mac") as {
      id: string;
      child_memory_limit_mb?: number;
    }[];
    expect(onMac.map((e) => e.id)).toEqual(["runner-mac"]);
    expect(onMac[0].child_memory_limit_mb).toBe(2048);
    expect((personOf as Function)(registry, "p1-lair")).toEqual({
      id: "p1",
      tree: "/var/lib/imprnt-hub/p1",
    });

    // --- control (b): THE TOLERANCE. One machine, no people at all, and no
    //     `machine` on any entry. It LOADS, and every entry belongs to the one
    //     machine the asking process names. This is what the 65 shipped checks
    //     depend on, and every one of them would fail on contact without it.
    const lean = [
      "[hub]",
      "tick_seconds = 5",
      "",
      "[[machines]]",
      'id = "pi"',
      'os = "linux"',
      "",
      "[[run]]",
      'id = "door-fake"',
      'kind = "door"',
      'schedule = "always"',
      "memory_limit_mb = 192",
      "",
      "[[run]]",
      'id = "runner-pi"',
      'kind = "runner"',
      'schedule = "always"',
      "memory_limit_mb = 512",
      "child_memory_limit_mb = 512",
    ];
    const leanRegistry = loadRegistry(write(lean));
    expect(
      ((runEntriesFor as Function)(leanRegistry, "pi") as { id: string }[])
        .map((e) => e.id)
        .sort(),
    ).toEqual(["door-fake", "runner-pi"]);

    // And a file with no [[machines]] table at all is the shape every early
    // check writes today.
    const machineless = loadRegistry(write(lean.filter((l, i) => i < 2 || i > 5)));
    expect(
      ((runEntriesFor as Function)(machineless, "runner-test") as { id: string }[]).length,
    ).toBe(2);
    expect((listMachines as Function)(machineless)).toEqual([]);
    expect((listPeople as Function)(machineless)).toEqual([]);

    // --- control (c): an unrelated extra key in each table still loads, so a
    //     loader that refuses every key it has no rule about is caught. That is
    //     the narrowing control every refusal check here carries.
    const tolerated: [string, string][] = [
      ['os = "linux"', 'note = "the one in the hall"'],
      ['tree = "/var/lib/imprnt-hub/p1"', 'nickname = "the first"'],
      ['paid = "plan"', 'comment = "unrelated"'],
      ['runner = "runner-pi"', 'label = "unrelated"'],
      ["memory_limit_mb = 192", 'note = "unrelated"'],
    ];
    for (const [after, extra] of tolerated) {
      const at = base.indexOf(after);
      const lines = [...base.slice(0, at + 1), extra, ...base.slice(at + 1)];
      // It loads. Nothing is asserted about the key: the loader has no rule
      // about it and is meant to have none.
      expect(loadRegistry(write(lines))).toBeDefined();
    }
    // Plus a [[rates]] table, which the file does not otherwise carry.
    expect(
      loadRegistry(
        write([
          ...base,
          "",
          "[[rates]]",
          'model = "a-model-name"',
          'from = "2026-01-01"',
          "input_per_m = 1.0",
          "cached_per_m = 0.1",
          "output_per_m = 5.0",
          'currency = "USD"',
          'note = "unrelated"',
        ]),
      ),
    ).toBeDefined();

    rmSync(dir, { recursive: true, force: true });
  },
  30_000,
);

// ---------------------------------------------------------------------------
// `child_memory_limit_mb` is required on a runner entry whether or
// not the file declares its machines.
//
// Making the refusal conditional on `[[machines]]` would be a compromise with
// the test suite and not a rule anybody wants: the field is required on a runner
// entry and refused by name when missing, so a child that could never be watched
// cannot be configured, and a file with no `[[machines]]` table is exactly the
// file a household starts with. Every fixture in the repository now carries the
// field, so the tolerance has nothing left to protect.
//
// A ONE-MACHINE FILE IS ALREADY REFUSED, because
// the shipped rule fires whenever `machines.length > 0`. So the one-machine
// file is kept as the CONTROL that says the existing half still holds, and the
// case this file is really about is the file with no `[[machines]]` table at all.
//
// Red reason: behaviour absent. `src/registry/load.ts` refuses a runner with no
// `child_memory_limit_mb` only when the file declares at least one machine, so
// the machineless file below loads with no complaint.
// ---------------------------------------------------------------------------

/** A file with no `[[machines]]` table: the shape a household starts with. */
function machinelessLines(childLimit: boolean): string[] {
  return [
    "# the hub's registry",
    "",
    "[hub]",
    "tick_seconds = 5",
    "",
    "[[run]]",
    'id = "door-fake"',
    'kind = "door"',
    'schedule = "always"',
    "memory_limit_mb = 192",
    "",
    "[[run]]",
    'id = "runner-pi"',
    'kind = "runner"',
    'schedule = "always"',
    "memory_limit_mb = 512",
    ...(childLimit ? ["child_memory_limit_mb = 512"] : []),
  ];
}

/** The same file with exactly one `[[machines]]` entry. */
function oneMachineLines(childLimit: boolean): string[] {
  const lines = machinelessLines(childLimit);
  const at = lines.indexOf("tick_seconds = 5") + 1;
  return [...lines.slice(0, at), "", "[[machines]]", 'id = "pi"', 'os = "linux"', ...lines.slice(at)];
}

test(
  "RUN-08 a runner with no child memory limit is refused by name whether or not the file declares its machines: a machineless file is refused at the entry's own line, a one-machine file still is, and the same two files carrying the field load (SPEC §6, L13, L14, D-81)",
  async () => {
    // The check above deletes the shared scratch directory when it ends, so
    // this one takes a directory of its own rather than a path that is gone.
    dir = mkdtempSync(join(tmpdir(), "hub-machines-3b-"));

    // --- the case that is red today: no [[machines]] table at all.
    {
      const lines = machinelessLines(false);
      const refusal = refusalOf(write(lines));
      expect(refusal).toBeInstanceOf(RegistryRefused);
      expect(refusal.key).toContain("child_memory_limit_mb");
      expect(refusal.key).toContain("run[1]");
      // An absent key has no line of its own, so the refusal names the entry's
      // id line, which is the convention the shipped loader already uses.
      expect(refusal.line).toBe(lineOf(lines, 'id = "runner-pi"'));
      expect(String(refusal.message)).toContain(String(refusal.line));
      expect(refusal.reason).toContain("runner-pi");
    }

    // --- the control that says the shipped half did not move: one machine
    //     declared, and the same entry is refused the same way.
    {
      const lines = oneMachineLines(false);
      const refusal = refusalOf(write(lines));
      expect(refusal.key).toContain("child_memory_limit_mb");
      expect(refusal.line).toBe(lineOf(lines, 'id = "runner-pi"'));
    }

    // --- and both files LOAD once the entry carries the field, so what is
    //     refused is the missing limit and not the shape of the file.
    for (const lines of [machinelessLines(true), oneMachineLines(true)]) {
      const registry = loadRegistry(write(lines));
      const runner = registry.run.find((entry) => entry.id === "runner-pi")!;
      expect(runner.child_memory_limit_mb).toBe(512);
    }

    // --- a DOOR with no child limit still loads, in both shapes. The rule is
    //     about the entry that spawns a child and about nothing else.
    for (const lines of [machinelessLines(true), oneMachineLines(true)]) {
      const withoutRunner = lines.filter(
        (line, index) => index < lines.indexOf('id = "runner-pi"') - 1,
      );
      const registry = loadRegistry(write(withoutRunner));
      expect(registry.run.map((entry) => entry.id)).toEqual(["door-fake"]);
    }

    rmSync(dir, { recursive: true, force: true });
  },
  30_000,
);
