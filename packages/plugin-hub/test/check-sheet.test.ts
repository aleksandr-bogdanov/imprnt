// SPEC §7. `check` is a state sheet: one row per finding id, edited in place, a
// gone finding's row removed.
//
// L17 rules that a state sheet answers "what is true now": one row per id,
// edited in place, a gone thing's row removed, and no fixed or superseded line
// and no dated sections. D-90 makes the finding id MACHINE-SCOPED
// (`<machine>/<kind>:<subject>`), because two machines write findings into one
// store and `kernel-earlyoom` from both would otherwise be one row that each
// overwrites, and a run on one machine removes only rows under its own prefix.
//
// SUPPLIED INPUTS, NO OS AND NO GATE. What is under test here is the RECORD, not
// the manager, so the unit list comes from a fake seam and the kernel view is
// planted. Checks 4, 7, 21 and 23 bind the same findings against the real
// managers.
//
// NOTHING IS EXECUTED, and that is asserted rather than promised: every
// condition the run was handed is unchanged after it, and every finding's `fix`
// is a string. `check` reports. It does not act, which is L13's "never stopped
// by a robot" made structural.
//
// NOTHING IS SPAWNED BEHIND IT EITHER. The seam's recording verbs see only
// calls made through the seam, so the last case runs the same `runCheck` in a
// child whose PATH begins with a `launchctl` and a `systemctl` that log every
// invocation. STATED RESIDUE: a build that spawned `/bin/launchctl` by its
// absolute path never meets the shim. What stands behind that is behavioural
// and path-independent, in checks 4 and 7, where the planted stray is still
// running with the SAME pid after the diff and the reconcile were read.
//
// Red reason: import missing, src/check/run.ts.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster, hubPath, seam, type Cluster } from "./helpers/cluster.ts";
import { hubReader, stageHub, superStore } from "./helpers/hub-fixture.ts";
import type { Finding } from "./helpers/finding.ts";

const SLOW = 120_000;

/**
 * A scratch directory holding a `launchctl` and a `systemctl` that log every
 * invocation and refuse every mutating verb.
 *
 * Fronting PATH with it is the only way a check can see a manager command that
 * a `check` implementation ran ITSELF rather than through the seam it was
 * handed, which is the hole the second seat found in this file.
 */
function shimDir(): { dir: string; log: string; lines(): string[]; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "hub-shim-"));
  const log = join(dir, "invocations.log");
  writeFileSync(log, "", "utf8");
  for (const name of ["launchctl", "systemctl"]) {
    const real = Bun.spawnSync(["/usr/bin/which", name], { stdout: "pipe", stderr: "pipe" });
    const path = (real.stdout?.toString() ?? "").trim().split("\n")[0];
    const forward =
      path && existsSync(path)
        ? `case "$1" in\n  print|list|show|status|cat|is-active|is-enabled|is-system-running|list-units|list-timers|list-unit-files|--user)\n    exec ${path} "$@" ;;\nesac\n`
        : "";
    const file = join(dir, name);
    writeFileSync(
      file,
      `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> ${JSON.stringify(log)}\n${forward}exit 1\n`,
      "utf8",
    );
    chmodSync(file, 0o755);
  }
  return {
    dir,
    log,
    lines: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== ""),
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** `runCheck` in a child whose PATH begins with the shims. */
async function checkInSubprocess(args: {
  registryFile: string;
  machine: string;
  storeUrl: string;
  kernel: unknown;
  unitDir: string;
  shims: string;
}): Promise<{ ok: boolean; error?: string; findings?: unknown[]; control?: string }> {
  const proc = Bun.spawn(
    [
      "bun",
      "run",
      hubPath("test/helpers/check-subprocess.ts"),
      args.registryFile,
      args.machine,
      args.storeUrl,
      JSON.stringify(args.kernel),
      args.unitDir,
    ],
    {
      cwd: hubPath("."),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, PATH: `${args.shims}:${process.env.PATH ?? ""}` },
    },
  );
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  const line = out.split("\n").find((l) => l.trim().startsWith("{"));
  if (!line) {
    throw new Error(
      `test/helpers/check-subprocess.ts printed no line. stdout: ${out.trim()} stderr: ${err.trim()}`,
    );
  }
  return JSON.parse(line) as { ok: boolean; error?: string; findings?: unknown[]; control?: string };
}

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

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
 * A seam over a supplied unit list. Allowed here and only here, because what is
 * under test is the record. Every mutating verb throws, so a `check` that tried
 * to act on a finding fails loudly instead of quietly doing it.
 */
function fakeOs(units: Record<string, unknown>[]) {
  const acted: string[] = [];
  const refuse = (verb: string) => async (...args: unknown[]) => {
    acted.push(`${verb}(${args.map(String).join(", ")})`);
    throw new Error(`check called ${verb}, and check never acts on a finding`);
  };
  return {
    acted,
    seam: {
      flavour: "systemd" as const,
      render: () => {
        acted.push("render");
        throw new Error("check called render, and check never acts on a finding");
      },
      install: refuse("install"),
      remove: refuse("remove"),
      start: refuse("start"),
      stop: refuse("stop"),
      restart: refuse("restart"),
      async list() {
        return units.map((u) => ({ ...u }));
      },
      async show(entryId: string) {
        return units.find((u) => String(u.name).startsWith(`imprnt-hub-${entryId}`)) ?? null;
      },
      async memory() {
        return { current_bytes: 1024, peak_bytes: null, source: "ps-rss" as const };
      },
      async available() {
        return { ok: true, reason: "" };
      },
    },
  };
}

const UNHEALTHY_KERNEL = {
  cmdline: "console=tty1 root=PARTUUID=deadbeef-02 rootwait",
  controllers: ["cpu", "pids"],
  earlyoom: "absent" as const,
};
const HEALTHY_KERNEL = {
  cmdline: "console=tty1 rootwait cgroup_enable=memory cgroup_memory=1",
  controllers: ["cpu", "memory", "pids"],
  earlyoom: "active" as const,
};

test(
  "RUN-04 check is a state sheet: one row per finding id, the same run twice leaves the same ids with a moved updated_at, a fixed condition's row is GONE rather than marked fixed, two machines' rows never collide even on the same finding kind, a machine's run removes only its own, and nothing is executed through the seam OR spawned behind it, proved in a child whose PATH is fronted by managers that log every invocation (SPEC §7, L13, L17, D-90)",
  async () => {
    const { CHECK_SHEET, runCheck, findingId } = await seam("src/check/run.ts");
    expect(typeof runCheck).toBe("function");
    expect(typeof findingId).toBe("function");
    expect(typeof CHECK_SHEET).toBe("string");

    const check = runCheck as (options: Record<string, unknown>) => Promise<Finding[]>;
    const idFor = findingId as (machine: string, kind: string, subject?: string) => string;

    const it = await stageHub(cluster, {
      machines: [
        { id: "pi", os: "linux" },
        { id: "mac", os: "macos" },
      ],
      run: [
        { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: "runner-test", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
        { id: "runner-mac", kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ],
    });
    const store = await superStore(cluster, it.db);
    const sheet = hubReader(cluster, it.db, String(CHECK_SHEET));
    try {
      // The finding id's own shape, so a build that scoped it differently is
      // caught before any of the rest is read.
      expect(idFor("pi", "unit-extra", "imprnt-board.service")).toBe(
        "pi/unit-extra:imprnt-board.service",
      );
      expect(idFor("pi", "kernel-earlyoom")).toBe("pi/kernel-earlyoom");

      // --- conditions that produce several kinds at once. door-fake is
      //     running, runner-test is not (unit-missing), a stray is loaded
      //     (unit-extra), no peak is on record (peak-missing), and the kernel
      //     view lacks both boot words and earlyoom.
      const units = [
        unitState({ name: "imprnt-hub-door-fake.service", running: true }),
        unitState({ name: "imprnt-stray-abcd1234.service", running: true }),
      ];
      const os = fakeOs(units);
      const supplied = JSON.stringify(units);

      const first = await check({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: os.seam,
        kernel: UNHEALTHY_KERNEL,
      });
      const kinds = new Set(first.map((f) => f.kind));
      expect(kinds.has("unit-missing")).toBe(true);
      expect(kinds.has("unit-extra")).toBe(true);
      expect(kinds.has("peak-missing")).toBe(true);
      expect(kinds.has("kernel-memory-cgroup")).toBe(true);
      expect(kinds.has("kernel-earlyoom")).toBe(true);

      // --- one row per id.
      const ids = first.map((f) => f.id).sort();
      expect(new Set(ids).size).toBe(ids.length);
      expect((await sheet.rows()).map((r) => r.id).sort()).toEqual(ids);

      // --- edited in place. The same inputs again: the same ids, the same row
      //     count, and updated_at moved. A `check` that appended a dated section
      //     every run would be a diary wearing a state sheet's name, which is
      //     the exact confusion L17 exists to end.
      const stamps = new Map(
        (await sheet.rows()).map((r) => [r.id, new Date(r.updated_at).getTime()]),
      );
      await Bun.sleep(30);
      const second = await check({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: os.seam,
        kernel: UNHEALTHY_KERNEL,
      });
      expect(second.map((f) => f.id).sort()).toEqual(ids);
      const again = await sheet.rows();
      expect(again.length).toBe(ids.length);
      for (const row of again) {
        expect(new Date(row.updated_at).getTime()).toBeGreaterThan(stamps.get(row.id)!);
      }

      // --- a gone finding leaves NO LINE. Not marked fixed, not superseded.
      const kernelId = idFor("pi", "kernel-earlyoom");
      expect(again.some((r) => r.id === kernelId)).toBe(true);
      const third = await check({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: os.seam,
        kernel: HEALTHY_KERNEL,
      });
      expect(third.map((f) => f.kind)).not.toContain("kernel-earlyoom");
      expect(third.map((f) => f.kind)).not.toContain("kernel-memory-cgroup");
      const afterFix = await sheet.rows();
      expect(afterFix.some((r) => r.id === kernelId)).toBe(false);
      expect(afterFix.some((r) => r.id === idFor("pi", "kernel-memory-cgroup"))).toBe(false);
      // The ones that still apply are still there.
      expect(afterFix.some((r) => r.id.startsWith("pi/unit-extra"))).toBe(true);

      // --- machine-scoped ids. The mac runs against the SAME store, with a
      //     condition of the SAME kind, and neither erases the other's row.
      const piRows = (await sheet.rows()).map((r) => r.id);
      const macOs = fakeOs([
        unitState({ name: "imprnt-stray-99887766.service", running: true }),
      ]);
      const macFindings = await check({
        machine: "mac",
        registryFile: it.registryFile,
        store,
        os: macOs.seam,
        kernel: UNHEALTHY_KERNEL,
      });
      for (const finding of macFindings) {
        expect(finding.id.startsWith("mac/")).toBe(true);
        expect(finding.machine).toBe("mac");
      }
      expect(macFindings.map((f) => f.kind)).toContain("unit-extra");

      const mixed = (await sheet.rows()).map((r) => r.id);
      // Every pi row that stood before the mac's run still stands: a run on one
      // machine removes only rows under its OWN prefix.
      for (const id of piRows) expect(mixed).toContain(id);
      expect(mixed.some((id) => id.startsWith("mac/"))).toBe(true);
      // And the same kind on two machines is two rows, not one.
      const extras = mixed.filter((id) => id.includes("unit-extra"));
      expect(extras.some((id) => id.startsWith("pi/"))).toBe(true);
      expect(extras.some((id) => id.startsWith("mac/"))).toBe(true);

      // --- NOTHING WAS EXECUTED. Every mutating verb of the seam throws, and
      //     none was reached. The units the run was handed are unchanged, and
      //     every finding carries a fix that is text.
      expect(os.acted).toEqual([]);
      expect(macOs.acted).toEqual([]);
      expect(JSON.stringify(units)).toBe(supplied);
      for (const finding of [...first, ...second, ...third, ...macFindings]) {
        expect(typeof finding.fix).toBe("string");
        expect(finding.fix.length).toBeGreaterThan(0);
        expect(typeof finding.says).toBe("string");
        expect(finding.says.length).toBeGreaterThan(0);
      }
      // The stop command travels with the stray as TEXT, and the stray is still
      // in the list it was handed.
      const stray = first.find((f) => f.kind === "unit-extra")!;
      expect(stray.fix).toContain("imprnt-stray-abcd1234");
      expect(units.some((u) => u.name === "imprnt-stray-abcd1234.service")).toBe(true);

      // --- a null os skips the OS-shaped findings and everything else runs, so
      //     `check` works on a box with no manager at all.
      const headless = await check({
        machine: "pi",
        registryFile: it.registryFile,
        store,
        os: null,
        kernel: UNHEALTHY_KERNEL,
      });
      expect(headless.map((f) => f.kind)).not.toContain("unit-extra");
      expect(headless.map((f) => f.kind)).not.toContain("unit-missing");
      expect(headless.map((f) => f.kind)).toContain("peak-missing");
      expect(headless.map((f) => f.kind)).toContain("kernel-earlyoom");

      // --- AND NOTHING WAS RUN, either. Everything above observes calls made
      //     THROUGH the seam this test supplied, which is the second seat's
      //     hole: a `check` that spawned `launchctl bootout` itself, or caught
      //     the seam's exception and then shelled out, passes all of it. So the
      //     same `runCheck` runs in a child whose PATH begins with a directory
      //     holding a `launchctl` and a `systemctl` that log their argv and
      //     refuse every mutating verb. It is handed NO seam at all, so on a
      //     box with no manager nothing of ours has any business invoking one:
      //     the log must carry the child's own control line and nothing else.
      const shims = shimDir();
      try {
        const ran = await checkInSubprocess({
          registryFile: it.registryFile,
          machine: "pi",
          storeUrl: cluster.url(it.db),
          kernel: UNHEALTHY_KERNEL,
          unitDir: "-",
          shims: shims.dir,
        });
        if (!ran.ok) throw new Error(String(ran.error));
        // The findings are the same ones, so this is the real function doing
        // its real work and not a run that fell over early.
        expect((ran.findings ?? []).map((f) => (f as Finding).kind)).toContain("peak-missing");

        const invocations = shims.lines();
        // The control line proves the fronting applied. Without it an empty log
        // reads the same whether nothing was invoked or PATH never took effect.
        expect(invocations.length).toBeGreaterThanOrEqual(1);
        expect(invocations[0].startsWith(process.platform === "darwin" ? "launchctl" : "systemctl")).toBe(
          true,
        );
        // And that control line is the ONLY one. `check` with no seam invoked
        // no manager at all, mutating or otherwise.
        expect(invocations.slice(1)).toEqual([]);
      } finally {
        shims.remove();
      }
    } finally {
      await sheet.close().catch(() => {});
      await store.close().catch(() => {});
      await it.stop();
    }
  },
  SLOW,
);
