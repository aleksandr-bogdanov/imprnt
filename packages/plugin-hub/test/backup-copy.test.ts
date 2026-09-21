// A copy is accepted only when it reads back, and a copy on the same card is
// not a copy.
//
// SPEC §1: a plain-text dump every hour into its own private repository on the
// box, committed when it changed, with the off-site destination a setting and no
// provider named in code. SPEC §6's Forbidden: a job with no success stamp. L13:
// the stamp is the job's own "I ran and it landed", because a service manager
// knows a job ran and not whether it worked.
//
// REAL COMMANDS, NO PROVIDER. The stage's three argvs are `pg_dump`, `cp -R` and
// `cp`, each run through a recorder that logs its arguments exactly as they
// arrived, against a throwaway cluster and a destination on another device.
//
// THE TWO DECLARED FAILING CONTROLS are labelled as such below: an upload of
// `true`, which exits zero and copies nothing, and a destination on the staging
// directory's own device. Neither needs a second device, so neither can skip.
// Every check that needs a copy to LAND does need one, and skips with the reason
// in its name where the machine cannot give one. A skip never closes the gate.
//
// Red reason: import missing, src/backup/run.ts.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { pgBin, seam, startCluster, hubPath, type Cluster } from "./helpers/cluster.ts";
import {
  backupStage,
  deviceGate,
  filesHolding,
  filesUnder,
  gateSuffix,
  mirrored,
  type BackupStage,
} from "./helpers/backup-stage.ts";
import { fixtureGit } from "./helpers/rollout-git.ts";
import { THIS_MACHINE } from "./helpers/zone-stage.ts";
import { loadRegistry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";

let cluster: Cluster;
beforeAll(async () => {
  cluster = await startCluster();
});
afterAll(async () => {
  await cluster?.stop();
});

const DEVICE = deviceGate();
/** A check that needs a copy to land, which needs a second device. */
const landed = DEVICE.ok ? test : test.skip;
const SLOW = 120_000;

/** Not a local path at all, so no device question is asked of it and nothing can land there. */
const AWAY = `elsewhere-${crypto.randomUUID()}`;
afterAll(() => rmSync(join(process.cwd(), AWAY), { recursive: true, force: true }));

type Refused = Error & { code: string; reason: string; detail: string };

async function job() {
  const mod = await seam("src/backup/run.ts");
  expect(typeof mod.runBackup).toBe("function");
  expect(typeof mod.BackupRefused).toBe("function");
  expect(mod.BACKUP_SHEET).toBe("backup");
  return {
    runBackup: mod.runBackup as (entry: unknown, registry: unknown) => Promise<Record<string, unknown>>,
    BackupRefused: mod.BackupRefused as new (...args: unknown[]) => Refused,
  };
}

/** One copy exactly as the entry point runs it: the file loaded, the entry found by id. */
async function copy(stage: BackupStage): Promise<{ result?: Record<string, unknown>; error?: Refused }> {
  const { runBackup, BackupRefused } = await job();
  const registry = loadRegistry(stage.registryFile);
  const entry = listRunEntries(registry).find((one) => one.id === stage.entry);
  expect(entry).toBeDefined();
  try {
    return { result: await runBackup(entry, registry) };
  } catch (error) {
    expect(error).toBeInstanceOf(BackupRefused);
    return { error: error as Refused };
  }
}

async function sheetRow(stage: BackupStage, sheet: string) {
  return (await stage.store.read.sheet(sheet)).find((row) => row.id === stage.entry) ?? null;
}

async function failures(stage: BackupStage): Promise<Record<string, unknown>[]> {
  const rows = (await stage.store.read.sql(
    "select detail from ledger_event where kind = 'failed' and subject = $1 order by seq",
    [stage.entry],
  )) as { detail: Record<string, unknown> }[];
  return rows.map((row) => row.detail);
}

/** The whole failure shape: no stamp of either kind, one diary line, the cause on the sheet. */
async function failedWith(stage: BackupStage, error: Refused | undefined, cause: string, code: string): Promise<void> {
  expect(error, "the copy was expected to fail").toBeDefined();
  expect(error!.reason).toBe(cause);
  expect(error!.code).toBe(code);
  expect(await sheetRow(stage, "job_success")).toBeNull();
  const row = await sheetRow(stage, "backup");
  expect(row?.data.status).toBe("failed");
  expect(row?.data.cause).toBe(cause);
  expect(row?.data).not.toHaveProperty("dump_sha256");
  const said = await failures(stage);
  expect(said.map((one) => [one.operation, one.code])).toEqual([["backup", `backup-${code}`]]);
}

function sha(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The dump narrowed to the one table no copy writes to, so two copies of an unchanged store dump the same bytes. */
function inboundOnly(stage: BackupStage): string[] {
  return [pgBin("psql"), "-X", "-q", "-A", "-t", "-c", "select id || ' ' || body from inbound order by id",
    `postgres://${cluster.superuser}@127.0.0.1:${cluster.port}/${stage.store.db}`];
}

function landing(stage: BackupStage, name = "copy"): string {
  const other = stage.otherDevice();
  if (other.path === null) throw new Error(`the device gate said yes and the stage said no: ${other.reason}`);
  return join(other.path, name);
}

// --- what is copied, and the read-back -------------------------------------

landed(`ROLL-32 a copy to another device lands: the staging set is exactly the four groups, the uncommitted draft is in it, and the manifest covers every file and is written last${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster);
  try {
    // The control on the whole check, and the second half of the device pair:
    // the destination is on another device, so nothing refuses it.
    const destination = landing(stage);
    stage.configure({ destination });
    const { result, error } = await copy(stage);
    expect(error).toBeUndefined();
    expect(result).toBeDefined();
    const { staging } = stage;

    // The staging set as a PATH SET, so an addition and an omission both fail.
    const want = new Set<string>(["dump/hub.sql", "manifest.json"]);
    for (const rel of filesUnder(join(staging, "dump", ".git"))) want.add(`dump/.git/${rel}`);
    const into = (absolute: string) => relative(staging, mirrored(staging, absolute));
    const walked = [stage.secrets.secretsDir.path, stage.secrets.credentialFile.path];
    for (const person of stage.people) {
      for (const rel of filesUnder(person.vault)) {
        const absolute = join(person.vault, rel);
        if (walked.some((secret) => absolute === secret || absolute.startsWith(`${secret}/`))) continue;
        want.add(into(absolute));
      }
    }
    for (const file of [...stage.chatFiles, ...stage.inboxFiles, stage.registryFile, ...stage.named]) want.add(into(file));
    expect(filesUnder(staging)).toEqual([...want].sort());
    // Every zone checkout is in it, with its own history.
    for (const person of stage.people) expect(existsSync(join(mirrored(staging, person.zonePath), ".git", "HEAD"))).toBe(true);

    // An UNCOMMITTED change is in the copy, which is the reason working trees
    // are copied rather than repositories cloned.
    const draft = stage.copied.uncommitted;
    const owner = stage.people.find((one) => draft.path.startsWith(`${one.vault}/`))!;
    expect(fixtureGit(owner.vault, "status", "--porcelain")).toContain("draft-unsaved.md");
    expect(readFileSync(mirrored(staging, draft.path), "utf8")).toContain(draft.canary);

    // THE MANIFEST IS WRITTEN LAST: one written first would describe a copy
    // that may never have finished. It covers every file but itself, each by
    // the size and the sha256 this check computes for itself.
    const manifest = JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8")) as {
      at: string; machine: string; files: { path: string; sha256: string; size: number }[];
    };
    expect(manifest.machine).toBe(THIS_MACHINE);
    expect(manifest.files.map((one) => one.path)).toEqual(filesUnder(staging).filter((one) => one !== "manifest.json"));
    for (const one of manifest.files) {
      const bytes = readFileSync(join(staging, one.path));
      expect([one.path, one.size, one.sha256]).toEqual([one.path, bytes.length, sha(bytes)]);
    }
    const newest = Math.max(...manifest.files.map((one) => statSync(join(staging, one.path)).mtimeMs));
    expect(statSync(join(staging, "manifest.json")).mtimeMs).toBeGreaterThanOrEqual(newest);

    // What landed is what was sent, every file of it.
    expect(filesUnder(destination)).toEqual(filesUnder(staging));
    for (const one of manifest.files) expect(sha(readFileSync(join(destination, one.path)))).toBe(one.sha256);
  } finally {
    await stage.remove();
  }
}, SLOW);

landed(`ROLL-32 only a read-back that matches writes the stamp: the dump and the manifest are read back, and the sheet row and job_success are written${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster);
  try {
    const destination = landing(stage);
    stage.configure({ destination });
    stage.clearCalls();
    const { result, error } = await copy(stage);
    expect(error).toBeUndefined();
    const { staging } = stage;

    const calls = stage.calls();
    expect(calls.filter((call) => call[1] === "-R")).toEqual([["/bin/cp", "-R", "-f", `${staging}/.`, destination]]);
    const reads = calls.filter((call) => call[1] !== "-R");
    expect(reads.map((call) => call.slice(0, 2))).toEqual([
      ["/bin/cp", `${destination}/dump/hub.sql`],
      ["/bin/cp", `${destination}/manifest.json`],
    ]);
    // Read into a scratch path, never into the file it is compared with.
    for (const call of reads) expect(call[2].startsWith(`${staging}/.readback/`)).toBe(true);
    expect(existsSync(join(staging, ".readback"))).toBe(false);

    const manifest = JSON.parse(readFileSync(join(staging, "manifest.json"), "utf8")) as { files: { size: number }[] };
    const row = await sheetRow(stage, "backup");
    expect(Object.keys(row!.data).sort()).toEqual(["at", "bytes", "dump_sha256", "files", "machine"]);
    expect(row!.data).toEqual({
      at: row!.data.at,
      machine: THIS_MACHINE,
      files: manifest.files.length,
      bytes: manifest.files.reduce((sum, one) => sum + one.size, 0),
      dump_sha256: sha(readFileSync(join(staging, "dump", "hub.sql"))),
    });
    const stamp = await sheetRow(stage, "job_success");
    expect(stamp?.data).toEqual({ at: row!.data.at, machine: THIS_MACHINE });
    expect(result).toMatchObject({ at: row!.data.at, dump_sha256: row!.data.dump_sha256, committed: true });
    expect(await failures(stage)).toEqual([]);
  } finally {
    await stage.remove();
  }
}, SLOW);

landed(`ROLL-32 the sheet row and the success stamp are written in ONE transaction, so a failure between them leaves neither${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster);
  const { read } = stage.store;
  try {
    stage.configure({ destination: landing(stage) });
    // Every write to the backup sheet is logged by a trigger into a table of
    // its own, in the writing transaction. A transaction that rolls back takes
    // its log line with it, and a sheet row written on its own does not. The
    // failure path overwrites the sheet row either way, so the log is what
    // tells the two apart. It also records the role that wrote: the stage's
    // cluster trusts every login, so without this a copy running as the
    // superuser would pass every assertion here on grants production lacks.
    await read.sql("create table backup_check_writes (seq serial primary key, data jsonb not null, who text not null)");
    await read.sql(`create function backup_check_log() returns trigger language plpgsql security definer as $$
      begin insert into backup_check_writes (data, who) values (new.data, session_user); return new; end $$`);
    await read.sql(`create trigger backup_check_log after insert or update on state_row for each row
      when (new.sheet = 'backup') execute function backup_check_log()`);
    await read.sql(`create function backup_check_refuse() returns trigger language plpgsql as $$
      begin raise exception 'the stamp is refused by the check'; end $$`);
    await read.sql(`create trigger backup_check_refuse before insert or update on state_row for each row
      when (new.sheet = 'job_success') execute function backup_check_refuse()`);

    const { error } = await copy(stage);
    await failedWith(stage, error, "operation failed", "stamp");
    const logged = async () => (await read.sql("select data, who from backup_check_writes order by seq")) as
      { data: Record<string, unknown>; who: string }[];
    expect((await logged()).map((one) => one.data.status)).toEqual(["failed"]);

    // The control: the same copy with nothing in the way writes both.
    await read.sql("drop trigger backup_check_refuse on state_row");
    const again = await copy(stage);
    expect(again.error).toBeUndefined();
    expect((await sheetRow(stage, "backup"))?.data).toHaveProperty("dump_sha256");
    expect(await sheetRow(stage, "job_success")).not.toBeNull();
    // Both copies wrote as the role production gives the copy, and no other.
    expect((await logged()).map((one) => [one.data.status ?? "landed", one.who])).toEqual([["failed", "hub_hub"], ["landed", "hub_hub"]]);
  } finally {
    await read.sql("drop trigger if exists backup_check_refuse on state_row").catch(() => {});
    await read.sql("drop trigger if exists backup_check_log on state_row").catch(() => {});
    await stage.remove();
  }
}, SLOW);

test("ROLL-32 DECLARED FAILING CONTROL: an upload of true exits zero, copies nothing, and ends with no stamp and backup-failed", async () => {
  const stage = await backupStage(cluster);
  try {
    stage.configure({ destination: AWAY, upload_argv: [stage.recorder, "/usr/bin/true"] });
    stage.clearCalls();
    const { error } = await copy(stage);
    // The upload really ran and really exited zero, and the read-back is what
    // found nothing there.
    expect(stage.calls()[0]).toEqual(["/usr/bin/true"]);
    expect(stage.calls()[1]?.[1]).toBe(`${AWAY}/dump/hub.sql`);
    await failedWith(stage, error, "copy does not match", "readback");
    expect(existsSync(join(process.cwd(), AWAY))).toBe(false);
  } finally {
    await stage.remove();
  }
}, SLOW);

test("ROLL-32 a read-back that exits zero with SOMETHING ELSE of the very same length is the same failure, found only by the byte comparison", async () => {
  const stage = await backupStage(cluster);
  try {
    // Without this, the control above passes for a build that only checked
    // that something came back. The decoy is the dump this copy is about to
    // make, one byte changed, so its length is right and a comparison of
    // lengths, or of anything but the bytes, lets it through.
    const dumpArgv = inboundOnly(stage);
    const exact = Bun.spawnSync(dumpArgv, { stdout: "pipe" }).stdout;
    expect(exact.length).toBeGreaterThan(8);
    const decoy = join(stage.dir, "decoy.sql");
    const flipped = Buffer.from(exact);
    flipped[4] = flipped[4] === 0x41 ? 0x42 : 0x41;
    writeFileSync(decoy, flipped);
    stage.configure({
      destination: AWAY,
      dump_argv: dumpArgv,
      upload_argv: [stage.recorder, "/usr/bin/true"],
      readback_argv: [stage.recorder, "/bin/cat", decoy],
    });
    const { error } = await copy(stage);
    await failedWith(stage, error, "copy does not match", "compare");
    expect(String((await failures(stage))[0].cause)).toContain("dump/hub.sql");

    // The control: the exact bytes read back PASS the dump's comparison, and
    // the copy is refused only at the manifest, which the same command cannot
    // produce. So the comparison is not one that refuses everything.
    writeFileSync(decoy, exact);
    const again = await copy(stage);
    expect(again.error?.code).toBe("compare");
    expect(String((await failures(stage))[1].cause)).toContain("manifest.json");
  } finally {
    await stage.remove();
  }
}, SLOW);

landed(`ROLL-32 a destination still holding last hour's copy does not vouch for this hour's, even when not one byte of the copy changed but its time${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster);
  try {
    // An upload that goes quiet when a marker exists, so the next hour's
    // upload can do nothing WITHOUT the registry changing. A registry edited
    // between the two copies would change the manifest by itself and hide what
    // this asks about.
    const quiet = join(stage.dir, "quiet-upload");
    const marker = join(stage.dir, "upload-goes-quiet");
    writeFileSync(quiet, `#!/bin/sh\n[ -e ${JSON.stringify(marker)} ] && exit 0\nexec "$@"\n`, "utf8");
    chmodSync(quiet, 0o755);
    const destination = landing(stage);
    stage.configure({
      destination,
      dump_argv: inboundOnly(stage),
      upload_argv: [stage.recorder, quiet, "/bin/cp", "-R", "-f", "{staging}/.", "{destination}"],
    });
    expect((await copy(stage)).error).toBeUndefined();
    const first = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8")) as { at: string; files: unknown[] };
    writeFileSync(marker, "", "utf8");
    const { error } = await copy(stage);
    const second = JSON.parse(readFileSync(join(stage.staging, "manifest.json"), "utf8")) as { at: string; files: unknown[] };
    // Every file of the copy is byte for byte what the destination holds, and only
    // the moment the manifest was written differs.
    expect(second.files).toEqual(first.files);
    expect(second.at).not.toBe(first.at);
    expect(readFileSync(join(stage.staging, "dump", "hub.sql")).equals(readFileSync(join(destination, "dump", "hub.sql")))).toBe(true);
    expect(error?.reason).toBe("copy does not match");
    expect(error?.code).toBe("compare");
    expect(String((await failures(stage))[0].cause)).toContain("manifest.json");
  } finally {
    await stage.remove();
  }
}, SLOW);

test("ROLL-32 a dump command that exits zero and writes nothing is a failure before anything is uploaded", async () => {
  const stage = await backupStage(cluster);
  try {
    // The dump's own twin of the upload of `true`: exit zero, no bytes.
    stage.configure({ destination: AWAY, dump_argv: [stage.recorder, "/usr/bin/true"] });
    stage.clearCalls();
    const { error } = await copy(stage);
    await failedWith(stage, error, "operation failed", "dump");
    expect(stage.calls()).toEqual([["/usr/bin/true"]]);
    expect(existsSync(join(stage.staging, "manifest.json"))).toBe(false);
  } finally {
    await stage.remove();
  }
}, SLOW);

// --- the entry point a unit starts ----------------------------------------

/** The program exactly as a rendered unit starts it: the interpreter, the script, the file, the id. */
async function entryPoint(stage: BackupStage): Promise<{ code: number; err: string }> {
  const child = Bun.spawn([process.execPath, "run", hubPath("src/entry/backup.ts"), stage.registryFile, stage.entry],
    { env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [err, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
  return { code, err };
}

test("ROLL-32 the entry point a unit starts exits 1 and says backup-failed with the closed-list cause when the copy does not land", async () => {
  const stage = await backupStage(cluster);
  try {
    stage.configure({ destination: AWAY, upload_argv: [stage.recorder, "/usr/bin/true"] });
    const ran = await entryPoint(stage);
    expect(ran.code).toBe(1);
    expect(ran.err).toContain(`backup-failed: ${stage.entry}: copy does not match.`);
    // The command's own words never reach the line an operator reads.
    expect(ran.err).not.toContain(AWAY);
    expect(await sheetRow(stage, "job_success")).toBeNull();
  } finally {
    await stage.remove();
  }
}, SLOW);

landed(`ROLL-32 the entry point a unit starts exits 0 and the copy lands with its stamp${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster);
  try {
    stage.configure({ destination: landing(stage) });
    const ran = await entryPoint(stage);
    expect([ran.code, ran.err]).toEqual([0, ""]);
    expect(await sheetRow(stage, "job_success")).not.toBeNull();
  } finally {
    await stage.remove();
  }
}, SLOW);

// --- the device ------------------------------------------------------------

test("ROLL-32 DECLARED FAILING CONTROL: a destination on the staging directory's own device is refused before anything is dumped or uploaded", async () => {
  const stage = await backupStage(cluster);
  try {
    // The comparison is st_dev on both paths: a copy on the card that dies is
    // not a copy.
    const same = stage.sameDevice();
    stage.configure({ destination: same });
    stage.clearCalls();
    const { error } = await copy(stage);
    await failedWith(stage, error, "same device", "device");
    expect(stage.calls()).toEqual([]);
    expect(existsSync(join(stage.staging, "dump"))).toBe(false);
    expect(filesUnder(same)).toEqual([]);

    // A destination that does not exist yet is judged by the nearest part of
    // it that does, which is what a drive that is not plugged in looks like.
    const unplugged = join(same, "a-drive", "not", "mounted");
    stage.configure({ destination: unplugged });
    const again = await copy(stage);
    expect(again.error?.reason).toBe("same device");
    expect(stage.calls()).toEqual([]);
    expect(existsSync(join(same, "a-drive"))).toBe(false);
  } finally {
    await stage.remove();
  }
}, SLOW);

landed(`ROLL-32 the device control: the same copy aimed at another device is not refused${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster);
  try {
    const destination = landing(stage);
    expect(statSync(dirname(destination)).dev).not.toBe(statSync(stage.sameDevice()).dev);
    stage.configure({ destination });
    const { error } = await copy(stage);
    expect(error).toBeUndefined();
    expect(await sheetRow(stage, "job_success")).not.toBeNull();
  } finally {
    await stage.remove();
  }
}, SLOW);

// --- the dump's own repository ---------------------------------------------

test("ROLL-32 the dump's repository commits only when the dump changed, in both directions", async () => {
  const stage = await backupStage(cluster);
  try {
    // A full dump carries the previous copy's own stamp, so on a real box every
    // hour's dump differs from the last. The rule is proved on a dump of the
    // one table no copy writes to.
    stage.configure({ destination: AWAY, upload_argv: [stage.recorder, "/usr/bin/true"], dump_argv: inboundOnly(stage) });
    const commits = () => Number(fixtureGit(join(stage.staging, "dump"), "rev-list", "--count", "HEAD"));
    // Each copy gets past its commit and stops only at the read-back, which is
    // what says an unchanged dump was left alone rather than refused.
    const through = async () => expect((await copy(stage)).error?.code).toBe("readback");
    await through();
    expect(commits()).toBe(1);
    await through();
    expect(commits()).toBe(1);
    await stage.store.read.sql("insert into inbound (id, person, agent, body) values ('telegram:1000000001:2', 'p1', 'p1-lair', 'a later message')");
    await through();
    expect(commits()).toBe(2);
    expect(readFileSync(join(stage.staging, "dump", "hub.sql"), "utf8")).toContain("a later message");
  } finally {
    await stage.remove();
  }
}, SLOW);

// --- the exclusions --------------------------------------------------------

landed(`ROLL-32 the five exclusions are absent by path and by content from the staging directory and the destination, and every copied control string is present${gateSuffix(DEVICE)}`, async () => {
  const stage = await backupStage(cluster);
  try {
    // A destination whose name carries a space, a semicolon and a dollar sign,
    // which lands whole only if nothing read it as a shell word.
    const destination = landing(stage, "the copy; $HOME");
    stage.configure({ destination });
    expect((await copy(stage)).error).toBeUndefined();
    for (const root of [stage.staging, destination]) {
      for (const [name, secret] of Object.entries(stage.secrets)) {
        expect(existsSync(mirrored(root, secret.path)), `${name} by path under ${root}`).toBe(false);
        // The content search is what catches a secret that arrived under
        // another name.
        expect(filesHolding(root, secret.canary), `${name} by content under ${root}`).toEqual([]);
      }
      // The same search finds every string that SHOULD be there, so a search
      // that finds nothing at all cannot pass as one that works.
      for (const [name, planted] of Object.entries(stage.copied)) {
        expect(filesHolding(root, planted.canary).length, `${name} under ${root}`).toBeGreaterThan(0);
      }
    }
  } finally {
    await stage.remove();
  }
}, SLOW);

// --- argv, never a shell string --------------------------------------------

test("ROLL-32 every argv is run as argv: a destination carrying a space, a semicolon, a dollar sign and a placeholder's spelling arrives as one argument, filled once", async () => {
  const stage = await backupStage(cluster);
  try {
    const destination = `${AWAY} with a space; $HOME {path} and more`;
    stage.configure({
      destination,
      upload_argv: [stage.recorder, "/usr/bin/true", "{staging}", "{destination}"],
      readback_argv: [stage.recorder, "/bin/cat", "{destination}/{path}"],
    });
    stage.clearCalls();
    await copy(stage);
    const [upload, readback] = stage.calls();
    expect(upload).toEqual(["/usr/bin/true", stage.staging, destination]);
    // The `{path}` inside the destination is the destination's own text: the
    // fill is one pass, so a value is never read as a placeholder.
    expect(readback).toEqual(["/bin/cat", `${destination}/dump/hub.sql`]);
  } finally {
    await stage.remove();
  }
}, SLOW);

test("ROLL-32 no provider is named in the copy's source, no scheme is tested and no shell is started", () => {
  // Crude on purpose: this is the decision most easily lost to a helpful edit,
  // and a text scan is the one check that notices it.
  for (const file of ["src/backup/run.ts", "src/backup/manifest.ts"]) {
    const text = readFileSync(hubPath(file), "utf8");
    for (const provider of ["rsync", "rclone", "scp", "sftp", "ssh", "s3", "restic", "borg", "tailscale", "tailnet",
      "dropbox", "gdrive", "onedrive", "webdav", "smb", "nfs"]) {
      expect(new RegExp(`\\b${provider}\\b`, "i").test(text), `${file} names ${provider}`).toBe(false);
    }
    expect(text.includes("://"), `${file} carries a scheme`).toBe(false);
    expect(/startsWith\(["'][a-z]+:/i.test(text), `${file} tests a scheme`).toBe(false);
    for (const shell of [/["']\/bin\/(ba|z|da)?sh["']/, /["'](ba|z|da)?sh["']/, /Bun\.\$/, /child_process/, /shell\s*:/, /execSync|spawnSync\(["'`]/]) {
      expect(shell.test(text), `${file} starts a shell: ${shell}`).toBe(false);
    }
  }
});
