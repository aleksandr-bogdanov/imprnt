// Test infrastructure: the scaffolding every check shares.
//
// Everything here READS. It makes a scratch state dir, it builds the userless
// store url the registry carries, and it reads the store and the chat log back
// through a superuser connection. It performs no step of the hub's own work:
// the store, the door, the runner, the settle, the claim, the cursor, the chat
// log and the tail are the real thing in every check, and only the platform and
// the loop are fixtures.
//
// The fixtures are p1 and p1-lair, and the chat id is a digit string,
// because the repository is public.

import { mkdtemp, rm } from "node:fs/promises";
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  freshDatabase,
  startReadySubprocess,
  type Cluster,
  type ReadyProcess,
} from "./cluster.ts";
import {
  createFakePlatform,
  servePlatform,
  FAKE_CHAT,
  type FakePlatform,
} from "./fake-platform.ts";
import {
  createScriptedAdapter,
  serveAdapter,
  type AdapterServer,
  type ScriptedAdapter,
  type ScriptedOptions,
} from "./scripted-adapter.ts";
import {
  writeRegistry,
  type AgentSpec,
  type CredentialSpec,
  type MachineSpec,
  type PersonSpec,
  type RegistrySpec,
  type PresetSpec,
  type RunSpec,
  type StoreSpec,
} from "./registry.ts";
import { openStore, type Store } from "../../src/store/connect.ts";
import type { InboundSource } from "../../src/store/inbound.ts";

export const PERSON = "p1";
export const AGENT = "p1-lair";
export const DOOR = "door-fake";
export const RUNNER = "runner-test";
export const CHAT = FAKE_CHAT;

// The second person, the second agent and the second runner, for the
// two-machine checks. The repository is public, so these are fixtures and not
// anybody's name.
export const PERSON2 = "p2";
export const AGENT2 = "p2-lair";
export const RUNNER2 = "runner-mac";

export async function scratchDir(what = "hub-phase2-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), what));
}

/**
 * The store url a registry carries names the database and no
 * user, and the process supplies its own role. A check asserts that, so the
 * helper that builds it must not sneak one in.
 */
export function userlessStoreUrl(cluster: Cluster, database: string): string {
  return `postgres://127.0.0.1:${cluster.port}/${database}`;
}

export interface LedgerRow {
  seq: number;
  at: Date;
  stream: string;
  subject: string;
  kind: string;
  actor: string;
  detail: Record<string, unknown>;
}

export interface OutboxRow {
  id: number;
  inbound_id: string;
  seq_in_reply: number;
  body: string;
  written_at: Date;
  delivered_at: Date | null;
}

export interface InboundRow {
  id: string;
  person: string;
  agent: string;
  body: string;
  received_at: Date;
  state: string;
  claimed_by: string | null;
  claim_deadline: Date | null;
  /**
   * The door's own transcription step, on the row it belongs to. A row nothing
   * has touched reads five nulls and a zero, which is what makes every insert
   * that says nothing about them legal unchanged.
   */
  media_state: string | null;
  media_attempts: number;
  media_retry_at: Date | null;
  media_failure: Record<string, unknown> | null;
  media_done_at: Date | null;
}

/**
 * A notice is an outbox row with no message on it, so it carries its own
 * person and agent and the key that makes it the only one of its kind.
 */
export interface NoticeRow {
  id: number;
  kind: string;
  person: string | null;
  agent: string | null;
  inbound_id: string | null;
  notice_key: string | null;
  body: string;
  written_at: Date;
  delivered_at: Date | null;
}

export interface StoreReader {
  ledger(filter?: { stream?: string; subject?: string; kind?: string }): Promise<LedgerRow[]>;
  inbound(): Promise<InboundRow[]>;
  outbox(): Promise<OutboxRow[]>;
  /** The notice rows alone, in outbox order. */
  noticeRows(): Promise<NoticeRow[]>;
  /** The `outage` sheet, which is one row per credential id. */
  outageSheet(): Promise<{ sheet: string; id: string; data: Record<string, unknown> }[]>;
  /**
   * The `harvest` sheet, which is one row per chat, id `<person>/<agent>`.
   *
   * `updated_at` comes back with it, because check 11 asserts the watermark
   * landed inside the settling transaction rather than in one of its own.
   */
  harvestSheet(): Promise<
    { sheet: string; id: string; data: Record<string, unknown>; updated_at: Date }[]
  >;
  sheet(name: string): Promise<{ sheet: string; id: string; data: Record<string, unknown> }[]>;
  sql(query: string, values?: unknown[]): Promise<Record<string, unknown>[]>;
  pid(): Promise<number>;
  close(): Promise<void>;
}

/** A superuser reader, so a check sees everything both roles wrote. */
export function storeReader(cluster: Cluster, database: string): StoreReader {
  const conn = cluster.connect(database) as unknown as {
    unsafe(query: string, values?: unknown[]): Promise<unknown>;
    close(): Promise<void>;
  };
  const rows = async (query: string, values?: unknown[]) =>
    (await conn.unsafe(query, values)) as Record<string, unknown>[];
  return {
    async ledger(filter = {}) {
      const where: string[] = [];
      const values: unknown[] = [];
      for (const [column, value] of [
        ["stream", filter.stream],
        ["subject", filter.subject],
        ["kind", filter.kind],
      ] as [string, string | undefined][]) {
        if (value === undefined) continue;
        values.push(value);
        where.push(`${column} = $${values.length}`);
      }
      const found = await rows(
        `select seq, at, stream, subject, kind, actor, detail from ledger_event
         ${where.length ? `where ${where.join(" and ")}` : ""} order by seq`,
        values,
      );
      return found.map((r) => ({ ...r, seq: Number(r.seq) })) as LedgerRow[];
    },
    async inbound() {
      return (await rows(
        `select id, person, agent, body, received_at, state, claimed_by, claim_deadline,
                media_state, media_attempts, media_retry_at, media_failure, media_done_at
         from inbound order by received_at, id`,
      )) as unknown as InboundRow[];
    },
    async outbox() {
      // `outbox.id` is a bigserial, and this client hands a bigint column back
      // as a STRING, because the type's range is past what a double holds.
      // `OutboxRow.id` says `number` and a check that compares two of them
      // reads it as one, so the conversion happens here rather than at every
      // reader. A household's outbox id is nowhere near
      // 2^53, so nothing is lost by it.
      const found = await rows(
        `select id, inbound_id, seq_in_reply, body, written_at, delivered_at
         from outbox order by id`,
      );
      return found.map((row) => ({ ...row, id: Number(row.id) })) as unknown as OutboxRow[];
    },
    async noticeRows() {
      // The columns are the, so this reader throws a readable
      // "column does not exist" against the shipped schema. Every check that
      // calls it asserts the catalog first, so the red reason is the missing
      // object and never this helper.
      const found = await rows(
        `select id, kind, person, agent, inbound_id, notice_key, body,
                written_at, delivered_at
         from outbox where kind = 'notice' order by id`,
      );
      // The same bigserial, read as the number `NoticeRow.id` declares.
      return found.map((row) => ({ ...row, id: Number(row.id) })) as unknown as NoticeRow[];
    },
    async outageSheet() {
      return (await rows(
        "select sheet, id, data from state_row where sheet = 'outage' order by id",
      )) as unknown as {
        sheet: string;
        id: string;
        data: Record<string, unknown>;
      }[];
    },
    async harvestSheet() {
      return (await rows(
        `select sheet, id, data, updated_at from state_row
         where sheet = 'harvest' order by id`,
      )) as unknown as {
        sheet: string;
        id: string;
        data: Record<string, unknown>;
        updated_at: Date;
      }[];
    },
    async sheet(name) {
      return (await rows(
        "select sheet, id, data from state_row where sheet = $1 order by id",
        [name],
      )) as unknown as {
        sheet: string;
        id: string;
        data: Record<string, unknown>;
      }[];
    },
    sql: rows,
    async pid() {
      const [row] = await rows("select pg_backend_pid() as pid");
      return Number(row.pid);
    },
    close: () => conn.close(),
  };
}

export interface ChatLine {
  at: string;
  direction: string;
  from: string;
  text: string;
}

/**
 * The chat log path, computed by the TEST from the pinned shape, so a build
 * that writes somewhere else fails rather than being followed:
 * <state_dir>/<person>/chatlog/<agent>/<YYYY-MM-DD>.jsonl, the date from the
 * line's own time in UTC.
 */
export function chatLogFile(args: {
  stateDir: string;
  person: string;
  agent: string;
  at: Date;
}): string {
  const day = args.at.toISOString().slice(0, 10);
  return join(args.stateDir, args.person, "chatlog", args.agent, `${day}.jsonl`);
}

/**
 * Every line of every dated file for this agent, oldest file first.
 *
 * THE LAST LINE OF THE LAST FILE MAY BE HALF WRITTEN, and only
 * that one. This reader is handed to the fake platform as `outLineOnDisk`'s
 * probe, so it runs INSIDE the door's post attempt: a `JSON.parse` that throws
 * there throws out of `platform.post`, the door catches it as a refused post,
 * and the attempt is never recorded at all. An observation that can change what
 * it observes is not an observation, and the line a writer can be in the middle
 * of is the one it is appending, which is the last line of the file it is
 * appending to.
 *
 * Every other unparseable line still throws. A corrupt line in the middle of a
 * log is a real defect and a reader that swallowed it could not fail for the
 * right reason.
 */
export function chatLogLines(
  stateDir: string,
  person: string,
  agent: string,
): ChatLine[] {
  const dir = join(stateDir, person, "chatlog", agent);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .sort()
    .filter((name) => name.endsWith(".jsonl"));
  const out: ChatLine[] = [];
  files.forEach((name, nth) => {
    const lines = readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "");
    lines.forEach((line, at) => {
      const lastOfTheLast = nth === files.length - 1 && at === lines.length - 1;
      try {
        out.push(JSON.parse(line) as ChatLine);
      } catch (error) {
        if (!lastOfTheLast) throw error;
        // A line an appender has not finished. It is not on disk yet as far as
        // any reader is concerned, and it will be on the next read.
      }
    });
  });
  return out;
}

/** Raw lines of one dated file, so a check can count them exactly. */
export function chatLogRawLines(file: string): string[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

// ---------------------------------------------------------------------------
// One staged hub: a fresh database, a scratch state dir, a registry naming
// both, a platform the test owns and a loop the test drives.
//
// Scaffolding only. It starts no door and no runner: every check starts those
// itself, through the real `runDoor` and `runRunner`, because a fixture that
// did the production work would make the check prove nothing.
// ---------------------------------------------------------------------------

export interface StagedHub {
  db: string;
  stateDir: string;
  registryFile: string;
  storeUrl: string;
  fake: FakePlatform;
  scripted: ScriptedAdapter;
  /** Generated at run time, so no build can have branched on it. */
  adapterName: string;
  /** Set when `servers` was asked for. */
  platformUrl: string;
  adapterUrl: string;
  /** The adapter over the wire, when `servers` was asked for. It is what maps
   *  an agent to the pid of the real child the RUNNER's process spawned. */
  adapterServer: AdapterServer | null;
  read: StoreReader;
  stop(): Promise<void>;
}

export interface StageOptions {
  /** Put the platform and the loop behind http, for a subprocess check. */
  servers?: boolean;
  /** Observed inside every post attempt, before the platform answers. */
  probe?: (post: { chat: string; text: string }) => unknown;
  adapter?: ScriptedOptions;
  /** Extra or overriding preset settings for the one preset, `daily`. */
  preset?: PresetSpec;
  /** Replace the whole registry spec, given the pieces this stage built. */
  registry?: (base: RegistrySpec) => RegistrySpec;
  // Each of these is ABSENT from the default spec, so a check that declares
  // none of them keeps loading the registry it loads today: the loader tolerates
  // a file that carries fewer of the newer fields.
  /** The machines this file declares. */
  machines?: MachineSpec[];
  /** The people this file declares, each with its tree. */
  people?: PersonSpec[];
  /** The `[[run]]` entries, when the agents' implied set is not what is wanted. */
  run?: RunSpec[];
  /** Extra agents beyond the default `p1-lair`. */
  agents?: AgentSpec[];
  /** Extra or replacement `[hub]` settings. */
  hub?: Record<string, string | number>;
  // Both ABSENT from the default spec, so every shipped check keeps
  // loading the registry it loads today.
  /** The credentials this file declares. */
  credentials?: CredentialSpec[];
  /**
   * The language the DEFAULT person reads the door's lines in.
   *
   * A stage that names no people declares one for `p1` carrying this and no
   * tree, because a tree is what the box is drawn around and a stage that
   * grew one would be boxing every loop these checks run. A stage that names
   * its own people gets it on the entry for `p1`, when that entry says none.
   */
  language?: "en" | "ru";
  /**
   * What the staged platform is, beyond its name and its probe.
   *
   * `typingSeconds` is a platform's own documented lifetime (Telegram's 5,
   * Discord's 10), and a check that watches the cadence reads its bound off
   * the platform rather than writing a number beside itself. A fixture may
   * therefore declare a SHORT one and stay honest, which is what keeps a
   * cadence check seconds long instead of a minute.
   */
  platform?: { typingSeconds?: number; noTyping?: boolean };
  /** The `[store]` section, absent unless a check asks for one. */
  store?: StoreSpec;
  // Both ABSENT from the default spec, so no person carries a
  // harvester and no `[hub] imprnt` line appears unless a check asks.
  /**
   * The five harvest fields on the DEFAULT person's entry.
   *
   * A stage that names no people declares one for `p1` carrying these and no
   * tree, exactly as `language` already does, and a stage that names its own
   * people gets them on the entry for `p1` where that entry says none.
   */
  harvest?: {
    harvester?: string;
    vault?: string;
    quiet_minutes?: number;
    min_messages?: number;
    report?: boolean;
  };
  /**
   * `hub.imprnt`, the command the runner spawns to file a harvested
   * note. A check points it at the shim of `test/helpers/imprnt-shim.ts`, which
   * is what makes every harvest check drive the REAL apply.
   */
  imprnt?: string;
}

export async function stageHub(
  cluster: Cluster,
  options: StageOptions = {},
): Promise<StagedHub> {
  const db = await freshDatabase(cluster);
  const dir = await scratchDir();
  const storeUrl = userlessStoreUrl(cluster, db);
  const adapterName = `scripted-${crypto.randomUUID().slice(0, 8)}`;
  const fake = createFakePlatform({
    name: "fake",
    probe: options.probe,
    ...(options.platform ?? {}),
  });
  const scripted = createScriptedAdapter({
    name: adapterName,
    ...(options.adapter ?? {}),
  });

  let platform: { url: string; stop(): Promise<void> } | null = null;
  let adapter: AdapterServer | null = null;
  if (options.servers) {
    platform = await servePlatform(fake);
    adapter = await serveAdapter(scripted);
  }

  // The default person, declared only when a stage asked for a language or for
  // a harvest. An absent option renders no `[[people]]` table at all, which is
  // the file every check loads today.
  //
  // The harvest fields travel the same road `language` already travels,
  // and each one is filled in ONLY where the entry says nothing, so a check
  // that writes its own people keeps every value it wrote.
  const onDefault: PersonSpec = {
    id: PERSON,
    ...(options.language === undefined ? {} : { language: options.language }),
    ...(options.harvest?.harvester === undefined
      ? {}
      : { harvester: options.harvest.harvester }),
    ...(options.harvest?.vault === undefined ? {} : { vault: options.harvest.vault }),
    ...(options.harvest?.quiet_minutes === undefined
      ? {}
      : { harvest_quiet_minutes: options.harvest.quiet_minutes }),
    ...(options.harvest?.min_messages === undefined
      ? {}
      : { harvest_min_messages: options.harvest.min_messages }),
    ...(options.harvest?.report === undefined
      ? {}
      : { harvest_report: options.harvest.report }),
  };
  const declares = Object.keys(onDefault).length > 1;
  const people: PersonSpec[] | undefined = !declares
    ? options.people
    : options.people === undefined
      ? [onDefault]
      : options.people.map((one) => {
          if (one.id !== PERSON) return one;
          const filled: PersonSpec = { ...one };
          for (const [key, said] of Object.entries(onDefault)) {
            if (key !== "id" && filled[key] === undefined) filled[key] = said;
          }
          return filled;
        });

  const base: RegistrySpec = {
    hub: {
      store_url: storeUrl,
      state_dir: dir,
      // Absent unless a check asks, so the default stage's `[hub]` is
      // the one every shipped check already loads.
      ...(options.imprnt === undefined ? {} : { imprnt: options.imprnt }),
      ...(options.hub ?? {}),
    },
    ...(options.store ? { store: options.store } : {}),
    ...(options.machines ? { machines: options.machines } : {}),
    ...(people ? { people } : {}),
    ...(options.credentials ? { credentials: options.credentials } : {}),
    ...(options.run ? { run: options.run } : {}),
    presets: {
      daily: {
        adapter: adapterName,
        model: "a-model-name",
        provider: "a-provider",
        effort: "medium",
        paid: "plan",
        ...(options.preset ?? {}),
      },
    },
    agents: [
      {
        id: AGENT,
        person: PERSON,
        preset: "daily",
        chat: CHAT,
        door: DOOR,
        runner: RUNNER,
      },
      ...(options.agents ?? []),
    ],
  };
  const spec = options.registry ? options.registry(base) : base;
  const registryFile = writeRegistry(dir, spec);

  const read = storeReader(cluster, db);

  return {
    db,
    stateDir: dir,
    registryFile,
    storeUrl,
    fake,
    scripted,
    adapterName,
    platformUrl: platform?.url ?? "",
    adapterUrl: adapter?.url ?? "",
    adapterServer: adapter,
    read,
    async stop() {
      if (platform) await platform.stop();
      if (adapter) await adapter.stop();
      // Every real child this stage's loop still owns, reaped, so a suite that
      // spawned one never leaks the memory it was told to hold.
      for (const child of scripted.children()) child.kill();
      await read.close().catch(() => {});
      // The scratch dir is this stage's own, so it goes with it. Leaving it
      // behind is a side effect of running the suite, outside the package.
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// The machine, people and box fields.
// ---------------------------------------------------------------------------

/**
 * A real `StoreLike` over the throwaway cluster, as the SUPERUSER.
 *
 * `runCheck`, `recordPeak` and `recordJobSuccess` take a store. In production
 * the hub opens it as `hub_hub`, which is a role the schema does not carry yet.
 * Opening as that role here would turn every check that uses this fixture red
 * for "role does not exist" rather than for the module under test, so the
 * fixture opens as the superuser and the ROLE fence stays bound where the
 * store checks bind it.
 */
export async function superStore(
  cluster: Cluster,
  database: string,
): Promise<Store> {
  return await openStore({ url: cluster.url(database) });
}

/** One state sheet, read through a superuser connection. */
export interface SheetReader {
  rows(): Promise<{ id: string; data: Record<string, unknown>; updated_at: Date }[]>;
  row(id: string): Promise<{ id: string; data: Record<string, unknown>; updated_at: Date } | null>;
  close(): Promise<void>;
}

export function hubReader(
  cluster: Cluster,
  database: string,
  sheet: string,
): SheetReader {
  const conn = cluster.connect(database) as unknown as {
    unsafe(query: string, values?: unknown[]): Promise<unknown>;
    close(): Promise<void>;
  };
  const all = async () =>
    (await conn.unsafe(
      "select id, data, updated_at from state_row where sheet = $1 order by id",
      [sheet],
    )) as unknown as {
      id: string;
      data: Record<string, unknown>;
      updated_at: Date;
    }[];
  return {
    rows: all,
    async row(id) {
      return (await all()).find((r) => r.id === id) ?? null;
    },
    close: () => conn.close(),
  };
}

/**
 * The hub as a PROCESS, so a check that asserts "this pid did not change" is
 * asserting about a process and not about a handle in its own runtime. The same
 * reason the door and the runner have one.
 */
export async function startHub(
  registryFile: string,
  machine: string,
  unitDir?: string,
): Promise<ReadyProcess> {
  return await startReadySubprocess("test/helpers/hub-subprocess.ts", [
    registryFile,
    machine,
    ...(unitDir ? [unitDir] : []),
  ]);
}

/**
 * An inbound row written as the door role, with its received stamp, for a check
 * that needs a message on disk without running a door.
 *
 * `source` and `logReady` are what a message the DOOR accepted carries: the
 * source is the platform's own record of the line (its log id, its time, its
 * text) and `log_ready` says whether the chat log file already holds it. Both
 * are absent by default and then this insert is the insert it has always been,
 * which is what keeps every caller writing the row it writes today. A check
 * that plants a source and leaves `logReady` false is planting a message that
 * exists in the store and in no file anywhere, which is the whole of what a
 * runner on another machine has to read.
 */
export async function insertInbound(
  cluster: Cluster,
  database: string,
  row: {
    id: string;
    body: string;
    person?: string;
    agent?: string;
    kind?: string;
    receivedAt?: string;
    source?: InboundSource;
    logReady?: boolean;
    as?: string;
  },
): Promise<void> {
  const role = row.as ?? "hub_door";
  const conn = (role === "superuser"
    ? cluster.connect(database)
    : cluster.connectAs(role, database)) as unknown as {
    unsafe(query: string, values?: unknown[]): Promise<unknown>;
    close(): Promise<void>;
  };
  const columns = ["id", "person", "agent", "body"];
  const casts: string[] = ["", "", "", ""];
  const values: unknown[] = [
    row.id,
    row.person ?? PERSON,
    row.agent ?? AGENT,
    row.body,
  ];
  if (row.kind !== undefined) {
    columns.push("kind");
    casts.push("");
    values.push(row.kind);
  }
  if (row.receivedAt !== undefined) {
    columns.push("received_at");
    casts.push("");
    values.push(row.receivedAt);
  }
  if (row.source !== undefined) {
    columns.push("source");
    // The cast is written out and the value travels as the OBJECT, the way the
    // door's own insert writes one: handing the client a JSON string instead
    // lands a jsonb string in the column rather than the record, and every
    // reader of `source ->> 'text'` then reads null.
    casts.push("::jsonb");
    values.push(row.source);
  }
  if (row.logReady !== undefined) {
    columns.push("log_ready");
    casts.push("");
    values.push(row.logReady);
  }
  try {
    // ONE transaction, the way the door's own step 2 is. Two commits would let
    // the first one notify a running runner before the received stamp landed,
    // which is a race the fixture would be introducing rather than observing.
    await conn.unsafe("begin");
    await conn.unsafe(
      `insert into inbound (${columns.join(", ")})
       values (${columns.map((_, i) => `$${i + 1}${casts[i]}`).join(", ")})`,
      values,
    );
    // THE STAMP CARRIES THE SAME TIME THE COLUMN DOES (the
    // finding on check 24). A backdated `received_at` with a `received` stamp
    // at `now()` is a row whose own two records of when it arrived disagree,
    // and every reader derives from the LEDGER: the metrics measure
    // from the stamps, `check`'s stamp finding measures from them, and a
    // fixture that planted two different times would make a correct build fail
    // an oracle computed from the other one.
    if (row.receivedAt === undefined) {
      await conn.unsafe(
        `insert into ledger_event (stream, subject, kind, actor)
         values ('inbound', $1, 'received', 'door')`,
        [row.id],
      );
    } else {
      await conn.unsafe(
        `insert into ledger_event (at, stream, subject, kind, actor)
         values ($2, 'inbound', $1, 'received', 'door')`,
        [row.id, row.receivedAt],
      );
    }
    await conn.unsafe("commit");
  } finally {
    await conn.close();
  }
}

/**
 * A line in the chat log before anything starts.
 *
 * L2 rules that the runner feeds the tail of the log on every spawn, before any
 * human message, so a check that asserts what the loop was fed has to know
 * there is a tail to feed. Planting one line makes the tail non-empty, which
 * keeps the check clear of the question of what an EMPTY log's tail should do.
 * That question belongs to the build and to a later entry, not to a check that
 * is about something else.
 */
export function plantChatLine(args: {
  stateDir: string;
  person?: string;
  agent?: string;
  text: string;
  at?: Date;
}): ChatLine {
  const at = args.at ?? new Date();
  const person = args.person ?? PERSON;
  const agent = args.agent ?? AGENT;
  const line: ChatLine = {
    at: at.toISOString(),
    direction: "in",
    from: person,
    text: args.text,
  };
  const file = chatLogFile({ stateDir: args.stateDir, person, agent, at });
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(line) + "\n", "utf8");
  return line;
}


/**
 * Whether an out line carrying this text is ALREADY on disk.
 *
 * Handed to the fake platform as its probe, so the answer is taken inside the
 * post attempt rather than read afterwards. L2 says the door appends "before
 * sending", and a door that posts, catches the refusal, appends the line and
 * retries has written it before the SECOND send and after the first. Only an
 * observation made inside the first attempt tells those apart.
 *
 * It reads every dated file for the agent, so a line written either side of a
 * UTC midnight is still found.
 */
export function outLineOnDisk(args: {
  stateDir: string;
  person?: string;
  agent?: string;
}): (post: { chat: string; text: string }) => boolean {
  return (post) =>
    chatLogLines(
      args.stateDir,
      args.person ?? PERSON,
      args.agent ?? AGENT,
    ).some((line) => line.direction === "out" && line.text === post.text);
}

/** The runner the two-machine registry puts on the pi. */
export const RUNNER_PI = "runner-pi";

/**
 * One registry, two machines, two people, two runners, two agents, one agent
 * per runner. The default agent ships on `runner-test`, which this registry has
 * no entry for, so it is rewritten onto the pi's runner before the file is used.
 */
export async function stageTwoMachines(cluster: Cluster): Promise<StagedHub> {
  const it = await stageHub(cluster, {
    servers: true,
    machines: [
      { id: "pi", os: "linux" },
      { id: "mac", os: "macos" },
    ],
    people: [
      { id: PERSON, tree: "/var/lib/imprnt-hub/p1" },
      { id: PERSON2, tree: "/var/lib/imprnt-hub/p2" },
    ],
    hub: { shared_zone: "/var/lib/imprnt-hub/shared" },
    agents: [
      {
        id: AGENT2,
        person: PERSON2,
        preset: "daily",
        chat: `${CHAT}1`,
        door: "door-mac",
        runner: RUNNER2,
      },
    ],
    run: [
      {
        id: DOOR,
        kind: "door",
        machine: "pi",
        platform: "fake",
        person: PERSON,
        token_file: "/dev/null",
        schedule: "always",
        memory_limit_mb: 192,
      },
      {
        id: RUNNER_PI,
        kind: "runner",
        machine: "pi",
        schedule: "always",
        memory_limit_mb: 512,
        child_memory_limit_mb: 512,
      },
      {
        id: RUNNER2,
        kind: "runner",
        machine: "mac",
        schedule: "always",
        memory_limit_mb: 512,
        child_memory_limit_mb: 2048,
      },
    ],
  });
  const text = await Bun.file(it.registryFile).text();
  await Bun.write(
    it.registryFile,
    text.replace(/runner = "runner-test"/, `runner = "${RUNNER_PI}"`),
  );
  return it;
}

/** The machine a spoke stage puts the DOOR on, and the one its runner is on. */
export const DOOR_MACHINE = "pi";
export const SPOKE_MACHINE = "mac";

/**
 * The stage options that put an agent's door on one machine and its runner on
 * another, on top of whatever else a check is staging.
 *
 * Both entries are declared by name, because the refusal and the placement rule
 * are read off the two `machine` fields and an agent whose door has no `[[run]]`
 * entry at all is neither here nor there.
 */
export function spokeStage(): StageOptions {
  return {
    machines: [
      { id: DOOR_MACHINE, os: "linux" },
      { id: SPOKE_MACHINE, os: "macos" },
    ],
    run: [
      {
        id: DOOR,
        kind: "door",
        machine: DOOR_MACHINE,
        platform: "fake",
        person: PERSON,
        token_file: "/dev/null",
        schedule: "always",
        memory_limit_mb: 192,
      },
      {
        id: RUNNER2,
        kind: "runner",
        machine: SPOKE_MACHINE,
        schedule: "always",
        memory_limit_mb: 512,
        child_memory_limit_mb: 2048,
      },
    ],
    // The default agent ships on `runner-test`, which this registry has no entry
    // for, so it is moved onto the spoke's runner the way `stageTwoMachines`
    // moves its own.
    registry: (base) => ({
      ...base,
      agents: (base.agents ?? []).map((one) =>
        one.runner === RUNNER ? { ...one, runner: RUNNER2 } : one,
      ),
    }),
  };
}

/**
 * One registry with two machines, the default person and agent, the agent's
 * DOOR on `pi` and its RUNNER on `mac`.
 *
 * It creates NO chat log directory. A runner on the spoke has none, and a
 * helper that made one as a convenience would hide the whole point: the message
 * such a runner reads exists as a store row and in no file on its machine.
 *
 * The person's tree is made under the stage's own scratch dir, because a
 * registry carries an absolute path and the box binds it for real. A check that
 * declares its own people owns them whole, tree or no tree.
 */
export async function stageSpoke(
  cluster: Cluster,
  options: StageOptions = {},
): Promise<StagedHub> {
  const spoke = spokeStage();
  const placement = spoke.registry!;
  const theirs = options.registry;
  const ownPeople = options.people === undefined;
  return await stageHub(cluster, {
    ...spoke,
    ...(ownPeople ? { people: [{ id: PERSON, language: "en" }] } : {}),
    ...options,
    registry: (base) => {
      const placed = placement(base);
      // The tree is filled in here rather than in the spec above because the
      // scratch dir the path sits under is the stage's own and exists only once
      // `stageHub` has made it.
      const stateDir = String(base.hub?.state_dir ?? "");
      const tree = join(stateDir, "trees", PERSON);
      if (ownPeople) mkdirSync(tree, { recursive: true });
      const withTree = ownPeople
        ? {
            ...placed,
            people: (placed.people ?? []).map((one) =>
              one.id === PERSON ? { ...one, tree } : one,
            ),
          }
        : placed;
      return theirs ? theirs(withTree) : withTree;
    },
  });
}
