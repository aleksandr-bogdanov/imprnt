// Check: running units minus the registry's set is empty and the reverse is
// empty. (SPEC §6, L13) - the arithmetic.
//
// L13: "`check` compares systemd's truth with the list: a running `imprnt-*`
// unit the registry does not imply is reported in red with the command to stop
// it, never stopped by a robot. A registry entry with no unit is reported."
// D-78 splits that in two: a unit under the RENDER prefix with no entry is one
// the hub itself generated and the registry no longer wants, so the hub removes
// it (`stale`), while a unit under the SCAN prefix only was never the hub's to
// write, so it is `check`'s to report and nobody's to touch (`extra`).
//
// PURE, BOTH PLATFORMS, NO GATE. A fake OS is allowed here and ONLY here,
// because this is arithmetic over a supplied list of `UnitState` and nothing
// about a real manager is being claimed. Check 4 makes the same assertions
// against the real launchd and the real systemd.
//
// WHAT THIS CHECK MAY NEVER ASSERT: that `extra` equals the set it planted. On
// the hub box `extra` also holds the live v2's units, which is L13's truth and
// not a bug, so containment is the only honest shape and the last case below
// asserts exactly that property.
//
// Red reason: import missing, src/os/diff.ts.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { writeRegistry, type RegistrySpec } from "./helpers/registry.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";

/** A `UnitState` as the seam pins it. */
function unitState(over: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "",
    loaded: true,
    running: true,
    pid: 4242,
    restarts: 0,
    lastExit: 0,
    since: "2026-09-15T00:00:00.000Z",
    ...over,
  };
}

/**
 * The entry id of a wanted unit as the diff handed it back.
 *
 * `diffUnits` returns elements of the `wanted` array it was given, and
 * 03-CONTEXT pins that array's element type by NAME (`WantedUnit`) without
 * pinning its fields. So the check builds each element as the run entry spread
 * together with its unit name and its wanted state, and reads a result back
 * through whichever of those a build kept.
 */
function idOf(w: Record<string, unknown>): string {
  if (typeof w.id === "string") return w.id;
  const entry = w.entry as { id?: string } | undefined;
  return String(entry?.id);
}

function stage(): { dir: string; registryFile: string } {
  const dir = mkdtempSync(join(tmpdir(), "hub-diff-"));
  const spec: RegistrySpec = {
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: dir },
    machines: [
      { id: "pi", os: "linux" },
      { id: "mac", os: "macos" },
    ],
    people: [{ id: "p1", tree: join(dir, "p1") }],
    presets: {
      daily: { adapter: "scripted", model: "m", provider: "p", effort: "medium", paid: "plan" },
    },
    agents: [
      { id: "p1-lair", person: "p1", preset: "daily", chat: "0000000000", door: "door-fake", runner: "runner-pi" },
    ],
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      { id: "watch-bikes", kind: "watcher", machine: "pi", schedule: "every 30m", memory_limit_mb: 128 },
      { id: "transcriber", kind: "transcriber", machine: "pi", schedule: "on demand", memory_limit_mb: 1024 },
    ],
  };
  return { dir, registryFile: writeRegistry(dir, spec) };
}

test(
  "RUN-04 running units minus the registry's set is empty and the reverse is empty: a listed entry with no unit and one that is loaded but stopped are both missing, a render-prefix unit with no entry is the hub's to remove, a watch-prefix stray is reported with the EXACT stop command as TEXT, and an on-demand or scheduled entry is not missing (SPEC §6, L13, D-78, D-97, D-105)",
  async () => {
    const { diffUnits, wantedState, stopCommand } = await seam("src/os/diff.ts");
    expect(typeof diffUnits).toBe("function");
    expect(typeof wantedState).toBe("function");
    expect(typeof stopCommand).toBe("function");
    const { unitName } = await seam("src/os/names.ts");
    expect(typeof unitName).toBe("function");

    const diff = diffUnits as (args: {
      wanted: Record<string, unknown>[];
      found: Record<string, unknown>[];
    }) => {
      missing: Record<string, unknown>[];
      stale: Record<string, unknown>[];
      extra: Record<string, unknown>[];
    };
    const name = unitName as (id: string) => string;
    const state = wantedState as (entry: unknown) => string;
    const stop = stopCommand as (flavour: string, unit: string) => string;

    const it = stage();
    try {
      const entries = listRunEntries(loadRegistry(it.registryFile));
      const wanted = entries.map((entry) => ({
        ...entry,
        entry,
        name: name(entry.id),
        unit: name(entry.id),
        state: state(entry),
      }));

      // --- the control, first: the criterion's own words, both sides empty.
      const healthy = [
        unitState({ name: `${name("door-fake")}.service`, running: true }),
        unitState({ name: `${name("runner-pi")}.service`, running: true }),
        // A scheduled entry's timer is loaded and its service is not running,
        // which is the wanted state and not a finding.
        unitState({ name: `${name("watch-bikes")}.timer`, running: true }),
        unitState({ name: `${name("watch-bikes")}.service`, running: false }),
        // An on demand entry is loaded and not running, on purpose.
        unitState({ name: `${name("transcriber")}.service`, running: false }),
      ];
      const untouched = JSON.stringify(healthy);

      const clean = diff({ wanted, found: healthy });
      expect(clean.missing).toEqual([]);
      expect(clean.stale).toEqual([]);
      expect(clean.extra).toEqual([]);

      // --- missing, in BOTH of its shapes, in one call.
      //     runner-pi has no unit at all. door-fake has one that is loaded and
      //     stopped, which a diff that only asked "does a file exist" calls
      //     present, and the household then hears nothing all day.
      const withMissing = diff({
        wanted,
        found: [
          unitState({ name: `${name("door-fake")}.service`, loaded: true, running: false, pid: null }),
          unitState({ name: `${name("watch-bikes")}.timer`, running: true }),
          unitState({ name: `${name("watch-bikes")}.service`, running: false }),
          unitState({ name: `${name("transcriber")}.service`, running: false }),
        ],
      });
      expect(withMissing.missing.map(idOf).sort()).toEqual(["door-fake", "runner-pi"]);
      // The two that make the three wanted states real. Without them the
      // transcriber and every timer are reported missing forever, and a
      // permanent finding is worse than no check.
      expect(withMissing.missing.map(idOf)).not.toContain("watch-bikes");
      expect(withMissing.missing.map(idOf)).not.toContain("transcriber");
      expect(withMissing.stale).toEqual([]);
      expect(withMissing.extra).toEqual([]);

      // --- stale: under the RENDER prefix, with no entry. The hub's to remove.
      const withStale = diff({
        wanted,
        found: [...healthy, unitState({ name: `${name("runner-that-left")}.service` })],
      });
      expect(withStale.stale.length).toBe(1);
      expect(String(withStale.stale[0].name)).toContain("runner-that-left");
      expect(withStale.extra).toEqual([]);
      expect(withStale.missing).toEqual([]);

      // --- extra: under the WATCH prefix ONLY. check's to report, nobody's to
      //     touch. The separation is the whole of D-78: a stray is never
      //     `stale`, so the hub never removes it, and that is L13's "never
      //     stopped by a robot" made structural rather than promised.
      const withStray = diff({
        wanted,
        found: [...healthy, unitState({ name: "imprnt-stray-abcd1234.service" })],
      });
      expect(withStray.extra.length).toBe(1);
      expect(String(withStray.extra[0].name)).toBe("imprnt-stray-abcd1234.service");
      expect(withStray.stale).toEqual([]);
      expect(withStray.missing).toEqual([]);

      // The command travels with it as TEXT, for both flavours, and nothing
      // runs it. THE WHOLE STRING IS BOUND, per D-105, because this is a `fix`
      // a human PASTES: a fragments match ("contains systemctl --user stop",
      // "contains the name") passes a command carrying an invalid option
      // between the two, and a fix that does not run is worse than no fix,
      // since L13 already forbids anything running it for them. The uid comes
      // from the running process because the pinned signature is
      // `stopCommand(flavour, unitName)` and there is nowhere else for it.
      const uid = process.getuid?.() ?? -1;
      expect(stop("systemd", "imprnt-stray-abcd1234.service")).toBe(
        "systemctl --user stop imprnt-stray-abcd1234.service",
      );
      expect(stop("launchd", "imprnt-stray-abcd1234")).toBe(
        `launchctl bootout gui/${uid}/imprnt-stray-abcd1234`,
      );
      // And a second name, so a build that returned one hard-coded string for
      // every unit fails rather than passing the one the check happened to ask.
      expect(stop("systemd", "imprnt-board.service")).toBe(
        "systemctl --user stop imprnt-board.service",
      );
      expect(stop("launchd", "imprnt-board")).toBe(`launchctl bootout gui/${uid}/imprnt-board`);

      // --- the hub box's own truth, asserted as a PROPERTY and never as a set.
      //     Ten unrelated imprnt-* units alongside the registry's own: every one
      //     is extra, and missing is still empty.
      const foreign = Array.from({ length: 10 }, (_, n) =>
        unitState({ name: `imprnt-v2-thing-${n}.service` }),
      );
      const crowded = diff({ wanted, found: [...healthy, ...foreign] });
      expect(crowded.missing).toEqual([]);
      expect(crowded.stale).toEqual([]);
      const reported = crowded.extra.map((e) => e.name);
      for (const one of foreign) expect(reported).toContain(one.name);
      expect(crowded.extra.length).toBeGreaterThanOrEqual(foreign.length);

      // --- and nothing the module was handed came back changed.
      expect(JSON.stringify(healthy)).toBe(untouched);
    } finally {
      rmSync(it.dir, { recursive: true, force: true });
    }
  },
  30_000,
);
