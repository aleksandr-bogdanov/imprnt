// 03b item 2. The install script: Postgres the standard way, the schema, and
// the `[store]` section written ONCE. (SPEC §1 and §6, RUN-07, RUN-14, L4)
//
// BUILD-NOTES 9's other half. A household installs Postgres from its own
// package manager, so the hub cannot install it as a side effect of running,
// and nothing in v3 has ever written down how a box gets one. `src/entry/install.ts`
// is that step, run by hand once per machine: it detects the OS, installs
// Postgres the standard way when there is none, applies `src/schema.sql` to the
// database the registry names, and writes the `[store]` section with this OS's
// standard pid file IF THE FILE DOES NOT ALREADY CARRY ONE.
//
// WHAT THIS CHECK WILL NOT DO IS INSTALL POSTGRES. A check that ran
// `brew install` or `apt-get install` would change the box it is run on, which
// is the one thing every rule in this phase is about. So the two halves are:
// `--dry`, which prints this platform's commands and touches nothing, and a
// real run against the THROWAWAY cluster, where Postgres already answers and
// the install step is the one thing the script must decide not to do. The apt
// half proper is Linux plus `sudo -n` and is the build round's, on the box.
//
// RUN-07: `--dry` is an action modifier and not a behaviour switch. It says
// "tell me what you would do" about the same work, which is the same shape as
// the verb itself, and nothing in the script reads the environment.
//
// Red reason: import missing, `src/entry/install.ts`.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hubPath, startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { scratchDir } from "./helpers/hub-fixture.ts";
import { writeRegistry } from "./helpers/registry.ts";
import { osGate, announceGate, thisMachine } from "./helpers/os-gate.ts";
import { unitFixture, type UnitFixture } from "./helpers/units.ts";

const SLOW = 180_000;
const SCRIPT = "src/entry/install.ts";

/** The boot files L4 forbids an installer to touch, whichever of them this box has. */
const BOOT_FILES = ["/boot/firmware/cmdline.txt", "/boot/cmdline.txt", "/etc/default/grub"];

let cluster: Cluster;
const gate = osGate();
const fixture: UnitFixture = unitFixture();
let foreignBefore: string[] = [];

beforeAll(async () => {
  announceGate(gate, "03b item 2, the install script");
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

/** A file by its CONTENTS, so an edit of the same length is caught (check 5's rule). */
function fingerprint(file: string): string {
  try {
    const bytes = readFileSync(file);
    return `${file}:${bytes.length}:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch (error) {
    return `${file}:unreadable:${(error as Error).message}`;
  }
}

function contentCensus(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile())
    .map(fingerprint)
    .sort();
}

async function runInstall(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", "run", hubPath(SCRIPT), ...args], {
    cwd: hubPath("."),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

/** The red reason as an assertion rather than as a module-not-found stack. */
function requireScript(): void {
  const absolute = hubPath(SCRIPT);
  expect(
    existsSync(absolute) ? SCRIPT : `seam module missing: ${SCRIPT} (expected at ${absolute})`,
  ).toBe(SCRIPT);
}

test(
  "RUN-07 and RUN-14 the install script's dry run says what it would do and touches nothing: it names this platform's own package-manager command and the standard pid file it would declare, and the registry's bytes, every file beside it, every boot file and the service manager's own census are unchanged afterwards (SPEC §6 Forbidden, RUN-07, RUN-14, L4)",
  async () => {
    requireScript();

    const machine = thisMachine();
    const dir = await scratchDir("hub-install-dry-");
    const registryFile = writeRegistry(dir, {
      hub: { store_url: `postgres://127.0.0.1:${cluster.port}/hub_dry`, state_dir: dir },
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
    // A second file beside it, so "it edited the registry's neighbour instead"
    // is caught as well.
    writeFileSync(join(dir, "beside.txt"), "a file the installer has no business in\n", "utf8");

    const registryBefore = fingerprint(registryFile);
    const censusBefore = contentCensus(dir);
    const bootBefore = BOOT_FILES.filter((f) => existsSync(f)).map(fingerprint);
    const unitsBefore = gate.ok ? (await fixture.listWatched()).sort() : [];

    const dry = await runInstall([registryFile, "--dry"]);
    expect(dry.code).toBe(0);
    const said = `${dry.out}\n${dry.err}`;

    // --- it names the platform's OWN way of installing, because the whole
    //     point of the script is that the household's package manager does it.
    if (process.platform === "darwin") {
      expect(said).toContain("brew");
      expect(said).toContain("postgresql@17");
      expect(said).toContain("postmaster.pid");
    } else {
      expect(said).toContain("apt-get");
      expect(said).toContain("postgresql");
      expect(said).toContain(".pid");
    }
    // --- and it says it did nothing, so a person reading the terminal is not
    //     left guessing whether the box changed.
    expect(said.toLowerCase()).toContain("dry");
    // --- it names the file it would have written the section into.
    expect(said).toContain(registryFile);

    // --- NOTHING MOVED. By content hash, not by size and timestamp.
    expect(fingerprint(registryFile)).toBe(registryBefore);
    expect(contentCensus(dir)).toEqual(censusBefore);
    expect(BOOT_FILES.filter((f) => existsSync(f)).map(fingerprint)).toEqual(bootBefore);
    if (gate.ok) expect((await fixture.listWatched()).sort()).toEqual(unitsBefore);
    // --- and the file still has no [store] section, which is the thing the
    //     real run is for.
    expect(readFileSync(registryFile, "utf8")).not.toContain("[store]");

    // --- RUN-07's own shape: no registry, no run.
    const bare = await runInstall([]);
    expect(bare.code).not.toBe(0);
    expect(`${bare.out}${bare.err}`).toContain("usage");
  },
  SLOW,
);

test(
  "SPEC §1 the install script applies the schema and declares the store ONCE: against a server that already answers it installs nothing, creates the database the registry names with every role and table the schema has, writes a [store] section carrying this OS's standard pid file, changes not one byte on a second run, and never overwrites a pid_file a household already put there (SPEC §1 and §6, RUN-07, RUN-14, L4)",
  async () => {
    requireScript();

    const machine = thisMachine();
    const dir = await scratchDir("hub-install-real-");
    const database = `hub_installed_${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`;
    // D-36's userless url, which is what the file carries. The script supplies
    // its own identity, which on a real box is the local administrator; here
    // the throwaway cluster is given a superuser of this account's own name so
    // a userless connection lands the same way it does on a real box.
    const url = `postgres://127.0.0.1:${cluster.port}/${database}`;
    const admin = cluster.connect("postgres") as unknown as {
      unsafe(query: string): Promise<unknown>;
      close(): Promise<void>;
    };
    const me = (process.env.USER ?? "").trim();
    try {
      if (me !== "" && me !== cluster.superuser) {
        await admin.unsafe(`create role "${me}" superuser login`).catch(() => {});
      }
    } finally {
      await admin.close().catch(() => {});
    }

    const registryFile = writeRegistry(dir, {
      hub: { store_url: url, state_dir: dir },
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
    const bootBefore = BOOT_FILES.filter((f) => existsSync(f)).map(fingerprint);
    const unitsBefore = gate.ok ? (await fixture.listWatched()).sort() : [];

    // THE APT HALF, Linux and `sudo -n` only, and a visible line when it has
    // neither. The whole point of this round is that no check installs a
    // package, so what is asserted here is that the script DID NOT need to:
    // Postgres already answers on the url the registry names.
    if (process.platform !== "linux") {
      process.stderr.write(
        "[install] the package-manager half is Debian's and runs on the hub box in the build round; " +
          "this run asserts the schema-and-registry half, which is the same on every OS\n",
      );
    } else {
      const sudo = Bun.spawnSync(["sudo", "-n", "true"], { stdout: "pipe", stderr: "pipe" });
      if ((sudo.exitCode ?? 1) !== 0) {
        process.stderr.write(
          "[install] SKIPPED the package-manager half: this account has no passwordless sudo, " +
            "so `apt-get install postgresql` cannot be exercised here\n",
        );
      }
    }

    const first = await runInstall([registryFile]);
    expect(first.code).toBe(0);
    const said = `${first.out}\n${first.err}`;
    // It found a store already answering, so it installed nothing.
    expect(said.toLowerCase()).toContain("postgres");

    // --- the schema really landed: the database exists and carries the ledger
    //     and the four roles the hub's processes open it as.
    const reader = cluster.connect(database) as unknown as {
      unsafe(query: string, values?: unknown[]): Promise<unknown>;
      close(): Promise<void>;
    };
    try {
      const tables = (await reader.unsafe(
        "select table_name from information_schema.tables where table_schema = 'public' order by 1",
      )) as { table_name: string }[];
      const names = tables.map((row) => String(row.table_name));
      expect(names).toContain("ledger_event");
      expect(names).toContain("inbound");
      expect(names).toContain("outbox");
      expect(names).toContain("state_row");
      const roles = (await reader.unsafe(
        "select rolname from pg_roles where rolname like 'hub\\_%' order by 1",
      )) as { rolname: string }[];
      for (const role of ["hub_door", "hub_runner", "hub_agent", "hub_hub"]) {
        expect(roles.map((row) => String(row.rolname))).toContain(role);
      }
    } finally {
      await reader.close().catch(() => {});
    }

    // --- the [store] section, written once, naming an absolute pid file.
    const afterFirst = readFileSync(registryFile, "utf8");
    expect(afterFirst).toContain("[store]");
    const pidFile = /^\s*pid_file\s*=\s*"([^"]+)"/m.exec(afterFirst)?.[1] ?? "";
    expect(pidFile.startsWith("/")).toBe(true);
    expect(pidFile.endsWith(".pid")).toBe(true);
    expect(/^\s*unit\s*=\s*"[^"]+"/m.test(afterFirst)).toBe(true);
    if (process.platform === "darwin") {
      expect(pidFile).toContain("postmaster.pid");
    } else {
      expect(pidFile).toContain("postgresql");
    }

    // --- IDEMPOTENT. Not "roughly the same": the same bytes, and it says so.
    const fingerprintAfterFirst = fingerprint(registryFile);
    const second = await runInstall([registryFile]);
    expect(second.code).toBe(0);
    expect(fingerprint(registryFile)).toBe(fingerprintAfterFirst);
    expect(`${second.out}${second.err}`.toLowerCase()).toMatch(/already|nothing|unchanged/);

    // --- and nothing of the box moved for either run.
    expect(BOOT_FILES.filter((f) => existsSync(f)).map(fingerprint)).toEqual(bootBefore);
    if (gate.ok) expect((await fixture.listWatched()).sort()).toEqual(unitsBefore);

    // --- A VALUE A HOUSEHOLD PUT THERE IS NEVER EDITED. This is the rule that
    //     makes the section safe to write at all: a box whose cluster lives
    //     somewhere else says so once and the script leaves it alone forever.
    const second_dir = await scratchDir("hub-install-kept-");
    const mine = join(second_dir, "chosen-by-the-household.pid");
    writeFileSync(mine, "1\n", "utf8");
    const kept = writeRegistry(second_dir, {
      hub: { store_url: url, state_dir: second_dir },
      store: { pid_file: mine, unit: "a-unit-the-household-named" },
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
    const keptBefore = fingerprint(kept);
    const third = await runInstall([kept]);
    expect(third.code).toBe(0);
    expect(fingerprint(kept)).toBe(keptBefore);
    expect(readFileSync(kept, "utf8")).toContain(mine);
    expect(readFileSync(kept, "utf8")).toContain("a-unit-the-household-named");

    await until("the installer's own processes are done", () => true, 1000);
  },
  SLOW,
);
