// Test infrastructure for the council tests. It PLANTS rows and processes the way a door, a runner and an
// engine would; it decides nothing the council code decides, so a check built on it proves the real thing.
//
// A staged hub with an owner, a master (`p1-lair`, with a chat), three workers that take jobs alone
// (`p1-w1`..`p1-w3`), and the connections a council's code runs on: the RUNNER's role for the tool and the
// settle, the DOOR's for the watcher and the approval hook.

import { taskDigest } from "../../src/door/dispatch.ts";
import { endAttempt } from "../../src/runner/execution.ts";
import { settleTurn, type TurnRecord } from "../../src/runner/settle.ts";
import { entryMachine, loadRegistry } from "../../src/registry/load.ts";
import { listAgents, senderAllowed } from "../../src/registry/entries.ts";
import { getPreset } from "../../src/registry/presets.ts";
import type { McpBinding } from "../../src/mcp/handlers.ts";
import type { StoreLike } from "../../src/store/connect.ts";
import type { ExitEvidence } from "../../src/adapters/types.ts";
import { conversationFor, markFeedIntent, openExecution, registerIncarnation, UNRESOLVED, type Conversation } from "../../src/store/conversations.ts";
import type { Cluster } from "./cluster.ts";
import { CHAT, DOOR, PERSON, RUNNER, stageHub, type StagedHub } from "./hub-fixture.ts";

export const WORKERS = ["p1-w1", "p1-w2", "p1-w3"] as const;
export const GONE: ExitEvidence = { confirmed: true, leader: "exited", descendants: "none", pids: [], survivors: [], via: "test" };
export const QUESTION = "Should the synthetic ledger be weighed twice?";

export const turnOf = (agent: string): TurnRecord => ({ agent, runner: "runner-a", preset: "daily", preset_id: "x", preset_settings: {}, input_tokens: 1,
  cached_input_tokens: 0, output_tokens: 1, price: null, plan_usage: null, raw_usage: {}, session_id: null, lacks: [], tail: false });

/** The roster an owner named: each worker exactly as configured, and a brief for each. */
export const roster = (workers: readonly string[] = ["p1-w1", "p1-w2"]) => workers.map(worker => ({
  worker_ref: worker, preset_ref: "daily", machine_ref: RUNNER, brief: `brief for ${worker}: give your own view and your reasons` }));

export const startArgs = (over: Record<string, unknown> = {}) => ({
  action: "start", request_key: "start-1", authority: { source_message_ids: ["h2"] }, question: QUESTION, participants: roster(), ...over });

/** Where a conversation of an agent is placed: the engine of its preset and the machine of the runner the registry gives it. */
export interface Placement { adapter: string; machine: string }

/**
 * The placement the staged registry really gives an agent, read the way the runner reads it (`runner/run.ts`: the machine is its
 * `[[run]]` entry's own, the empty string when the entry names none, and the engine is its preset's). A conversation the fixture
 * plants in advance is placed exactly there: the store records the placement of a conversation's first use and refuses any other
 * (`conversation elsewhere`), so a fixture that planted another one would be describing a hub in which a conversation follows an
 * agent across machines, which production refuses.
 */
function placementIn(registryFile: string, agent: string): Placement {
  const registry = loadRegistry(registryFile);
  const entry = listAgents(registry).find(one => one.id === agent);
  if (!entry) throw new Error(`fixture: ${agent} is not an agent of the staged registry`);
  return { adapter: getPreset(registry, entry.preset).adapter, machine: entryMachine(registryFile, entry.runner) };
}

export interface CouncilStage extends StagedHub {
  su: any;
  /** Where the staged registry places this agent's conversations (see `placementIn`). */
  placement(agent: string): Placement;
  runner: StoreLike;
  door: StoreLike;
  /** The master's conversation exactly as the store holds it (`conversationFor`), so an opening can be made against it. */
  master: Conversation;
  binding(attempt?: string | null, over?: Partial<McpBinding>): McpBinding;
  human(id: string, over?: { sender?: string; agent?: string; at?: string; kind?: string }): Promise<void>;
  count(table: string, where?: string): Promise<number>;
  jobsOf(council: string): Promise<{ id: string; agent: string; body: string; source: any; log_ready: boolean; kind: string; state: string }[]>;
  answer(job: string, text: string): Promise<void>;
  /**
   * A worker's attempt on a job that reached the engine and was interrupted: the job is held. A job that is already running is
   * interrupted by ending its own attempt; one nobody had opened is claimed, opened and then ended.
   */
  interrupt(job: string): Promise<{ execution: string; conversation: string }>;
  /** A worker's job claimed by a runner and its attempt opened and fed, and left running. */
  running(job: string): Promise<{ execution: string; conversation: string }>;
  /** A worker's job claimed by a runner and its attempt opened, and NOTHING fed to an engine: the attempt is only `claimed`. */
  claimed(job: string): Promise<{ execution: string; conversation: string }>;
  incarnate(): Promise<void>;
  /** The master's runner claims a row and hands it to the engine: an attempt of the master's own, fed and left running. */
  feed(row: string): Promise<{ id: string }>;
  /** That attempt settles with this reply. */
  settleMaster(row: string, attempt: { id: string }, reply: string, kind?: string): Promise<void>;
  /** The newest revision of a council. */
  revision(council: string): Promise<number>;
  /** A conversation for a member's job that a worker has not claimed, the way a claim would have made it: the store's whole row, as `openExecution` takes it. */
  conversationOf(job: string): Promise<Conversation>;
  close(): Promise<void>;
}

export async function councilStage(
  cluster: Cluster,
  track: <T extends { close(): Promise<void> }>(sql: T) => T,
  options: { general?: boolean; people?: Record<string, unknown>[]; workers?: readonly string[]; hub?: Record<string, string | number>;
    registry?: (base: any) => any } = {},
): Promise<CouncilStage> {
  const workers = options.workers ?? WORKERS;
  const it = await stageHub(cluster, {
    hub: options.hub,
    ...(options.registry ? { registry: options.registry as never } : {}),
    people: (options.people ?? [{ id: PERSON, allowed_senders: { [DOOR]: [PERSON] }, ...(options.general ? { general: "p1-lair" } : {}) }]) as never,
    agents: workers.map(id => ({ id, person: PERSON, preset: "daily", runner: RUNNER, mode: "on-demand" })) as never,
  });
  // The owner the fixture plants messages for is a DECLARED allowed sender of this door in the registry the tool will read: the
  // fixture proves that itself, so a test of "the owner's message" cannot pass or fail on a sender nobody allowed.
  if (!senderAllowed(loadRegistry(it.registryFile), PERSON, DOOR, PERSON)) throw new Error(`fixture: ${PERSON} is not a declared allowed sender of ${DOOR}`);
  const su = track(cluster.connect(it.db)) as any;
  const runner = { sql: track(cluster.connectAs("hub_runner", it.db)), url: cluster.url(it.db) } as StoreLike;
  const door = { sql: track(cluster.connectAs("hub_door", it.db)), url: cluster.url(it.db) } as StoreLike;
  const human = async (id: string, over: { sender?: string; agent?: string; at?: string; kind?: string } = {}) => {
    // `::text::jsonb` with the serialised object: a bare `::jsonb` on a string stores a jsonb SCALAR string, which the
    // tool's reader (`source.sender_id`) rightly refuses.
    await su.unsafe(`insert into inbound (id, person, agent, body, kind, source, received_at) values ($1, $2, $3, $4, $5, $6::text::jsonb, ${over.at ? "$7::timestamptz" : "now()"})`,
      [id, PERSON, over.agent ?? "p1-lair", `words of ${id}`, over.kind ?? "human",
        JSON.stringify({ log_id: id, at: new Date().toISOString(), door: DOOR, chat: CHAT, sender_id: over.sender ?? PERSON, text: `words of ${id}` }), ...(over.at ? [over.at] : [])]);
    const [planted] = await su.unsafe(`select jsonb_typeof(source) as shape, source ->> 'sender_id' as sender from inbound where id = $1`, [id]);
    if (planted.shape !== "object" || planted.sender !== (over.sender ?? PERSON)) throw new Error(`fixture ${id}: source is ${planted.shape}, sender ${planted.sender}`);
  };
  await human("h1");
  await human("h2");
  const placement = (agent: string) => placementIn(it.registryFile, agent);
  // The master's conversation is the one a real runner serves the owner's messages in, so it is placed where that runner places it.
  const master = await conversationFor(runner, { row: { id: "h1", person: PERSON, agent: "p1-lair", kind: "human" }, ...placement("p1-lair") });
  const binding = (attempt: string | null = null, over: Partial<McpBinding> = {}): McpBinding => ({
    store: runner, person: PERSON, agent: "p1-lair", conversation: master.id, kind: "master", registry: () => loadRegistry(it.registryFile), attempt: () => attempt, ...over });
  const count = async (table: string, where = "true") => Number((await su.unsafe(`select count(*)::int as n from ${table} where ${where}`))[0].n);
  const jobsOf = async (council: string) => Array.from(await su`select id, agent, body, source, log_ready, kind, state from inbound
    where kind = 'job' and source -> 'dispatch' -> 'council_round' ->> 'council' = ${council} order by id`) as never;
  const answer = async (job: string, text: string) => {
    const [row] = await su`select id, agent, source from inbound where id = ${job}`;
    await settleTurn(runner, { inboundId: row.id, kind: "job", person: PERSON, source: row.source, chunks: [text], turn: turnOf(row.agent) });
  };
  // The fixture's own claimant stands in for the staged runner, on the machine the registry gives that runner.
  const incarnate = async () => { await registerIncarnation(runner, { runner: "runner-a", incarnation: "one", machine: placement("p1-lair").machine, bootId: null }); };
  /** Claim the job for the fixture's own runner and open its attempt: the attempt is `claimed`, and nothing has been fed to any engine. */
  const openOnly = async (job: string) => {
    const [row] = await su`select id, person, agent, kind, source from inbound where id = ${job}`;
    const conversation = await conversationFor(runner, { row, ...placement(row.agent) });
    await su.unsafe(`update inbound set claimed_by = 'runner-a', claim_deadline = now() + interval '1 hour' where id = $1`, [job]);
    const attempt = await openExecution(runner, { row: { id: row.id, agent: row.agent }, conversation, runner: "runner-a", incarnation: "one", digest: taskDigest(job), nativeSession: null });
    return { attempt, conversation };
  };
  const open = async (job: string) => {
    const made = await openOnly(job);
    await markFeedIntent(runner, made.attempt, `task ${job}`);
    return made;
  };
  const running = async (job: string) => { await incarnate(); const made = await open(job); return { execution: made.attempt.id, conversation: made.conversation.id }; };
  const claimed = async (job: string) => { await incarnate(); const made = await openOnly(job); return { execution: made.attempt.id, conversation: made.conversation.id }; };
  // The attempt states the store calls unresolved: the process is not shown to be gone.
  const OWNED = UNRESOLVED.map(state => `'${state}'`).join(", ");
  const interrupt = async (job: string) => {
    await incarnate();
    // A job that ALREADY has an unresolved attempt (a worker is running it, see `running`) is interrupted by ending THAT attempt, which is
    // what an interruption is. A second claim and a second attempt are exactly what the store refuses for it (its claim guard refuses a
    // row whose agent has an unresolved attempt, and an agent has one at most), and would not be an interruption of what is running.
    // Only a job nobody has opened is claimed and opened first, the way the runner would, and then ended.
    const [owned] = Array.from(await su.unsafe(`select id, conversation_id from execution where inbound_id = $1 and state in (${OWNED})
      order by started_at desc, id limit 1`, [job])) as { id: string; conversation_id: string }[];
    const made = owned ? { attempt: { id: owned.id }, conversation: { id: owned.conversation_id } } : await open(job);
    await endAttempt(runner, { execution: made.attempt.id, evidence: GONE, cause: "gone" });
    return { execution: made.attempt.id, conversation: made.conversation.id };
  };
  const feed = async (rowId: string) => {
    await incarnate();
    await su.unsafe(`update inbound set claimed_by = 'runner-a', claim_deadline = now() + interval '1 hour' where id = $1`, [rowId]);
    const attempt = await openExecution(runner, { row: { id: rowId, agent: "p1-lair" }, conversation: master, runner: "runner-a", incarnation: "one", digest: "d", nativeSession: null });
    await markFeedIntent(runner, attempt, `body of ${rowId}`);
    return attempt;
  };
  const settleMaster = async (rowId: string, attempt: { id: string }, reply: string, kind = "report") => {
    const [row] = await su`select source from inbound where id = ${rowId}`;
    await settleTurn(runner, { inboundId: rowId, kind, person: PERSON, source: row.source, chunks: [reply], turn: turnOf("p1-lair"),
      execution: { id: attempt.id, runner: "runner-a", fence: { incarnation: "one" } } });
  };
  const revision = async (council: string) => Number((await su`select revision from council where id = ${council}`)[0].revision);
  const conversationOf = async (job: string) => {
    const [row] = await su`select id, person, agent, kind, source from inbound where id = ${job}`;
    return await conversationFor(runner, { row, ...placement(row.agent) });
  };
  return { ...it, su, runner, door, master, placement, binding, human, count, jobsOf, answer, interrupt, running, claimed, incarnate, feed, settleMaster, revision, conversationOf,
    async close() { await it.stop(); } };
}
