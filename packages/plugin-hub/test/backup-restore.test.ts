// A restored copy really holds the message and the note that were added after
// the copy before it, and `check` says when a copy did not land or is late.
//
// SPEC §1: at most one hour of loss. L13: a scheduled job's staleness comes from
// its own "I ran and it landed" stamp. The promise is about LATER work, so the
// proof is a pair: a message, a chat line and a vault note added after a first
// copy are absent from that copy and present in the next one. A restore that
// only showed the first copy restores would prove nothing about the hour.
//
// THE RESTORE NEVER TOUCHES THE CLUSTER THE COPY WAS TAKEN FROM. Each dump is
// restored into a second throwaway cluster, and the first one's `inbound` table
// is compared by digest before and after, because a restore into the wrong
// database would otherwise pass every assertion here.
//
// The chat logs are read back with the shipped `readTail`, so what is proved is
// a usable chat state and not merely a set of files.
//
// Gated on a second device, which a copy needs to land, and on `pg_dump`, which
// the restore needs, each with its reason in the test name. A skip never
// closes the gate.
//
// Red reason: import missing, src/check/backup.ts, and behind it `runCheck`
// reporting nothing about a copy that did not land.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts";
import {
  backupStage,
  deviceGate,
  filesHolding,
  filesUnder,
  gateSuffix,
  mirrored,
  pgDumpGate,
  type BackupStage,
} from "./helpers/backup-stage.ts";
import { superStore } from "./helpers/hub-fixture.ts";
import { fakeProber } from "./helpers/prober.ts";
import { THIS_MACHINE } from "./helpers/zone-stage.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import { readTail } from "../src/chatlog.ts";
import { finding } from "../src/door/lines.ts";
import type { Finding } from "../src/check/finding.ts";

let cluster: Cluster;
/** The second cluster, the only place a dump is ever restored into. */
let scratch: Cluster;
beforeAll(async () => {
  cluster = await startCluster();
  scratch = await startCluster();
  // A dump carries its grants and its policies by role name, and roles belong
  // to a cluster rather than to a database, so the restore target has them.
  const admin = scratch.connect("postgres") as unknown as { unsafe(query: string): Promise<unknown> };
  for (const role of ["hub_door", "hub_runner", "hub_agent", "hub_hub"]) await admin.unsafe(`create role ${role} login`);
});
afterAll(async () => {
  await scratch?.stop();
  await cluster?.stop();
});

const DEVICE = deviceGate();
const DUMP = pgDumpGate();
const landed = DEVICE.ok ? test : test.skip;
const restored = DEVICE.ok && DUMP.ok ? test : test.skip;
const SLOW = 180_000;
const AWAY = `elsewhere-${crypto.randomUUID()}`;
const GRACE = 300;

async function copy(stage: BackupStage): Promise<{ code?: string; reason?: string }> {
  const { runBackup } = await seam("src/backup/run.ts");
  const registry = loadRegistry(stage.registryFile);
  const entry = listRunEntries(registry).find((one) => one.id === stage.entry);
  try {
    await (runBackup as (entry: unknown, registry: unknown) => Promise<unknown>)(entry, registry);
    return {};
  } catch (error) {
    return { code: (error as { code: string }).code, reason: (error as { reason: string }).reason };
  }
}

function landing(stage: BackupStage, name = "copy"): string {
  const other = stage.otherDevice();
  if (other.path === null) throw new Error(`the device gate said yes and the stage said no: ${other.reason}`);
  return join(other.path, name);
}

/** A dump restored into its own fresh database in the second cluster, answering its inbound rows. */
async function restore(dump: string): Promise<string[]> {
  const database = await scratch.createDatabase();
  await scratch.runSqlFile(database, dump);
  const read = scratch.connect(database) as unknown as { unsafe(query: string): Promise<{ id: string; body: string }[]> };
  return (await read.unsafe("select id, body from inbound order by id")).map((row) => `${row.id} ${row.body}`);
}

async function digest(stage: BackupStage): Promise<string> {
  const [row] = await stage.store.read.sql(
    "select md5(coalesce(string_agg(i::text, '|' order by i.id), '')) as digest from inbound i",
  );
  return String(row.digest);
}

async function tail(copyRoot: string, stage: BackupStage): Promise<string> {
  return await readTail({
    stateDir: mirrored(copyRoot, stage.stateDir),
    person: "p1",
    agent: "p1-lair",
    now: new Date(Date.now() + 60_000),
    hours: 24,
    tokens: 8000,
  });
}

async function check(stage: BackupStage, now = new Date()): Promise<Finding[]> {
  const { runCheck } = await seam("src/check/run.ts");
  const store = await superStore(cluster, stage.store.db);
  try {
    return (await (runCheck as (options: unknown) => Promise<Finding[]>)({
      machine: THIS_MACHINE, registryFile: stage.registryFile, store,
      os: null, kernel: null, credentials: fakeProber({}), now,
    }));
  } finally {
    await store.close();
  }
}

const OURS = ["backup-failed", "job-no-stamp", "job-stale"];
function ours(found: Finding[], stage: BackupStage): [string, string][] {
  return found.filter((one) => OURS.includes(one.kind) && one.subject === stage.entry).map((one) => [one.kind, one.id]);
}

// --- the restore proof -----------------------------------------------------

restored(`ROLL-32 a message, a chat line and a vault note added after a copy are ABSENT from it and PRESENT in the next one, restored into a throwaway cluster and read with the shipped readers${gateSuffix(DEVICE, DUMP)}`, async () => {
  const stage = await backupStage(cluster);
  try {
    const liveBefore = await digest(stage);
    const destination = landing(stage);
    stage.configure({ destination });
    expect(await copy(stage)).toEqual({});
    // The first copy is kept where it landed, and the next hour lands in the
    // same place, with not one byte of the registry changed in between.
    const first = join(dirname(destination), "first-copy");
    renameSync(destination, first);

    // Later work, one of each kind, each carrying its own word.
    const word = (what: string) => `later-${what}-${crypto.randomUUID()}`;
    const message = word("message");
    const line = word("chat-line");
    const note = word("vault-note");
    await stage.store.read.sql("insert into inbound (id, person, agent, body) values ('telegram:1000000001:9', 'p1', 'p1-lair', $1)", [message]);
    appendFileSync(stage.copied.chatLine.path,
      `${JSON.stringify({ id: "p1-lair:9", at: new Date().toISOString(), direction: "in", from: "p1", text: line })}\n`);
    const later = stage.zone.plantNote("p1", "a-later-note", `# A later note\n\n${note}\n`);
    const liveAfterWork = await digest(stage);

    expect(await copy(stage)).toEqual({});
    const second = destination;
    expect(readFileSync(join(second, "manifest.json"), "utf8")).not.toBe(readFileSync(join(first, "manifest.json"), "utf8"));

    // The store: absent from the first dump, present in the second.
    const firstRows = await restore(join(first, "dump", "hub.sql"));
    const secondRows = await restore(join(second, "dump", "hub.sql"));
    expect(firstRows).toContain("telegram:1000000001:1 a message already in the store");
    expect(firstRows.join("\n")).not.toContain(message);
    expect(secondRows).toContain(`telegram:1000000001:9 ${message}`);

    // The chat log, through the shipped reader, in order.
    const firstTail = await tail(first, stage);
    const secondTail = await tail(second, stage);
    expect(firstTail).toContain(stage.copied.chatLine.canary);
    expect(firstTail).not.toContain(line);
    expect(secondTail).toContain(line);
    expect(secondTail.indexOf(stage.copied.chatLine.canary)).toBeLessThan(secondTail.indexOf(line));

    // The vault note.
    expect(existsSync(mirrored(first, later))).toBe(false);
    expect(filesHolding(first, note)).toEqual([]);
    expect(readFileSync(mirrored(second, later), "utf8")).toContain(note);

    // No three words anywhere in the first copy, which is what "absent" means.
    for (const one of [message, line, note]) expect(filesHolding(first, one)).toEqual([]);

    // The cluster the copies were taken from is untouched by either restore.
    expect(await digest(stage)).toBe(liveAfterWork);
    expect(liveAfterWork).not.toBe(liveBefore);
  } finally {
    await stage.remove();
  }
}, SLOW);

// --- the findings ------------------------------------------------------------

landed(`ROLL-32 backup-failed is read from the copy's last failure, keyed on the entry, and clears with its check row when a copy lands${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster);
  try {
    // The sync-failed shape, read from a second sheet.
    stage.configure({ destination: AWAY, upload_argv: [stage.recorder, "/usr/bin/true"] });
    expect((await copy(stage)).reason).toBe("copy does not match");
    const failed = (await check(stage)).filter((one) => one.kind === "backup-failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].id).toBe(`${THIS_MACHINE}/backup-failed:${stage.entry}`);
    expect(failed[0].subject).toBe(stage.entry);
    expect(failed[0].says).toBe(`backup-failed: ${stage.entry}: copy does not match.`);
    expect(typeof failed[0].fix).toBe("string");
    expect(failed[0].fix).toContain(stage.entry);
    const rowIds = async () => (await stage.store.read.sheet("check")).map((row) => row.id);
    expect(await rowIds()).toContain(failed[0].id);

    stage.configure({ destination: landing(stage), upload_argv: [stage.recorder, "/bin/cp", "-R", "-f", "{staging}/.", "{destination}"] });
    expect(await copy(stage)).toEqual({});
    expect((await check(stage)).filter((one) => one.kind === "backup-failed")).toEqual([]);
    expect(await rowIds()).not.toContain(failed[0].id);
  } finally {
    await stage.remove();
  }
}, SLOW);

landed(`ROLL-32 job-no-stamp and job-stale are the SHIPPED findings for the copy, and each clears when a copy lands${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster);
  try {
    // A missed hour is a finding by design, not a bug: the copy's own stamp,
    // the entry's hourly cadence and the one grace this household has.
    const id = (kind: string) => `${THIS_MACHINE}/${kind}:${stage.entry}`;
    expect(ours(await check(stage), stage)).toEqual([["job-no-stamp", id("job-no-stamp")]]);

    stage.configure({ destination: landing(stage) });
    expect(await copy(stage)).toEqual({});
    expect(ours(await check(stage), stage)).toEqual([]);

    // The stamp made old, past the hour and the grace.
    await stage.store.read.sql(
      "update state_row set data = jsonb_set(data, '{at}', to_jsonb($1::text)) where sheet = 'job_success' and id = $2",
      [new Date(Date.now() - (3600 + GRACE + 120) * 1000).toISOString(), stage.entry],
    );
    expect(ours(await check(stage), stage)).toEqual([["job-stale", id("job-stale")]]);

    // A copy landing now is what clears it: the same check at the same clock.
    expect(await copy(stage)).toEqual({});
    expect(ours(await check(stage), stage)).toEqual([]);
  } finally {
    await stage.remove();
  }
}, SLOW);

landed(`ROLL-32 check opens no destination: it runs no argv, changes nothing at the destination or in the staging directory, and writes only its own sheet${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster);
  try {
    const destination = landing(stage);
    stage.configure({ destination });
    expect(await copy(stage)).toEqual({});
    const snapshot = (root: string) => filesUnder(root).map((rel) => `${rel} ${statSync(join(root, rel)).mtimeMs}`);
    const rows = async () => JSON.stringify(await stage.store.read.sql(
      "select sheet, id, data from state_row where sheet <> 'check' order by sheet, id"));
    const diary = async () => JSON.stringify(await stage.store.read.sql("select count(*)::int as n from ledger_event"));
    const before = { destination: snapshot(destination), staging: snapshot(stage.staging), rows: await rows(), diary: await diary() };
    stage.clearCalls();
    await check(stage);
    expect(stage.calls()).toEqual([]);
    expect(snapshot(destination)).toEqual(before.destination);
    expect(snapshot(stage.staging)).toEqual(before.staging);
    expect(await rows()).toBe(before.rows);
    expect(await diary()).toBe(before.diary);
  } finally {
    await stage.remove();
  }
}, SLOW);

test("ROLL-32 the three codes are machine vocabulary, unchanged through the shipped finding template in Russian", () => {
  expect(finding("ru", { code: "backup-failed", target: "backup-copy", cause: "copy does not match" }))
    .toBe("backup-failed: backup-copy: копия не совпадает.");
  expect(finding("ru", { code: "backup-failed", target: "backup-copy", cause: "same device" }))
    .toBe("backup-failed: backup-copy: то же устройство.");
  for (const code of ["job-no-stamp", "job-stale"]) {
    expect(finding("ru", { code, target: "backup-copy", cause: "operation failed" }))
      .toBe(`${code}: backup-copy: операция не выполнена.`);
  }
});

landed(`ROLL-32 the control: with two good copies and a fresh stamp, check reports none of the three${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster);
  try {
    stage.configure({ destination: landing(stage) });
    expect(await copy(stage)).toEqual({});
    expect(await copy(stage)).toEqual({});
    expect(ours(await check(stage), stage)).toEqual([]);
  } finally {
    await stage.remove();
  }
}, SLOW);
