// Test infrastructure: the scaffolding every phase 2 check shares.
//
// Everything here READS. It makes a scratch state dir, it builds the userless
// store url the registry carries, and it reads the store and the chat log back
// through a superuser connection. It performs no step of the hub's own work:
// the store, the door, the runner, the settle, the claim, the cursor, the chat
// log and the tail are the real thing in every check, and only the platform and
// the loop are fixtures.
//
// D-68. The fixtures are p1 and p1-lair, and the chat id is a digit string,
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
  type MachineSpec,
  type PersonSpec,
  type RegistrySpec,
  type PresetSpec,
  type RunSpec,
} from "./registry.ts";
import { openStore, type Store } from "../../src/store/connect.ts";

export const PERSON = "p1";
export const AGENT = "p1-lair";
export const DOOR = "door-fake";
export const RUNNER = "runner-test";
export const CHAT = FAKE_CHAT;

// D-100. The second person, the second agent and the second runner, for the
// two-machine checks. The repository is public, so these are fixtures and not
// anybody's name.
export const PERSON2 = "p2";
export const AGENT2 = "p2-lair";
export const RUNNER2 = "runner-mac";

export async function scratchDir(what = "hub-phase2-"): Promise<string> {
  return await mkdtemp(join(tmpdir(), what));
}

/**
 * The store url a registry carries: D-36 says it names the database and no
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
}

export interface StoreReader {
  ledger(filter?: { stream?: string; subject?: string; kind?: string }): Promise<LedgerRow[]>;
  inbound(): Promise<InboundRow[]>;
  outbox(): Promise<OutboxRow[]>;
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
        `select id, person, agent, body, received_at, state, claimed_by, claim_deadline
         from inbound order by received_at, id`,
      )) as unknown as InboundRow[];
    },
    async outbox() {
      return (await rows(
        `select id, inbound_id, seq_in_reply, body, written_at, delivered_at
         from outbox order by id`,
      )) as unknown as OutboxRow[];
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

/** Every line of every dated file for this agent, oldest file first. */
export function chatLogLines(
  stateDir: string,
  person: string,
  agent: string,
): ChatLine[] {
  const dir = join(stateDir, person, "chatlog", agent);
  if (!existsSync(dir)) return [];
  const out: ChatLine[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".jsonl")) continue;
    const text = readFileSync(join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      out.push(JSON.parse(line) as ChatLine);
    }
  }
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
  // Phase 3. Each of these is ABSENT from the default spec, so every phase 2
  // check keeps loading the registry it loads today (D-76 and D-93's tolerance
  // is what makes that legal once the loader carries the new fields).
  /** D-76. The machines this file declares. */
  machines?: MachineSpec[];
  /** D-93. The people this file declares, each with its tree. */
  people?: PersonSpec[];
  /** The `[[run]]` entries, when the agents' implied set is not what is wanted. */
  run?: RunSpec[];
  /** Extra agents beyond the default `p1-lair`. */
  agents?: AgentSpec[];
  /** Extra or replacement `[hub]` settings. */
  hub?: Record<string, string | number>;
}

export async function stageHub(
  cluster: Cluster,
  options: StageOptions = {},
): Promise<StagedHub> {
  const db = await freshDatabase(cluster);
  const dir = await scratchDir();
  const storeUrl = userlessStoreUrl(cluster, db);
  const adapterName = `scripted-${crypto.randomUUID().slice(0, 8)}`;
  const fake = createFakePlatform({ name: "fake", probe: options.probe });
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

  const base: RegistrySpec = {
    hub: { store_url: storeUrl, state_dir: dir, ...(options.hub ?? {}) },
    ...(options.machines ? { machines: options.machines } : {}),
    ...(options.people ? { people: options.people } : {}),
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
// Phase 3 additions.
// ---------------------------------------------------------------------------

/**
 * A real `StoreLike` over the throwaway cluster, as the SUPERUSER.
 *
 * `runCheck`, `recordPeak` and `recordJobSuccess` take a store. In production
 * the hub opens it as `hub_hub`, which is a role the schema does not carry yet.
 * Opening as that role here would make every check in 03-03 and 03-04 red for
 * "role does not exist" rather than for the module the plan names, so the
 * fixture opens as the superuser and the ROLE fence stays bound where phase 1
 * and phase 2 bind it.
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
 * reason phase 2 gave for the door and the runner.
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
  const values: unknown[] = [
    row.id,
    row.person ?? PERSON,
    row.agent ?? AGENT,
    row.body,
  ];
  if (row.kind !== undefined) {
    columns.push("kind");
    values.push(row.kind);
  }
  if (row.receivedAt !== undefined) {
    columns.push("received_at");
    values.push(row.receivedAt);
  }
  try {
    // ONE transaction, the way the door's own step 2 is. Two commits would let
    // the first one notify a running runner before the received stamp landed,
    // which is a race the fixture would be introducing rather than observing.
    await conn.unsafe("begin");
    await conn.unsafe(
      `insert into inbound (${columns.join(", ")})
       values (${columns.map((_, i) => `$${i + 1}`).join(", ")})`,
      values,
    );
    await conn.unsafe(
      `insert into ledger_event (stream, subject, kind, actor)
       values ('inbound', $1, 'received', 'door')`,
      [row.id],
    );
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
