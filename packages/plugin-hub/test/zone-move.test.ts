// Check: sharing a note is the CORE's own `imprnt vault move`, run by the agent
// inside its own box, and after both syncs the other person's agent reads it
// while a private note of the first person stays unreadable.
// (SPEC §1, §6, L7, ROLL-27)
//
// THE VERB IS THE CORE'S AND THE HUB IMPLEMENTS NO HALF OF IT. The move, its
// refusals, the link rewrite, the mover's two step log line and the seam
// findings all live in the vault CLI, which `imprnt check` also reads by. A hub
// copy would be a second implementation of one verb, and the two would drift
// until a note the hub moved was a note the core condemned. So this check
// spawns the household's own `imprnt` as a child and asserts, separately, that
// nothing under `src/` carries a half of it.
//
// NO HUB GRANT IS INVOLVED. The boundary is the person, the mount is a checkout
// inside that person's own tree, and an ordinary turn already writes that tree.
// The context handed to the move is compared whole against the one an ordinary
// turn gets, so a build that widened the box to make this work fails here.
//
// WHO COMMITS: the person. `runSync` refuses a dirty tree and never commits, so
// a move leaves work standing on BOTH sides of the seam, the note in the zone
// checkout and the deleted source plus the log line in the vault, and the
// person commits both before anything is shared. That is asserted rather than
// only done, because the next reader will assume the sync handles it.
//
// TWO REDS, AND THEY ARE DIFFERENT FACTS. The core's verb is shipped and works,
// so what was red here first was the SCENE: `zoneStage({ provision: true })`
// calls the install stage, so before that stage existed this file failed at
// setup with a named reason. The cross-person reads are red for BEHAVIOUR in
// the sense that matters: without a provisioned household there is nothing in
// the second person's vault to read.
//
// THE BOXED HALVES ARE GATED on the box tool, with the reason in the test name,
// and the unboxed control runs everywhere.
//
// NO REAL VAULT IS NAMED, READ OR WRITTEN. Every vault is made by the real
// `imprnt init` under a scratch directory with `XDG_CONFIG_HOME` pointed inside
// it, and every remote is a local bare repository.
//
// Which of the six protected windows this could reach: none. No door, no
// runner, no hub tick.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshDatabase, hubPath, seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import { storeReader, superStore, userlessStoreUrl } from "./helpers/hub-fixture.ts";
import { boxGate } from "./helpers/box-gate.ts";
import { fixtureGit } from "./helpers/rollout-git.ts";
import { withAmbient } from "./helpers/rollout-loop.ts";
import { zoneStage, THIS_MACHINE, type ZonePerson, type ZoneStage } from "./helpers/zone-stage.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import type { Finding } from "./helpers/finding.ts";
import type { Store } from "../src/store/connect.ts";

const SLOW = 180_000;
const gate = boxGate();

function gateSuffix(): string {
  return gate.ok ? "" : ` [skipped: ${gate.reason}]`;
}

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ALLOW_PROTOCOL: "file",
  GIT_AUTHOR_NAME: "p1",
  GIT_AUTHOR_EMAIL: "p1@example.invalid",
  GIT_COMMITTER_NAME: "p1",
  GIT_COMMITTER_EMAIL: "p1@example.invalid",
};

interface Scene {
  dir: string;
  stage: ZoneStage;
  store: Store;
  read: ReturnType<typeof storeReader>;
  registry(): unknown;
  sync(entry: string): Promise<void>;
  close(): Promise<void>;
}

/** The household, with one agent per person so each has a box of its own. */
async function scene(): Promise<Scene> {
  const dir = mkdtempSync(join(tmpdir(), "hub-zone-move-"));
  const database = await freshDatabase(cluster);
  const stage = await zoneStage(dir, {
    provision: true,
    hub: { store_url: userlessStoreUrl(cluster, database) },
    over: (spec) => ({
      ...spec,
      presets: { daily: { adapter: "scripted", model: "m", provider: "p", effort: "medium", paid: "key" } },
      agents: (spec.people ?? []).map((person, n) => ({
        id: `${person.id}-lair`, person: String(person.id), preset: "daily",
        chat: `000000000${n}`, door: "door-fake", runner: "runner-local",
      })),
      run: [
        ...(spec.run ?? []),
        { id: "door-fake", kind: "door", machine: THIS_MACHINE, platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: "runner-local", kind: "runner", machine: THIS_MACHINE, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
      ],
    }),
  });
  const store = await superStore(cluster, database);
  const read = storeReader(cluster, database);
  const { runSync } = await seam("src/sync/run.ts");
  return {
    dir, stage, store, read,
    registry: () => loadRegistry(stage.registryFile),
    async sync(entry) {
      const registry = loadRegistry(stage.registryFile);
      const declared = listRunEntries(registry).find((one) => one.id === entry)!;
      await withAmbient(GIT_ENV, () => (runSync as Function)(declared, registry) as Promise<void>);
    },
    async close() {
      await read.close().catch(() => {});
      await store.close().catch(() => {});
      await stage.remove();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

interface Ran {
  code: number;
  out: string;
}

/** A command, run as this process runs one. The control for every boxed run. */
async function run(argv: string[], env: Record<string, string> = {}): Promise<Ran> {
  const proc = Bun.spawn(argv, {
    stdout: "pipe", stderr: "pipe", stdin: "ignore",
    env: { ...process.env, ...env },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
}

/** The same command, inside one agent's box, with the context it is handed. */
async function runBoxed(argv: string[], ctx: unknown, env: Record<string, string> = {}): Promise<Ran> {
  const { boxCommand } = await seam("src/box/index.ts");
  const built = (boxCommand as Function)(argv, { ...(ctx as object), platform: process.platform }, process.platform) as {
    argv: string[]; profile?: { path: string; text: string };
  };
  if (built.profile) await Bun.write(built.profile.path, built.profile.text);
  return run(built.argv, env);
}

/** The move, exactly as an agent would type it. */
function moveArgv(stage: ZoneStage, person: ZonePerson, slug: string, folder: string, ...flags: string[]): string[] {
  return [stage.imprnt, "vault", "move", slug, `${stage.mount}/${folder}`, "--vault", person.vaultDir, ...flags];
}

function note(title: string, word: string, extra = ""): string {
  return `---\ntype: note\nkind: reference\ntags: ["household"]\nsummary: ${title}\n${extra}---\n\n# ${title}\n\nThe code word is ${word}.\n`;
}

function word(): string {
  return `word-${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

/** What one person's checkout of the zone holds, git's bookkeeping left out. */
function zoneFiles(person: ZonePerson): string[] {
  return readdirSync(person.zonePath, { recursive: true })
    .map(String)
    .filter((one) => one !== ".git" && !one.startsWith(".git/"))
    .sort();
}

/**
 * One direction of the share, asserted whole: the mover's own box does the
 * move, both syncs run, the other person's box reads the note, and a private
 * note of the mover stays unreadable from there.
 *
 * It takes a FRESH scene each time it runs, because a symmetry asserted on a
 * scene the first direction already changed proves less than it looks like.
 */
async function shareOneWay(from: string, to: string): Promise<void> {
  const it = await scene();
  try {
    const mover = it.stage.person(from);
    const reader = it.stage.person(to);
    const shared = word();
    const priv = word();

    // --- THE CONTROL, first: the reader's checkout holds nothing of the
    //     mover's, so everything below is a change and not a starting state.
    expect(zoneFiles(reader)).toEqual(["base.txt"]);

    const privatePath = it.stage.plantNote(from, "finances/private-ledger", note("A private ledger", priv));
    it.stage.plantNote(from, "finances/rent", note("What the household pays for rent", shared));

    const ctx = (await seam("src/box/index.ts")).boxContextFor as Function;
    const before = ctx(it.registry(), `${from}-lair`);

    // --- 1. THE MOVE, inside the mover's own box, with an ordinary turn's
    //     context and no grant of any kind added to it.
    const moved = await runBoxed(moveArgv(it.stage, mover, "finances/rent", "finances"), before, {
      XDG_CONFIG_HOME: it.stage.configHome,
    });
    expect(moved.code, moved.out).toBe(0);
    const landed = join(mover.zonePath, "finances", "rent.md");
    expect(existsSync(landed)).toBe(true);
    expect(readFileSync(landed, "utf8")).toContain(shared);
    expect(existsSync(mover.notePath("finances/rent"))).toBe(false);
    const log = readFileSync(join(mover.vaultDir, "log.md"), "utf8");
    expect(log).toContain("finances/rent");
    expect(log).toContain(`${it.stage.mount}/finances/rent`);
    expect(log).not.toContain("{move-in-progress}");

    // The context is the same object an ordinary turn gets, compared whole.
    expect(ctx(it.registry(), `${from}-lair`)).toEqual(before);

    // --- WHAT THE MOVE COSTS THE PERSON, read off git rather than assumed: the
    //     vault is dirty on both counts and the sync will not commit either.
    const standing = fixtureGit(mover.tree, "status", "--porcelain");
    expect(standing).toContain("log.md");
    expect(standing).toContain("finances/rent.md");
    it.stage.commitZone(from, "share the rent note");
    it.stage.commitVault(from, "the note left this vault");

    // --- 2. BOTH SYNCS, against the local bare remote.
    await it.sync(mover.syncEntry);
    await it.sync(reader.syncEntry);
    const rows = await it.read.sheet("sync");
    expect(rows.map((one) => one.id).sort()).toEqual([mover.syncEntry, reader.syncEntry].sort());
    for (const row of rows) expect(row.data.status).toBe("success");
    const stamps = (await it.read.sheet("job_success")).map((one) => one.id).sort();
    expect(stamps).toEqual([mover.syncEntry, reader.syncEntry].sort());

    // --- 3. THE OTHER PERSON'S OWN VAULT now holds it, byte for byte.
    const arrived = join(reader.zonePath, "finances", "rent.md");
    expect(existsSync(arrived)).toBe(true);
    expect(readFileSync(arrived, "utf8")).toBe(readFileSync(landed, "utf8"));

    // A symlink from the reader's vault at the mover's private note, so the
    // denial below is the BOX's and not a path that was never there.
    const link = join(reader.vaultDir, `link-out-${word()}`);
    symlinkSync(privatePath, link);

    const probe = ["/bin/sh", "-c", `cat ${arrived} 2>&1; echo "---"; cat ${privatePath} 2>&1; echo "---"; cat ${link} 2>&1`];

    // --- 4. THE UNBOXED CONTROL. Both reads succeed outside any box, which is
    //     what says the denial below came from the box.
    const outside = await run(probe);
    expect(outside.out).toContain(shared);
    expect(outside.out).toContain(priv);

    if (gate.ok) {
      // --- 5. INSIDE THE READER'S OWN BOX: the shared note reads, the private
      //     one does not, and neither does the symlink pointing at it.
      const inside = await runBoxed(probe, ctx(it.registry(), `${to}-lair`), {
        XDG_CONFIG_HOME: it.stage.configHome,
      });
      expect(inside.out).toContain(shared);
      expect(inside.out).not.toContain(priv);
    }
  } finally {
    await it.close();
  }
}

test.skipIf(!gate.ok)(
  `ROLL-27 the owner's agent shares a note with the core's own verb inside its box, both syncs run, and the second person's agent reads it in their own vault while a private note stays unreadable (SPEC §1, §6, L7)${gateSuffix()}`,
  async () => {
    await shareOneWay("p1", "p2");
  },
  SLOW,
);

test.skipIf(!gate.ok)(
  `ROLL-27 the same from the second person's side, on a scene of its own, because a rule that works one way and not the other is a rule nobody can rely on (SPEC §1, L7)${gateSuffix()}`,
  async () => {
    await shareOneWay("p2", "p1");
  },
  SLOW,
);

test("ROLL-27 the core refuses a note whose source points into private raw/, in its own words, and --force does not override it (SPEC §6)", async () => {
  const it = await scene();
  try {
    const p1 = it.stage.person("p1");
    const kept = word();
    const at = it.stage.plantNote("p1", "finances/tax-return",
      note("Last year's tax return", kept, 'source: "[[raw/tax-2025/return.pdf]]"\n'));

    for (const flags of [[], ["--force"]]) {
      const refused = await run(moveArgv(it.stage, p1, "finances/tax-return", "finances", ...flags),
        { XDG_CONFIG_HOME: it.stage.configHome });
      expect(refused.code, refused.out).not.toBe(0);
      // THE CORE'S OWN WORDING, matched on the core's sentence rather than on
      // any string this package could have invented.
      expect(refused.out).toContain("its source: points into this vault's private raw/");
      expect(refused.out).toContain("dead across the seam");
      // And the note has not moved.
      expect(existsSync(at)).toBe(true);
      expect(readFileSync(at, "utf8")).toContain(kept);
      expect(existsSync(join(p1.zonePath, "finances", "tax-return.md"))).toBe(false);
    }
    // --force is asserted to say so in the core's own words too.
    const forced = await run(moveArgv(it.stage, p1, "finances/tax-return", "finances", "--force"),
      { XDG_CONFIG_HOME: it.stage.configHome });
    expect(forced.out).toContain("--force does not override this");
  } finally {
    await it.close();
  }
}, SLOW);

test("ROLL-27 an entity link with no answer inside the mount refuses the move, and --force moves it and leaves the link (SPEC §6)", async () => {
  const it = await scene();
  try {
    const p1 = it.stage.person("p1");
    it.stage.plantNote("p1", "people/the-owner", note("The owner", word()));
    const mark = word();
    const at = it.stage.plantNote("p1", "finances/rent",
      `---\ntype: note\nkind: reference\ntags: ["household"]\nsummary: rent\n---\n\n# What the household pays for rent\n\nThe code word is ${mark}, and [[people/the-owner]] pays it.\n`);

    const refused = await run(moveArgv(it.stage, p1, "finances/rent", "finances"),
      { XDG_CONFIG_HOME: it.stage.configHome });
    expect(refused.code, refused.out).not.toBe(0);
    expect(refused.out).toContain("entity link(s) resolve only in this vault");
    expect(existsSync(at)).toBe(true);

    const forced = await run(moveArgv(it.stage, p1, "finances/rent", "finances", "--force"),
      { XDG_CONFIG_HOME: it.stage.configHome });
    expect(forced.code, forced.out).toBe(0);
    const landed = join(p1.zonePath, "finances", "rent.md");
    expect(existsSync(landed)).toBe(true);
    // THE LINK IS LEFT AS IT IS, which is what the core does and what `imprnt
    // check` then reports as a seam leak until somebody fixes it.
    expect(readFileSync(landed, "utf8")).toContain("[[people/the-owner]]");
    expect(forced.out).toContain("seam-leak");
  } finally {
    await it.close();
  }
}, SLOW);

test.skipIf(!gate.ok)(
  `ROLL-27 the harvester's box cannot move a note, and the same command from the person's own box can, which is right rather than a gap (SPEC §6, L7)${gateSuffix()}`,
  async () => {
    const it = await scene();
    try {
      const p1 = it.stage.person("p1");
      const mark = word();
      const at = it.stage.plantNote("p1", "finances/rent", note("What the household pays for rent", mark));
      const ctx = (await seam("src/box/index.ts")).boxContextFor as Function;
      const turn = ctx(it.registry(), "p1-lair");
      const argv = moveArgv(it.stage, p1, "finances/rent", "finances");

      // The harvester reads the tree and files what it found through the apply
      // OUTSIDE the box, so its box is read-only on the tree and a move is a
      // write. The same argv from the person's own box succeeds below, which is
      // what makes this a statement about the BOX and not about the command.
      const harvest = await runBoxed(argv, { ...turn, purpose: "harvest" }, {
        XDG_CONFIG_HOME: it.stage.configHome,
      });
      expect(harvest.code, harvest.out).not.toBe(0);
      expect(existsSync(at)).toBe(true);
      expect(zoneFiles(p1)).toEqual(["base.txt"]);

      const ordinary = await runBoxed(argv, turn, { XDG_CONFIG_HOME: it.stage.configHome });
      expect(ordinary.code, ordinary.out).toBe(0);
      expect(existsSync(at)).toBe(false);
      expect(zoneFiles(p1).sort()).toEqual(["base.txt", "finances", "finances/rent.md"]);
    } finally {
      await it.close();
    }
  },
  SLOW,
);

test("ROLL-27 no file under src/ implements a move, a link rewrite or a seam finding (SPEC §6)", async () => {
  // The hub spawns the core's verb and carries no half of it. A second
  // implementation would drift from the one `imprnt check` reads by, and the
  // cheapest way to say that from outside is to read the package.
  const seamWords = ["move-fork", "seam-leak", "seam-dead-source", "{move-in-progress}", "moveInProgressLine"];
  const root = hubPath("src");
  const files = readdirSync(root, { recursive: true })
    .map(String)
    .filter((one) => one.endsWith(".ts"))
    .map((one) => join(root, one));
  expect(files.length).toBeGreaterThan(20);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const seamWord of seamWords) expect(text, `${file} carries ${seamWord}`).not.toContain(seamWord);
  }
}, SLOW);

test("ROLL-27 two people editing one shared note between syncs is the shipped sync-failed finding, with both versions still on disk (SPEC §6, ROLL-31)", async () => {
  const it = await scene();
  try {
    const p1 = it.stage.person("p1");
    const p2 = it.stage.person("p2");
    const mine = word();
    const theirs = word();
    const path = "shopping.md";

    writeFileSync(join(p1.zonePath, path), `# What to buy\n\n${mine}\n`, "utf8");
    it.stage.commitZone("p1", "the owner's list");
    writeFileSync(join(p2.zonePath, path), `# What to buy\n\n${theirs}\n`, "utf8");
    it.stage.commitZone("p2", "the second person's list");

    await it.sync(p1.syncEntry);
    // The second one meets a remote that has moved, and its own commit cannot
    // rebase onto it. That is the shipped refusal and no new behaviour is added.
    await expect(it.sync(p2.syncEntry)).rejects.toThrow("sync-failed");

    const row = (await it.read.sheet("sync")).find((one) => one.id === p2.syncEntry)!;
    const results = row.data.repositories as { id: string; status: string; code?: string }[];
    expect(results.find((one) => one.id === p2.zoneRepository)!.code).toBe("conflict");

    const { runCheck } = await seam("src/check/run.ts");
    const findings = (await (runCheck as Function)({
      registryFile: it.stage.registryFile, machine: THIS_MACHINE, store: it.store, os: null, kernel: null,
    })) as Finding[];
    const failed = findings.filter((one) => one.kind === "sync-failed");
    expect(failed.map((one) => one.subject)).toEqual([`${p2.syncEntry}/${p2.zoneRepository}`]);

    // BOTH VERSIONS ARE STILL ON DISK. The conflicted file holds each side, so
    // nobody's work was thrown away by a machine.
    const left = readFileSync(join(p2.zonePath, path), "utf8");
    expect(left).toContain(mine);
    expect(left).toContain(theirs);
  } finally {
    await it.close();
  }
}, SLOW);
