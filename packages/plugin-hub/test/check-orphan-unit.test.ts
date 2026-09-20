// A unit file the hub's own removal left behind is a finding.
// (SPEC §7, L13)
//
// `remove` disables a unit, then deletes its files, then stops it. A hub that
// dies between the disable and the delete leaves a file under the hub's own
// prefix that is enabled nowhere, that the manager may no longer list, and that
// no registry entry declares. Nothing reported it: `seenUnits` asks the manager
// only about entries the registry still carries, and `check` never read the
// unit directory. The operator found it by hand or never.
//
// A SCRATCH UNIT DIRECTORY AND A MANAGER THAT KNOWS NOTHING. An orphan is by
// definition a unit the manager does not know about, so nothing here loads,
// starts or asks the real manager anything. The seam is built with its unit
// directory pointed at a directory this file owns and its binary pointed at a
// stub that writes down every question and answers none. That also lets BOTH
// seams run on either box, because reading a directory is the same act on a Mac
// and on a Linux box.
//
// THE CONTROLS. A file the registry DOES declare is never reported, a scheduled
// entry's timer included, and a file under the watch prefix alone (the shape of
// a live v2 unit) is never reported as the hub's, because the fix this finding
// carries deletes a file.
//
// Red reason: behaviour absent. `check` reads no unit directory, so no
// `unit-file-orphaned` finding names the planted file.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { startCluster, seam, type Cluster } from "./helpers/cluster.ts";
import { hubReader, stageHub, superStore } from "./helpers/hub-fixture.ts";
import type { Finding } from "./helpers/finding.ts";
import { loadRegistry, type RunEntry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";

const SLOW = 120_000;
const KIND = "unit-file-orphaned";

// This file's own copy of the two prefixes, for the reason test/helpers/units.ts
// gives: an oracle that borrowed them from the code under test would agree with
// every build, including one that renamed the fence away.
const RENDER_PREFIX = "imprnt-hub-";
const WATCH_PREFIX = "imprnt-";

/** Every directory this file created, removed in `afterAll` whatever happened. */
const scratch: string[] = [];
let cluster: Cluster;

function hex(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

function ownDir(what: string): string {
  const dir = mkdtempSync(join(tmpdir(), what));
  scratch.push(dir);
  return dir;
}

/**
 * A manager that writes down every question it is asked and answers none: it
 * prints nothing and exits non-zero, which is a box whose manager has loaded
 * nothing of ours. A `check` that tried to act on a finding would show up here
 * as a verb that only asks nothing.
 */
function silentManager(): { bin: string; lines(): string[] } {
  const dir = ownDir("hub-orphan-mgr-");
  const log = join(dir, "asked.log");
  writeFileSync(log, "", "utf8");
  const bin = join(dir, "manager");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit 3\n`, "utf8");
  chmodSync(bin, 0o755);
  return {
    bin,
    lines: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
  };
}

/** The verbs that only ask. Anything else in the stub's log is `check` acting. */
const READING = new Set(["list", "list-units", "show", "print"]);

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  try {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  } finally {
    if (cluster) await cluster.stop();
  }
});

test(
  "RUN-04 and REVIEW S6 a unit file under the hub's own prefix that no registry entry declares is a check finding that names the file, on both seams: the declared entry's own files (a timer included) are never reported, a file under the watch prefix alone is never reported as the hub's, the run deletes nothing and asks the manager nothing but reading questions, and once the file is gone its row leaves the sheet (SPEC §7, L13, D-90)",
  async () => {
    const { osFor } = await seam("src/os/index.ts");
    expect(typeof osFor).toBe("function");
    const { runCheck, CHECK_SHEET } = await seam("src/check/run.ts");
    expect(typeof runCheck).toBe("function");
    const check = runCheck as (options: Record<string, unknown>) => Promise<Finding[]>;
    const seamFor = osFor as (
      platform: string,
      options: { unitDir: string; bin: string },
    ) => {
      flavour: string;
      render(entry: RunEntry, ctx: Record<string, unknown>): { path: string; text: string }[];
    };

    const declaredPi = `runner-${hex()}`;
    const declaredMac = `runner-mac-${hex()}`;
    const it = await stageHub(cluster, {
      machines: [
        { id: "pi", os: "linux" },
        { id: "mac", os: "macos" },
      ],
      run: [
        { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: "runner-test", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
        // Scheduled, so the systemd seam renders a service AND a timer for it
        // and the control covers both suffixes.
        { id: declaredPi, kind: "runner", machine: "pi", schedule: "every 5m", memory_limit_mb: 64, child_memory_limit_mb: 64 },
        { id: declaredMac, kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 64, child_memory_limit_mb: 64 },
      ],
    });
    const store = await superStore(cluster, it.db);
    const sheet = hubReader(cluster, it.db, String(CHECK_SHEET));
    // Every credential opens, so the run spends its time on the units and not on
    // probing a fixture's token file.
    const credentials = { open: async () => ({ ok: true }), secrets: async () => [] };
    try {
      const entries = listRunEntries(loadRegistry(it.registryFile));
      const cases = [
        { platform: "linux", flavour: "systemd", machine: "pi", declared: declaredPi, suffixes: [".service", ".timer"] },
        { platform: "darwin", flavour: "launchd", machine: "mac", declared: declaredMac, suffixes: [".plist"] },
      ];

      for (const one of cases) {
        const unitDir = ownDir("hub-orphan-units-");
        const manager = silentManager();
        const os = seamFor(one.platform, { unitDir, bin: manager.bin });
        expect(os.flavour).toBe(one.flavour);

        const ctx = {
          machine: one.machine,
          execPath: process.execPath,
          entryScript: join(it.stateDir, "never-run.ts"),
          registryFile: it.registryFile,
          restartDelaySeconds: 1,
          giveUpAfter: 3,
          giveUpWindowSeconds: 300,
        };

        // The declared control, rendered by the seam itself from the
        // registry's own entry, exactly as the hub would have written it.
        const declaredEntry = entries.find((entry) => entry.id === one.declared)!;
        expect(declaredEntry).toBeDefined();
        const declaredFiles = os.render(declaredEntry, ctx);

        // THE ORPHAN. What the hub rendered for an entry the registry no longer
        // carries, still on disk because the removal never reached its delete.
        // Scheduled, so on systemd it is a service and a timer, which is what a
        // dead hub leaves behind for a cadence entry.
        const orphanId = `orphan-${hex()}`;
        const orphanFiles = os.render({ ...declaredEntry, id: orphanId, schedule: "every 5m" }, ctx);

        // A file under the watch prefix alone: the shape of a live v2 unit,
        // which was never the hub's to write and must never be the hub's to
        // delete.
        const foreignName = `${WATCH_PREFIX}other-${hex()}${one.suffixes[0]}`;
        const foreign = join(unitDir, foreignName);

        for (const file of [...declaredFiles, ...orphanFiles]) writeFileSync(file.path, file.text, "utf8");
        writeFileSync(foreign, "a file this check planted and removes\n", "utf8");

        // THE FIXTURE IS WHAT IT CLAIMS, so a red below is the missing
        // behaviour and never a file that was not there.
        const orphanNames = orphanFiles.map((file) => basename(file.path)).sort();
        expect(orphanNames).toEqual(one.suffixes.map((suffix) => `${RENDER_PREFIX}${orphanId}${suffix}`).sort());
        const declaredNames = declaredFiles.map((file) => basename(file.path)).sort();
        expect(declaredNames).toEqual(one.suffixes.map((suffix) => `${RENDER_PREFIX}${one.declared}${suffix}`).sort());
        for (const file of [...declaredFiles, ...orphanFiles]) {
          expect(file.path.startsWith(unitDir)).toBe(true);
          expect(existsSync(file.path)).toBe(true);
        }
        expect(existsSync(foreign)).toBe(true);

        const findings = await check({
          machine: one.machine,
          registryFile: it.registryFile,
          store,
          os,
          kernel: null,
          credentials,
        });

        // --- THE FINDING, by name. One per file the orphan left, and no more.
        const orphans = findings.filter((finding) => finding.kind === KIND);
        expect(orphans.map((finding) => finding.subject).sort()).toEqual(orphanNames);
        for (const finding of orphans) {
          const path = join(unitDir, finding.subject);
          expect(finding.id).toBe(`${one.machine}/${KIND}:${finding.subject}`);
          expect(finding.machine).toBe(one.machine);
          // The line a human reads names the file, and the command a human
          // pastes names where it is.
          expect(finding.says).toContain(finding.subject);
          expect(finding.says).toContain(orphanId);
          expect(typeof finding.fix).toBe("string");
          expect(finding.fix).toContain(path);
        }

        // --- THE CONTROLS. The declared entry's files, and the file under the
        //     watch prefix alone, are named by no finding of this kind.
        const named = orphans.map((finding) => `${finding.subject} ${finding.says} ${finding.fix}`).join("\n");
        expect(named).not.toContain(one.declared);
        expect(named).not.toContain(foreignName);
        expect(orphans.map((finding) => finding.subject)).not.toContain(foreignName);
        for (const name of declaredNames) {
          expect(orphans.map((finding) => finding.subject)).not.toContain(name);
        }

        // --- A PURE READ. Every file is where it was, and the manager was
        //     asked nothing but reading questions.
        for (const file of [...declaredFiles, ...orphanFiles]) expect(existsSync(file.path)).toBe(true);
        expect(existsSync(foreign)).toBe(true);
        const acting = manager.lines().filter((line) => !line.split(/\s+/).some((word) => READING.has(word)));
        expect(acting).toEqual([]);

        // --- AND THE ROW IS THE SHEET'S. Standing now, gone once the operator
        // has removed the file: a fixed finding leaves no line.
        const standing = (await sheet.rows()).map((row) => row.id);
        for (const name of orphanNames) expect(standing).toContain(`${one.machine}/${KIND}:${name}`);

        for (const file of orphanFiles) rmSync(file.path, { force: true });
        const after = await check({
          machine: one.machine,
          registryFile: it.registryFile,
          store,
          os,
          kernel: null,
          credentials,
        });
        expect(after.filter((finding) => finding.kind === KIND)).toEqual([]);
        const left = (await sheet.rows()).map((row) => row.id);
        expect(left.filter((id) => id.startsWith(`${one.machine}/${KIND}:`))).toEqual([]);
      }
    } finally {
      await sheet.close().catch(() => {});
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
