// 03b item 7. `check` cannot reach a service manager by ANY path. (SPEC §6,
// §7, L13)
//
// RED-RUN-2's stated residue: "`check` calling a manager by ABSOLUTE path is not
// caught. Check 22 runs `runCheck` in a subprocess whose PATH is fronted by
// shims that log every `launchctl` and `systemctl` invocation and refuse every
// mutating verb ... A build that spawned `/bin/launchctl` by its full path never
// meets the shim." PATH fronting can only ever catch a bare name, so the fence
// moves into the seam: the manager binary becomes a PARAMETER of `systemd()`
// and `launchd()` whose default is the bare name PATH resolves, `check` gets its
// seam from `thisOs(...)` and calls nothing else, and a check points that
// parameter at a recording shim BY ABSOLUTE PATH. A `check` that reached the
// real manager by any route then leaves the shim's log empty while its findings
// still come back, which is a difference no PATH trick can hide.
//
// The second half is a source-level assertion, allowed under "no test that
// cannot fail" because it CAN fail and does today: no file under `src/check/`
// carries the string `launchctl` or `systemctl`. It is not a style rule. Every
// manager name in `check` is a name `check` could invoke, and the one place the
// difference cannot be observed from outside is a string that was built in the
// right place for the wrong reason. Today `src/check/run.ts` builds both the
// start command for a missing unit and the journal command for a crash loop
// itself, so both names are in it.
//
// Red reasons. Test 1: behaviour absent, `src/os/index.ts`, `src/os/launchd.ts`
// and `src/os/systemd.ts` take no `bin`, so a seam built with one still spawns
// the real manager by bare name and the shim's log comes back EMPTY. Test 2:
// behaviour absent, `src/check/run.ts` contains `launchctl kickstart` and
// `systemctl --user start` in its own fix text.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hubPath, startCluster, seam, type Cluster } from "./helpers/cluster.ts";
import { osGate, gateSuffix, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { managerShim } from "./helpers/manager-shim.ts";
import { managerState, livePid, pidAlive } from "./helpers/manager.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";
import { stageHub, superStore } from "./helpers/hub-fixture.ts";
import type { Finding } from "./helpers/finding.ts";

const SLOW = 150_000;

let cluster: Cluster;
const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];

beforeAll(async () => {
  announceGate(gate, "03b item 7, check reaches no manager but the seam it was handed");
  cluster = await startCluster();
  if (gate.ok) foreignBefore = (await fixture.foreignWatched()).sort();
});

afterAll(async () => {
  try {
    await fixture.removeAll();
  } finally {
    if (gate.ok) {
      const after = (await fixture.listWatched()).sort();
      if (JSON.stringify(after) !== JSON.stringify(foreignBefore)) {
        throw new Error(
          `this file disturbed the box: watch-prefix units were\n${foreignBefore.join(", ")}\nand are now\n${after.join(", ")}`,
        );
      }
    }
    if (cluster) await cluster.stop();
  }
});

test.skipIf(!gate.ok)(
  `RUN-04 check speaks to the manager the seam names and to no other: with the seam's binary pointed at a recording shim by ABSOLUTE path, the run's findings still name the planted stray, every question the shim was asked is a reading one, nothing mutating was asked at all, and the stray is still running under the same pid (SPEC §6, §7, L13, D-90)${gateSuffix(gate)}`,
  async () => {
    const { thisOs } = await seam("src/os/index.ts");
    expect(typeof thisOs).toBe("function");
    const { runCheck } = await seam("src/check/run.ts");
    const check = runCheck as (options: Record<string, unknown>) => Promise<Finding[]>;

    const machine = thisMachine();
    const shim = managerShim();
    const stray = await fixture.plantStray();
    const strayPid = livePid(stray.base);
    expect(strayPid).not.toBeNull();
    expect(pidAlive(strayPid)).toBe(true);

    const it = await stageHub(cluster, {
      machines: [machine],
      run: [
        {
          id: "runner-here",
          kind: "runner",
          machine: machine.id,
          schedule: "always",
          memory_limit_mb: 512,
          child_memory_limit_mb: 512,
        },
      ],
    });
    const store = await superStore(cluster, it.db);
    try {
      // The seam, built with the manager named BY ABSOLUTE PATH. A build that
      // ignores the parameter spawns the real binary and this log stays empty.
      const os = (thisOs as Function)({
        unitDir: fixture.unitDir(),
        bin: shim.here(),
      });

      const findings = await check({
        machine: machine.id,
        registryFile: it.registryFile,
        store,
        os,
        kernel: null,
      });

      // --- IT REALLY DID THE WORK. The stray is in the findings, so what is
      //     asserted below is a run that read the manager and not one that fell
      //     over before it got there.
      const extras = findings.filter((one) => one.kind === "unit-extra");
      expect(extras.map((one) => one.subject).join(" ")).toContain(stray.base);

      // --- AND IT WENT THROUGH THE SEAM. Not one line means the seam's binary
      //     parameter was ignored and the real manager answered instead, which
      //     is exactly the hole PATH fronting cannot see.
      const asked = shim.lines();
      expect(asked.length).toBeGreaterThan(0);
      // Every question was a reading one. The shim refuses anything else, so a
      // `check` that tried to act would be here in `mutating()` AND would have
      // thrown out of the run above.
      expect(shim.mutating()).toEqual([]);
      for (const line of asked) {
        expect(line.startsWith(process.platform === "darwin" ? "launchctl" : "systemctl")).toBe(
          true,
        );
      }

      // --- and the stray is still the same process. This is the assertion that
      //     stands behind the log whatever route a build took (checks 4 and 7's
      //     rule, applied to the file that names the residue).
      expect(livePid(stray.base)).toBe(strayPid);
      expect(pidAlive(strayPid)).toBe(true);
      expect(managerState(stray.base)!.running).toBe(true);
    } finally {
      shim.remove();
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);

test(
  "RUN-04 no file under src/check names a service manager: the string launchctl and the string systemctl appear nowhere in it, because a name check can spell is a name check could invoke and the fix text a finding carries belongs to the OS seam that owns the flavour (SPEC §6, L13)",
  () => {
    const dir = hubPath("src/check");
    const files = readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((path) => statSync(path).isFile() && path.endsWith(".ts"));
    // The control: there IS a src/check to read, so an empty directory can
    // never pass this by accident.
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const name of ["launchctl", "systemctl"]) {
        if (!text.includes(name)) continue;
        const line = text.split("\n").findIndex((one) => one.includes(name)) + 1;
        offenders.push(`${file.slice(dir.length + 1)}:${line} names ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  },
  30_000,
);

// ---------------------------------------------------------------------------
// The third half, added by the Codex closure round (VERIFY-CODEX row 7).
//
// The shim check above proves `check` reached the manager through the seam it
// was HANDED on the run it made. What it cannot see is a helper somewhere under
// `src/os/` that reads the manager by absolute path IN ADDITION to the seam
// reads: the shim's log would still fill up, the planted stray would still be
// untouched, and both assertions above would pass. The `src/check/` string scan
// misses it too, because it reads one directory and no subdirectory.
//
// So this scans every `.ts` file under `src/`, recursively, for two things: the
// manager NAMES, and every process SPAWN. The property it binds is 03b item 7's
// own: there is exactly one way to invoke a service manager in this package,
// and it is the binary the seam factory was given.
//
// WHERE THE BOUNDARY REALLY IS, because the literal wording of row 7 ("the
// strings appear under `src/` only in the two seam factories' default-binary
// constants") cannot hold and should not:
//
//   - `src/os/diff.ts` returns `launchctl bootout ...` and `systemctl --user
//     reset-failed ...` as TEXT A HUMAN PASTES. D-105 pins those strings whole,
//     on the ground that a fix that does not run is worse than no fix, so they
//     cannot be assembled from parts and cannot move. They are in template
//     literals, they are returned, and nothing runs them.
//   - `src/os/launchd.ts` and `src/os/systemd.ts` each name their manager in a
//     doc comment and in one diagnostic sentence ("no user manager answers:
//     systemctl --user is-system-running said ..."), which is a message a
//     person reads when the gate refuses.
//
// A comment and a returned string cannot spawn anything. What CAN is a quoted
// literal that ends up as a binary, and a spawn's argv. Those are what is
// counted: the double- or single-quoted literal `"launchctl"` appears exactly
// ONCE under `src/`, on `launchd()`'s default-binary line, the same for
// `"systemctl"` in `systemd()`, and no spawn anywhere under `src/` carries
// either name in any spelling.

/** Every `.ts` file under `src/`, recursively, as repository-relative paths. */
function sourceFiles(): string[] {
  const root = hubPath("src");
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const here = join(dir, entry.name);
      if (entry.isDirectory()) walk(here);
      else if (entry.isFile() && here.endsWith(".ts")) out.push(here);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * The argument list of every `Bun.spawn(...)` and `Bun.spawnSync(...)` in a
 * file, as source text, by counting brackets from the opening parenthesis.
 *
 * Crude on purpose. It does not parse TypeScript, it reads what a spawn was
 * handed, and a spawn whose argv is built somewhere else is caught by the name
 * scan instead: the name has to be written down SOMEWHERE to be spawned.
 */
function spawnArguments(text: string): string[] {
  const out: string[] = [];
  const opener = /Bun\.spawn(?:Sync)?\s*\(/g;
  for (let found = opener.exec(text); found !== null; found = opener.exec(text)) {
    let depth = 0;
    let at = found.index + found[0].length - 1;
    const from = at;
    for (; at < text.length; at += 1) {
      const ch = text[at];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    out.push(text.slice(from, at + 1));
  }
  return out;
}

const MANAGERS = ["launchctl", "systemctl"] as const;

test(
  "RUN-04 and SPEC §7 there is exactly one way to invoke a service manager in this package: under src the quoted name launchctl appears once and only as launchd()'s default binary, systemctl once and only as systemd()'s, no file outside src/os names either at all, and no spawn anywhere under src carries either name in any spelling, so a helper that read a manager by absolute path beside the seam reads is caught by the source rather than by a log that would still be full (SPEC §6, §7, L13, D-105)",
  () => {
    const files = sourceFiles();
    // THE CONTROLS. A walk that found nothing, or that missed the two files
    // this is about, would pass everything below by accident.
    expect(files.length).toBeGreaterThan(20);
    const seamFiles = {
      launchctl: hubPath("src/os/launchd.ts"),
      systemctl: hubPath("src/os/systemd.ts"),
    };
    for (const path of Object.values(seamFiles)) expect(files).toContain(path);

    const text = new Map(files.map((path) => [path, readFileSync(path, "utf8")]));

    // --- 1. THE QUOTED NAME, once each, in the one file, on the one line.
    for (const name of MANAGERS) {
      const quoted: string[] = [];
      for (const [path, body] of text) {
        body.split("\n").forEach((line, nth) => {
          if (line.includes(`"${name}"`) || line.includes(`'${name}'`)) {
            quoted.push(`${path.slice(hubPath(".").length + 1)}:${nth + 1}: ${line.trim()}`);
          }
        });
      }
      expect(quoted.length).toBe(1);
      expect(quoted[0].startsWith(`src/os/${name === "launchctl" ? "launchd" : "systemd"}.ts:`)).toBe(
        true,
      );
      // And it IS the default-binary constant, not some other quoted use of the
      // name that happens to be alone in the file.
      expect(quoted[0]).toContain("options.bin ??");
    }

    // --- 2. NO SPAWN NAMES A MANAGER, in any spelling, anywhere under src.
    //     This is the one that catches `/bin/launchctl` and a name glued
    //     together out of a prefix and a variable at the call site.
    const spawns: string[] = [];
    for (const [path, body] of text) {
      for (const args of spawnArguments(body)) {
        for (const name of MANAGERS) {
          if (args.includes(name)) {
            spawns.push(`${path.slice(hubPath(".").length + 1)} spawns something naming ${name}`);
          }
        }
      }
    }
    expect(spawns).toEqual([]);
    // The control for that scan: it really does find the spawns it is reading.
    // `src/os/launchd.ts` has two, the seam's own and the memory reader's.
    expect(spawnArguments(text.get(seamFiles.launchctl)!).length).toBe(2);
    expect(spawnArguments(text.get(seamFiles.systemctl)!).length).toBe(1);
    expect(spawnArguments(text.get(seamFiles.systemctl)!)[0]).toContain("[bin, ...args]");

    // --- 3. NOTHING OUTSIDE src/os EVEN SPELLS ONE, which is the scan the
    //     `src/check/` one above widens: a helper anywhere else in the package
    //     that knew a manager's name would be a second place the fence has to
    //     be argued about.
    const osDir = hubPath("src/os") + "/";
    const strays: string[] = [];
    for (const [path, body] of text) {
      if (path.startsWith(osDir)) continue;
      for (const name of MANAGERS) {
        if (body.includes(name)) strays.push(`${path.slice(hubPath(".").length + 1)} names ${name}`);
      }
    }
    expect(strays).toEqual([]);

    // --- 4. AND INSIDE src/os, only the three files that have a reason:
    //     the two seam factories and the file that returns the commands a
    //     human pastes (D-105 pins those strings whole).
    const allowed = new Set([
      hubPath("src/os/launchd.ts"),
      hubPath("src/os/systemd.ts"),
      hubPath("src/os/diff.ts"),
    ]);
    const inside: string[] = [];
    for (const [path, body] of text) {
      if (!path.startsWith(osDir) || allowed.has(path)) continue;
      for (const name of MANAGERS) {
        if (body.includes(name)) inside.push(`${path.slice(hubPath(".").length + 1)} names ${name}`);
      }
    }
    expect(inside).toEqual([]);
  },
  30_000,
);
