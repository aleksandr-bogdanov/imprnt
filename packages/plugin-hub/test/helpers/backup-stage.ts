// Test infrastructure: a household worth copying off the box, and somewhere to
// copy it that is not the card it lives on.
//
// The scene is the shared-zone household the zone checks already build (a real
// vault per person, a real checkout of the shared zone inside each, both
// committed), plus everything else the copy has to carry or has to leave out: a
// store with rows in `inbound`, `outbox` and a state sheet, chat log files and
// an inbox file per person, the non-secret files the registry names, and a
// `[[run]]` entry of kind `backup` whose three argvs are ordinary tools.
//
// FIVE SECRETS ARE PLANTED ON PURPOSE, each carrying its own string, so a check
// can prove each one's bytes are absent from the copy. Two of them sit INSIDE a
// tree the copy walks (the store passwords in one person's vault project, a
// credential file in the other's), because a secret nothing ever walks past is
// excluded by accident and proves nothing about the exclusion. The token file
// is named by the registry, which is what a copy of "every file the registry
// names" would pick up. The session cache and the service logs sit under the
// state directory, which is what a copy of "the person's state" would pick up.
// A sixth string is planted in a file that IS copied, so a search that finds
// nothing anywhere cannot pass for a search that works.
//
// EVERY ARGV RUNS THROUGH A RECORDER the stage installs, a four-line shell
// script that appends its own arguments, NUL-separated, to a log and then runs
// them. It is how a check sees that an argument with a space, a semicolon and a
// dollar sign arrived as ONE argument, and that the upload never ran at all.
//
// THE SECOND DEVICE is the gate. A copy on the same device as the staging
// directory is refused by design, so a copy that lands needs a directory whose
// `st_dev` differs. On macOS that is a scratch disk image attached under this
// stage's own directory. On Linux it is a scratch directory under `/dev/shm`,
// the memory-backed filesystem every Linux box mounts, which needs no mount call
// and so works for an account with no capabilities. A root account gets a
// tmpfs mounted under the stage instead. `remove()` detaches and deletes it,
// including after a check failed.

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freshDatabase, pgPrefix, type Cluster } from "./cluster.ts";
import { storeReader, userlessStoreUrl, type StoreReader } from "./hub-fixture.ts";
import { fixtureGit } from "./rollout-git.ts";
import { writeRegistry, type RegistrySpec, type RunSpec } from "./registry.ts";
import { THIS_MACHINE, zoneStage, type ZonePerson, type ZoneStage } from "./zone-stage.ts";

/** The copy's own entry id. */
export const BACKUP_ENTRY = "backup-copy";

/** The four placeholders the job fills in, as the registry spells them. */
export const PLACEHOLDERS = ["{staging}", "{destination}", "{path}", "{out}"] as const;

export interface Gate {
  ok: boolean;
  reason: string;
}

function which(bin: string): string | null {
  const out = Bun.spawnSync(["/usr/bin/which", bin], { stdout: "pipe", stderr: "pipe" });
  const path = (out.stdout?.toString() ?? "").trim().split("\n")[0];
  return out.exitCode === 0 && path && existsSync(path) ? path : null;
}

/**
 * Whether this machine can give a directory on another device, asked once at
 * module load so a test name can carry the reason. It asks about capability and
 * provisions nothing: `otherDevice()` does that per stage, and a gate that said
 * yes and a provision that then failed is a red, never a skip.
 */
function probeDevice(): Gate {
  if (process.platform === "darwin") {
    return which("hdiutil")
      ? { ok: true, reason: "" }
      : { ok: false, reason: "no second device on darwin: hdiutil is not on PATH" };
  }
  if (process.platform === "linux") {
    const here = statSync(tmpdir()).dev;
    try {
      const shm = statSync("/dev/shm");
      if (shm.isDirectory() && shm.dev !== here) return { ok: true, reason: "" };
    } catch { /* no /dev/shm, asked below */ }
    if (process.getuid?.() === 0) return { ok: true, reason: "" };
    return { ok: false, reason: "no second device on linux: /dev/shm is absent or shares the temporary directory's device, and a tmpfs mount needs root" };
  }
  return { ok: false, reason: `no second device on ${process.platform}` };
}

function probePgDump(): Gate & { bin: string } {
  const bin = join(pgPrefix(), "pg_dump");
  return existsSync(bin)
    ? { ok: true, reason: "", bin }
    : { ok: false, reason: `pg_dump is not beside the cluster's own binaries in ${pgPrefix()}`, bin };
}

const DEVICE = probeDevice();
const PG_DUMP = probePgDump();

export function deviceGate(): Gate {
  return { ...DEVICE };
}

export function pgDumpGate(): Gate & { bin: string } {
  return { ...PG_DUMP };
}

/** The reason, in the TEST NAME, so a skip is never silent. */
export function gateSuffix(...gates: Gate[]): string {
  const shut = gates.filter((gate) => !gate.ok).map((gate) => gate.reason);
  return shut.length === 0 ? "" : ` [skipped: ${shut.join("; ")}]`;
}

export interface Planted {
  path: string;
  /** A string that exists in this file and nowhere else in the scene. */
  canary: string;
}

export interface BackupStageOptions {
  /** The dump command. Absent means a full `pg_dump` of the stage's database. */
  dump_argv?: string[];
  /** Leave the `backup` entry out of the registry, for a check about the household alone. */
  withoutEntry?: boolean;
}

export interface BackupStage {
  dir: string;
  registryFile: string;
  /** The `backup` entry's id. */
  entry: string;
  stateDir: string;
  /** `<state_dir>/backup`, where the copy is assembled. */
  staging: string;
  /** Where the registry currently says the copy goes. */
  readonly destination: string;
  store: { db: string; url: string; read: StoreReader };
  people: ZonePerson[];
  zone: ZoneStage;
  /** The three argvs the registry currently carries. */
  readonly argv: { dump: string[]; upload: string[]; readback: string[] };
  /** The five things that must never be copied, each with its own string. */
  secrets: {
    secretsDir: Planted;
    tokenFile: Planted;
    credentialFile: Planted;
    sessions: Planted;
    serviceLog: Planted;
  };
  /** Files that must be copied, each with its own string: the search's control. */
  copied: {
    committedNote: Planted;
    uncommitted: Planted;
    zoneNote: Planted;
    chatLine: Planted;
    inbox: Planted;
    namedFile: Planted;
  };
  /** Every non-secret file the registry names. */
  named: string[];
  /** Every chat log file and inbox file the stage planted, by absolute path. */
  chatFiles: string[];
  inboxFiles: string[];
  /** The recorder every argv runs through, and what it recorded, one list per call. */
  recorder: string;
  calls(): string[][];
  clearCalls(): void;
  /** Re-render the registry with a different destination or argv. */
  configure(change: { destination?: string; dump_argv?: string[]; upload_argv?: string[]; readback_argv?: string[] }): void;
  /** A directory on the staging directory's own device. */
  sameDevice(): string;
  /** A directory on another device, or why this machine cannot give one. */
  otherDevice(): { path: string } | { path: null; reason: string };
  remove(): Promise<void>;
}

/** A scratch directory a check can use as a destination on the staging's device. */
function scratchUnder(dir: string, name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function writeRecorder(dir: string): { recorder: string; log: string } {
  const log = join(dir, "argv.log");
  writeFileSync(log, "", "utf8");
  const recorder = join(dir, "record-argv");
  // One record per call: every argument NUL-terminated, then a record
  // separator. `exec "$@"` runs the real command with the arguments exactly as
  // they arrived, which is the thing the record is evidence about.
  writeFileSync(
    recorder,
    `#!/bin/sh\nprintf '%s\\0' "$@" >> ${JSON.stringify(log)}\nprintf '\\036' >> ${JSON.stringify(log)}\nexec "$@"\n`,
    "utf8",
  );
  chmodSync(recorder, 0o755);
  return { recorder, log };
}

function readCalls(log: string): string[][] {
  const text = readFileSync(log, "latin1");
  return text
    .split("\u001e")
    .filter((record) => record !== "")
    .map((record) => {
      const parts = record.split("\u0000");
      if (parts[parts.length - 1] === "") parts.pop();
      return parts.map((part) => Buffer.from(part, "latin1").toString("utf8"));
    });
}

function plant(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function canary(what: string): string {
  return `synthetic-${what}-${crypto.randomUUID()}`;
}

export async function backupStage(cluster: Cluster, options: BackupStageOptions = {}): Promise<BackupStage> {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "hub-backup-")));
  const db = await freshDatabase(cluster);
  const storeUrl = userlessStoreUrl(cluster, db);
  const read = storeReader(cluster, db);
  const config = join(base, "config");
  mkdirSync(config, { recursive: true });
  const { recorder, log } = writeRecorder(base);
  const mounted: { kind: "image" | "tmpfs" | "shm"; path: string; image?: string }[] = [];
  let zone: ZoneStage | null = null;

  try {
    // The household lives in its own directory so the stage's recorder, config
    // and destinations are never inside a vault the copy walks.
    const household = join(base, "household");
    mkdirSync(household, { recursive: true });

    const stateDir = join(household, "state");
    const staging = join(stateDir, "backup");
    // The two secrets planted inside walked trees need the vault paths, which
    // the zone stage decides, so the first render only reserves their names.
    const tokenFile: Planted = { path: join(config, "door-fake.token"), canary: canary("secret-token") };
    const named = {
      fragment: join(config, "p1-lair.fragment.md"),
      settings: join(config, "p1-lair.settings.json"),
      mcp: join(config, "p1-lair.mcp.json"),
      filing: join(config, "p1-filing-rules.md"),
    };
    const namedFile: Planted = { path: named.fragment, canary: canary("named-fragment") };
    plant(tokenFile.path, `${tokenFile.canary}\n`);
    plant(named.fragment, `# p1-lair\n\n${namedFile.canary}\n`);
    plant(named.settings, `{"synthetic": "settings"}\n`);
    plant(named.mcp, `{"mcpServers": {}}\n`);
    plant(named.filing, "# filing rules\n\nFile by domain.\n");

    let secretsDirPath = "";
    let credentialPath = "";
    const argv = {
      dump: options.dump_argv ?? [pgDumpGate().bin, "--dbname", cluster.url(db)],
      // `-f`, because a second copy lands on the first and git writes its
      // objects read-only, which a plain `cp` refuses to overwrite.
      upload: [recorder, "/bin/cp", "-R", "-f", "{staging}/.", "{destination}"],
      readback: [recorder, "/bin/cp", "{destination}/{path}", "{out}"],
    };
    let destination = scratchUnder(base, "same-device-destination");
    const handed: { spec: RegistrySpec | null } = { spec: null };

    const backupEntry = (): RunSpec => ({
      id: BACKUP_ENTRY,
      kind: "backup",
      machine: THIS_MACHINE,
      schedule: "hourly",
      memory_limit_mb: 256,
      destination,
      dump_argv: argv.dump,
      upload_argv: argv.upload,
      readback_argv: argv.readback,
    });

    const complete = (from: RegistrySpec): RegistrySpec => ({
      ...from,
      hub: { ...(from.hub ?? {}), store_url: storeUrl, state_dir: stateDir, secrets_dir: secretsDirPath },
      people: (from.people ?? []).map((one) => (one.id === "p1" ? { ...one, filing_rules: named.filing } : one)),
      credentials: [{ id: "p2-key", kind: "api-key", file: credentialPath, owner: "p2" }],
      presets: {
        daily: { adapter: "scripted-backup", model: "a-model-name", provider: "a-provider", effort: "medium", paid: "plan" },
      },
      agents: [
        { id: "p1-lair", person: "p1", preset: "daily", chat: "1000000001", door: "door-fake", runner: "runner-backup",
          fragment: named.fragment, settings: named.settings, mcp: named.mcp },
        { id: "p2-lair", person: "p2", preset: "daily", chat: "2000000001", door: "door-fake-2", runner: "runner-backup" },
      ],
      run: [
        ...(from.run ?? []),
        { id: "door-fake", kind: "door", machine: THIS_MACHINE, platform: "fake", person: "p1", token_file: tokenFile.path,
          schedule: "always", memory_limit_mb: 192 },
        { id: "door-fake-2", kind: "door", machine: THIS_MACHINE, platform: "fake", person: "p2", token_file: "/dev/null",
          schedule: "always", memory_limit_mb: 192 },
        { id: "runner-backup", kind: "runner", machine: THIS_MACHINE, schedule: "always", memory_limit_mb: 512,
          child_memory_limit_mb: 1024 },
        ...(options.withoutEntry ? [] : [backupEntry()]),
      ],
    });

    zone = await zoneStage(household, {
      provision: true,
      hub: { store_url: storeUrl, state_dir: stateDir },
      over: (from) => {
        handed.spec = from;
        return from;
      },
    });
    const people = zone.people;
    const p1 = zone.person("p1");
    const p2 = zone.person("p2");

    // The two walked secrets, now that the vaults exist.
    const secretsDir: Planted = { path: join(p1.vault, ".hub-secrets"), canary: canary("secret-store-password") };
    secretsDirPath = secretsDir.path;
    for (const role of ["hub_door", "hub_runner", "hub_agent", "hub_hub"]) {
      plant(join(secretsDir.path, `${role}.password`), `${secretsDir.canary}-${role}\n`);
    }
    const credentialFile: Planted = { path: join(p2.vault, ".credentials", "p2-key"), canary: canary("secret-credential") };
    credentialPath = credentialFile.path;
    plant(credentialFile.path, `${credentialFile.canary}\n`);

    const sessions: Planted = { path: join(stateDir, "p1", "sessions", "p1-lair", "a-session"), canary: canary("secret-session") };
    plant(join(sessions.path, "session.json"), `{"cache": "${sessions.canary}"}\n`);
    const serviceLog: Planted = { path: join(stateDir, "service-log"), canary: canary("secret-service-log") };
    plant(join(serviceLog.path, `${BACKUP_ENTRY}.out.log`), `${serviceLog.canary}\n`);

    // What IS copied, each with its own string.
    const committedNote: Planted = { path: p1.notePath("control-note"), canary: canary("committed-note") };
    plant(committedNote.path, `# Control note\n\n${committedNote.canary}\n`);
    zone.commitVault("p1", "a note that is committed");
    const zoneNote: Planted = { path: join(p2.zonePath, "shared-control.md"), canary: canary("zone-note") };
    plant(zoneNote.path, `# Shared control\n\n${zoneNote.canary}\n`);
    zone.commitZone("p2", "a note in the shared zone");
    // Written into the working tree and never committed, which is the whole
    // reason working trees are copied rather than repositories cloned.
    const uncommitted: Planted = { path: join(p2.vaultDir, "draft-unsaved.md"), canary: canary("uncommitted-draft") };
    plant(uncommitted.path, `# Draft\n\n${uncommitted.canary}\n`);

    const chatLine: Planted = { path: "", canary: canary("chat-line") };
    const chatFiles: string[] = [];
    for (const [person, agent] of [["p1", "p1-lair"], ["p2", "p2-lair"]] as const) {
      const at = new Date();
      const file = join(stateDir, person, "chatlog", agent, `${at.toISOString().slice(0, 10)}.jsonl`);
      const text = person === "p1" ? chatLine.canary : `a line in ${agent}'s chat`;
      plant(file, `${JSON.stringify({ id: `${agent}:1`, at: at.toISOString(), direction: "in", from: person, text })}\n`);
      chatFiles.push(file);
      if (person === "p1") chatLine.path = file;
    }
    const inbox: Planted = { path: join(stateDir, "p2", "inbox", "0a1b2c3d", "0.jpg"), canary: canary("inbox-file") };
    plant(inbox.path, `${inbox.canary}\n`);
    const inboxFiles = [inbox.path];

    // Rows the dump must carry.
    await read.sql("insert into inbound (id, person, agent, body) values ($1, 'p1', 'p1-lair', 'a message already in the store')", ["telegram:1000000001:1"]);
    await read.sql("insert into outbox (inbound_id, seq_in_reply, body) values ($1, 0, 'a reply already in the store')", ["telegram:1000000001:1"]);
    await read.sql("insert into state_row (sheet, id, data) values ('door_health', 'door-fake/1000000001', '{\"status\": \"healthy\"}'::jsonb)");

    const registryFile = zone.registryFile;
    const render = () => {
      if (handed.spec === null) throw new Error("the zone stage never handed over its registry spec");
      writeRegistry(dirname(registryFile), complete(handed.spec));
    };
    render();

    const otherDevice = (): { path: string } | { path: null; reason: string } => {
      const gate = deviceGate();
      if (!gate.ok) return { path: null, reason: gate.reason };
      const ready = mounted.find((one) => one.kind !== "shm" || existsSync(one.path));
      if (ready) return { path: ready.kind === "shm" ? ready.path : join(ready.path, "copies") };
      if (process.platform === "darwin") {
        const image = join(base, "device.dmg");
        const mount = join(base, "device-mount");
        mkdirSync(mount, { recursive: true });
        const made = Bun.spawnSync(["hdiutil", "create", "-size", "64m", "-fs", "HFS+", "-volname", "imprnt-backup-check",
          "-layout", "NONE", image], { stdout: "pipe", stderr: "pipe" });
        if (made.exitCode !== 0) throw new Error(`hdiutil create failed: ${made.stderr.toString()}`);
        const attached = Bun.spawnSync(["hdiutil", "attach", "-nobrowse", "-noverify", "-noautoopen", "-mountpoint", mount, image],
          { stdout: "pipe", stderr: "pipe" });
        if (attached.exitCode !== 0) throw new Error(`hdiutil attach failed: ${attached.stderr.toString()}`);
        mounted.push({ kind: "image", path: mount, image });
        return { path: scratchUnder(mount, "copies") };
      }
      if (process.getuid?.() === 0) {
        const mount = scratchUnder(base, "device-mount");
        const done = Bun.spawnSync(["mount", "-t", "tmpfs", "-o", "size=64m", "tmpfs", mount], { stdout: "pipe", stderr: "pipe" });
        if (done.exitCode === 0) {
          mounted.push({ kind: "tmpfs", path: mount });
          return { path: scratchUnder(mount, "copies") };
        }
      }
      const shm = mkdtempSync("/dev/shm/imprnt-backup-check-");
      mounted.push({ kind: "shm", path: shm });
      return { path: shm };
    };

    const stage: BackupStage = {
      dir: base,
      registryFile,
      entry: BACKUP_ENTRY,
      stateDir,
      staging,
      get destination() {
        return destination;
      },
      store: { db, url: storeUrl, read },
      people,
      zone,
      get argv() {
        return { dump: [...argv.dump], upload: [...argv.upload], readback: [...argv.readback] };
      },
      secrets: { secretsDir, tokenFile, credentialFile, sessions, serviceLog },
      copied: { committedNote, uncommitted, zoneNote, chatLine, inbox, namedFile },
      named: [named.fragment, named.settings, named.mcp, named.filing],
      chatFiles,
      inboxFiles,
      recorder,
      calls: () => readCalls(log),
      clearCalls: () => writeFileSync(log, "", "utf8"),
      configure(change) {
        if (change.destination !== undefined) destination = change.destination;
        if (change.dump_argv !== undefined) argv.dump = change.dump_argv;
        if (change.upload_argv !== undefined) argv.upload = change.upload_argv;
        if (change.readback_argv !== undefined) argv.readback = change.readback_argv;
        render();
      },
      sameDevice: () => scratchUnder(base, "same-device-destination"),
      otherDevice,
      async remove() {
        const errors: string[] = [];
        for (const one of mounted.reverse()) {
          if (one.kind === "image") {
            let gone = Bun.spawnSync(["hdiutil", "detach", one.path], { stdout: "pipe", stderr: "pipe" });
            if (gone.exitCode !== 0) gone = Bun.spawnSync(["hdiutil", "detach", "-force", one.path], { stdout: "pipe", stderr: "pipe" });
            if (gone.exitCode !== 0) errors.push(`hdiutil detach ${one.path}: ${gone.stderr.toString()}`);
          } else if (one.kind === "tmpfs") {
            const gone = Bun.spawnSync(["umount", one.path], { stdout: "pipe", stderr: "pipe" });
            if (gone.exitCode !== 0) errors.push(`umount ${one.path}: ${gone.stderr.toString()}`);
          } else {
            rmSync(one.path, { recursive: true, force: true });
          }
        }
        mounted.length = 0;
        await read.close().catch(() => {});
        if (zone) await zone.remove().catch(() => {});
        await rm(base, { recursive: true, force: true }).catch(() => {});
        if (errors.length > 0) throw new Error(`the stage could not take its second device down: ${errors.join("; ")}`);
      },
    };
    return stage;
  } catch (error) {
    for (const one of mounted) {
      if (one.kind === "image") Bun.spawnSync(["hdiutil", "detach", "-force", one.path]);
      else if (one.kind === "tmpfs") Bun.spawnSync(["umount", one.path]);
      else rmSync(one.path, { recursive: true, force: true });
    }
    await read.close().catch(() => {});
    if (zone) await zone.remove().catch(() => {});
    await rm(base, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Every regular file under a directory, relative to it, sorted. A link is not
 * followed, so a link planted into another person's tree is never read through.
 */
export function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const kind = lstatSync(path);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      if (kind.isDirectory()) walk(path, rel);
      else if (kind.isFile()) out.push(rel);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out.sort();
}

/** Whether any file under a directory holds this string, and which ones. */
export function filesHolding(root: string, needle: string): string[] {
  const bytes = Buffer.from(needle, "utf8");
  return filesUnder(root).filter((rel) => readFileSync(join(root, rel)).includes(bytes));
}

/** Where a path on the box lands inside a copy, which mirrors absolute paths under `files/`. */
export function mirrored(root: string, absolute: string): string {
  return join(root, "files", absolute.replace(/^\/+/, ""));
}

/** One more git commit in a checkout the stage owns, for a check that needs later work. */
export function commitAll(path: string, message: string): void {
  fixtureGit(path, "add", "-A");
  if (fixtureGit(path, "status", "--porcelain") !== "") fixtureGit(path, "commit", "-m", message);
}
