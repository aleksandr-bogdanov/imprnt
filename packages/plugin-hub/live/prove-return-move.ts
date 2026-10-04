// LIVE, PAID, TWO HOSTS, DISPOSABLE: one real Claude conversation moved Mac -> Pi -> Mac by the shipped movement machinery, the second move
// being a RETURN onto the Mac's retained copy. Not CI, not a test file. Importing this module has no side effects.
//
//   BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1 bun live/prove-return-move.ts \
//     --pi <user@host> --pi-src <abs packages/plugin-hub on the pi> --pi-bun <abs bun on the pi> \
//     --mac-bin <abs claude 2.1.286> --pi-bin <abs claude 2.1.285 on the pi> \
//     --mac-credential <abs .credentials.json> --pi-credential <abs .credentials.json on the pi> \
//     --model <id> [--effort low] --evidence-dir <abs dir> [--keep-scratch] [--keep-stderr] --allow-paid-call
//
// WHAT IS REAL: one throwaway Postgres on the Mac with the shipped schema, reached from the Pi through an ssh reverse forward bound to the
// Pi's loopback (no firewall, no service, nothing listening beyond loopback); a registry with two machines (`store_machine = "mac"`), each
// host with its own state directory, person tree and credential path, written ONCE on the Mac and cloned ONCE to the Pi, after which every
// byte the Pi's copy holds is installed by `deliverRegistry`; on EACH host the hub's registry delivery (`live/prove-hub-loop.ts`: the
// functions `hub/run.ts` ticks) and the production runner with the production adapters (`live/prove-engine-runner-child.ts`, observed by
// `live/engine-observer.ts`), each a process of its own; the production door on the Mac with the fake in-memory platform (every input is
// `fake.deliver`). The move is asked for by the model itself, through the production `hub_topic` tool, because the owner asked it to in
// the chat. The drain, export, preflight, import, activation, registry write, delivery, serve, note, return reconcile and resume check are
// all the runners' and the hubs' own; nothing here writes the store except through the door's ingestion.
//
// WHAT IS ADDED: the observer, the PATH pin of each host's build (as `live/prove-engine-runner.ts` does it), and the owner's move message
// naming its own message id (the shipped feed does not show the model message ids; the fake platform lets the id be chosen up front).
//
// THE SCENARIO: M1 (Mac) reads marker A with a tool, unsaid; M2 (Mac) the owner asks to move to pi; the move is waited for to be ACTIVE
// on pi; P1 (Pi) recalls A with no tool; P2 (Pi) reads marker B with a tool, unsaid; P3 (Pi) the owner asks to move back to mac; that move
// is waited for to be active (the RETURN: the Mac's retained copy archived, the latest session imported); M3 (Mac) recalls A and B with no
// tool. B was never on the Mac before the return, so only the session that came back from the Pi can hold it; A in the retained archive and
// not B shows the archive is the OLD copy.
//
// WHAT IS WRITTEN: `<evidence>/return-move-<stamp>-<tag>/` with `steps.jsonl`, the journals of both hosts, `replies.json` (0600, the
// delivered replies), `report.json`. The report is saved FIRST; then the processes, the forward, the cluster and both hosts' scratch go
// (unless --keep-scratch). EXIT: 0 PASS_SCOPED, 1 FAIL, 2 REFUSED, 4 CLEANUP_UNVERIFIED or INTERRUPTED.

import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { runDoor } from "../src/door/run.ts";
import { sessionDirFor } from "../src/runner/run.ts";
import { inboundId } from "../src/store/inbound.ts";
import { freshDatabase, hubPath, startCluster, type Cluster } from "../test/helpers/cluster.ts";
import { createFakePlatform, type FakePlatform } from "../test/helpers/fake-platform.ts";
import { storeReader, type StoreReader } from "../test/helpers/hub-fixture.ts";
import { writeRegistry, type RegistrySpec } from "../test/helpers/registry.ts";
import { scrub, type Observed } from "./engine-observer.ts";
import { alive, disposeScratch, EXIT_CODE, macBoxReadable, markerIn, readJournal, readyLine, recorded, SCRATCH_PREFIX, type Verdict } from "./prove-engine-runner.ts";

// ---------------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------------

export interface ReturnOptions {
  pi: string; piSrc: string; piBun: string; macBin: string; piBin: string; macCredential: string; piCredential: string;
  model: string; effort: string; evidenceDir: string; keepScratch: boolean; keepStderr: boolean;
  turnTimeoutMs: number; moveTimeoutMs: number;
}

const PATHS = ["--pi-src", "--pi-bun", "--mac-bin", "--pi-bin", "--mac-credential", "--pi-credential", "--evidence-dir"] as const;

export function parseReturnArgs(argv: readonly string[]): { ok: true; options: ReturnOptions } | { ok: false; refusal: string } {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--allow-paid-call" || arg === "--keep-scratch" || arg === "--keep-stderr") { switches.add(arg); continue; }
    if (![...PATHS, "--pi", "--model", "--effort", "--turn-timeout-ms", "--move-timeout-ms"].includes(arg)) return { ok: false, refusal: `unknown_argument ${arg}` };
    const value = argv[++i];
    if (value === undefined || value.startsWith("--") || values.has(arg)) return { ok: false, refusal: `bad_value ${arg}` };
    values.set(arg, value);
  }
  if (!switches.has("--allow-paid-call")) return { ok: false, refusal: "paid_call_not_allowed" };
  for (const flag of PATHS) {
    const value = values.get(flag);
    if (!value || !isAbsolute(value) || normalize(value) !== value) return { ok: false, refusal: `path_not_absolute ${flag}` };
  }
  const pi = values.get("--pi") ?? "";
  if (!/^[a-z_][a-z0-9_-]{0,31}@[A-Za-z0-9.-]{1,253}$/.test(pi)) return { ok: false, refusal: "pi_invalid (user@host)" };
  const model = values.get("--model") ?? "";
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(model)) return { ok: false, refusal: "model_invalid" };
  const effort = values.get("--effort") ?? "low";
  if (!/^[a-z]{1,16}$/.test(effort)) return { ok: false, refusal: "effort_invalid" };
  const bound = (flag: string, fallback: number) => { const n = Number(values.get(flag) ?? fallback); return Number.isInteger(n) && n >= 30_000 && n <= 3_600_000 ? n : null; };
  const turnTimeoutMs = bound("--turn-timeout-ms", 300_000);
  const moveTimeoutMs = bound("--move-timeout-ms", 900_000);
  if (turnTimeoutMs === null || moveTimeoutMs === null) return { ok: false, refusal: "bound_invalid" };
  return { ok: true, options: {
    pi, piSrc: values.get("--pi-src")!, piBun: values.get("--pi-bun")!, macBin: values.get("--mac-bin")!, piBin: values.get("--pi-bin")!,
    macCredential: values.get("--mac-credential")!, piCredential: values.get("--pi-credential")!, model, effort,
    evidenceDir: values.get("--evidence-dir")!, keepScratch: switches.has("--keep-scratch"), keepStderr: switches.has("--keep-stderr"),
    turnTimeoutMs, moveTimeoutMs,
  } };
}

// ---------------------------------------------------------------------------------------------------------
// The other host, over ssh only
// ---------------------------------------------------------------------------------------------------------

const SSH = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4"];
/** One shell word, single-quoted. */
export const shq = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`;

async function remote(host: string, command: string, input: string | null = null, boundMs = 60_000): Promise<{ code: number | null; out: string; err: string }> {
  const proc = Bun.spawn(["ssh", ...SSH, host, command], { stdin: input === null ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe" });
  const done = await Promise.race([proc.exited.then(() => true), Bun.sleep(boundMs).then(() => false)]);
  if (!done) { try { proc.kill("SIGKILL"); } catch { /* gone */ } }
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: done ? proc.exitCode : null, out, err };
}

// ---------------------------------------------------------------------------------------------------------
// Prompts. No marker is in any of them.
// ---------------------------------------------------------------------------------------------------------

function readPrompt(path: string): string {
  return `This is a memory test of our conversation; nothing in it is secret. Step 1: call your file-reading tool now on the file ${path}. ` +
    "Its content cannot be guessed, so you must actually read it. Step 2: remember the test label it holds; I will ask for it in a later " +
    "message of this same conversation. For the test, leave the label out of this reply only. After reading, reply with exactly one word: DONE";
}
function movePrompt(machine: string, id: string): string {
  return `Это моя явная просьба как владельца: перенеси этот чат на машину ${machine}. Используй инструмент hub_topic: action "move", ` +
    `destination_machine "${machine}", source_message_ids ["${id}"] (это id этого сообщения), request_key — любой новый. ` +
    "Тестовые метки в ответе не упоминай. Потом ответь одним коротким предложением по-русски.";
}
const RECALL_A = "Это продолжение нашей проверки памяти, метка не секретная. Не открывай никаких файлов и не используй никакие инструменты. " +
  "Напиши тестовую метку из файла, который ты прочитал по моей самой первой просьбе в этом разговоре. Ответь одним коротким предложением " +
  "по-русски, в котором есть эта метка.";
const RECALL_AB = "Снова без файлов и без инструментов: напиши обе тестовые метки из этого разговора, из первого и из второго прочитанного " +
  "файла. Ответь одним коротким предложением по-русски, в котором есть обе метки.";

// ---------------------------------------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------------------------------------

interface Proc { name: string; host: "mac" | "pi"; proc: ReturnType<typeof Bun.spawn>; pid: number | null; exited: boolean; journal: string; remoteJournal: string | null }
interface Turn {
  name: string; host: "mac" | "pi"; inbound: string; outcome: string; state: string | null; runner: string | null; executions: number;
  reply_chunks: number; posts_per_chunk: number[]; markers: Record<string, boolean>; actions: number | null; engine_session: string | null; elapsed_ms: number;
}

const POLL_MS = 1_000;
const TERMINAL = new Set(["completed", "failed", "interrupted", "stopped", "stop_unknown"]);

export async function runReturnProof(options: ReturnOptions, log: (line: string) => void = line => { process.stderr.write(line + "\n"); }): Promise<{ verdict: Verdict; exitCode: number; report: string | null }> {
  const refused = (why: string) => { log(`REFUSED ${why}`); return { verdict: "REFUSED" as Verdict, exitCode: EXIT_CODE.REFUSED, report: null }; };
  const redactions = [options.macCredential, options.piCredential];
  if (process.env.BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING !== "1") return refused("pipelining_not_disabled");
  if (process.platform !== "darwin") return refused("run_from_the_mac");
  const home = homedir();
  for (const file of [options.macBin, options.macCredential]) if (!existsSync(file) || !statSync(file).isFile()) return refused(`missing ${basename(file)}`);
  if (!macBoxReadable(realpathSync(options.macBin), home)) return refused("mac_bin_not_box_readable");
  if (!existsSync(options.evidenceDir) || !statSync(options.evidenceDir).isDirectory()) return refused("evidence_dir_invalid");
  // The Pi, by metadata only: reachable, the source, bun, the build and the credential are there.
  const pre = await remote(options.pi, `test -d ${shq(options.piSrc)} && test -x ${shq(options.piBun)} && test -x ${shq(options.piBin)} && test -f ${shq(options.piCredential)} && test -x /usr/bin/bwrap && echo ok`, null, 30_000);
  if (pre.out.trim() !== "ok") return refused(`pi_preflight (code ${pre.code})`);

  const tag = randomBytes(4).toString("hex");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const runDir = join(realpathSync(options.evidenceDir), `return-move-${stamp}-${tag}`);
  mkdirSync(runDir, { mode: 0o700 });
  const privateDir = join(runDir, "private");
  mkdirSync(privateDir, { mode: 0o700 });
  const stepsFile = join(runDir, "steps.jsonl");
  const step = (name: string, detail: Record<string, unknown> = {}): void => {
    appendFileSync(stepsFile, JSON.stringify({ at: new Date().toISOString(), step: name, ...detail }) + "\n", { mode: 0o600 });
    log(`[return-move] ${name}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
  };

  // SCRATCH on both hosts, each made by its own mkdtemp with the harness prefix.
  const macScratch = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), SCRATCH_PREFIX)));
  const macShim = realpathSync(mkdtempSync(`/private/tmp/${SCRATCH_PREFIX}bin-`));
  symlinkSync(options.macBin, join(macShim, "claude"));
  const madePi = await remote(options.pi, `mktemp -d /tmp/${SCRATCH_PREFIX}XXXXXXXX`);
  const piScratch = madePi.out.trim();
  if (madePi.code !== 0 || !new RegExp(`^/tmp/${SCRATCH_PREFIX}[A-Za-z0-9]{8}$`).test(piScratch)) {
    disposeScratch([macScratch, macShim]);
    return refused("pi_scratch_not_made");
  }
  const ids = { person: `test-${tag}`, agent: `test-${tag}-general`, door: `test-door-${tag}`, mac: `test-runner-mac-${tag}`, pi: `test-runner-pi-${tag}`,
    chat: `test-chat-${tag}`, credential: `test-cred-${tag}` };
  const mac = { state: join(macScratch, "state"), tree: join(macScratch, "trees", ids.person), registry: join(macScratch, "registry", "registry.toml") };
  const piSide = { state: `${piScratch}/state`, tree: `${piScratch}/trees/${ids.person}`, registry: `${piScratch}/registry/registry.toml`, shim: `${piScratch}/bin`,
    runnerJournal: `${piScratch}/runner-pi.journal.jsonl`, hubJournal: `${piScratch}/hub-pi.journal.jsonl` };
  // Each marker sits at the TOP of its tree and is gone before the move that leaves that tree: a move refuses to leave behind any entry of the
  // person's tree that it neither carries nor verifies (`move-scope.ts`, `workspace_carriage_required`), an emptied `notes/` included (measured).
  for (const dir of [mac.state, mac.tree, dirname(mac.registry)]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const markerA = `ZEPHYR-${randomBytes(4).toString("hex").toUpperCase()}`;
  const markerB = `ZEPHYR-${randomBytes(4).toString("hex").toUpperCase()}`;
  const fileA = join(mac.tree, `proof-a-${tag}.txt`);
  const fileB = `${piSide.tree}/proof-b-${tag}.txt`;
  writeFileSync(fileA, `${markerA}\n`, { mode: 0o600 });
  const madeTree = await remote(options.pi, `umask 077 && mkdir -p ${shq(piSide.state)} ${shq(piSide.tree)} ${shq(dirname(piSide.registry))} ${shq(piSide.shim)} && ` +
    `ln -s ${shq(options.piBin)} ${shq(`${piSide.shim}/claude`)} && cat > ${shq(fileB)} && echo ok`, `${markerB}\n`);
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  step("staged", { run: runDir, mac_scratch: macScratch, pi_scratch: piScratch, ids, marker_a_sha256: sha(markerA), marker_b_sha256: sha(markerB), pi_tree: madeTree.out.trim() === "ok" });

  // EVERYTHING BELOW IS UNDONE IN `finally`, in the order a stop needs.
  let interrupted: string | null = null;
  const onSignal = (name: string) => { if (interrupted === null) { interrupted = `signal ${name}`; log(`[return-move] ${name}: stopping`); } };
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const listen = () => { for (const name of signals) { process.removeAllListeners(name); process.on(name, () => onSignal(name)); } };
  listen();
  const procs: Proc[] = [];
  const failures: string[] = [];
  const cleanupErrors: string[] = [];
  const turns: Turn[] = [];
  const replies: { turn: string; chunks: string[] }[] = [];
  const store: Record<string, unknown> = {};
  const moves: Record<string, unknown>[] = [];
  const checks: Record<string, unknown> = {};
  let cluster: Cluster | null = null;
  let read: StoreReader | null = null;
  let door: { stop(): Promise<void> } | null = null;
  let fake: FakePlatform | null = null;
  let tunnel: ReturnType<typeof Bun.spawn> | null = null;
  let database = "never_started";
  let conversation: string | null = null;
  let nativeSession: string | null = null;
  let messageNo = 91_000;
  const saveReplies = () => writeFileSync(join(runDir, "replies.json"), JSON.stringify({ marker_a_sha256: sha(markerA), marker_b_sha256: sha(markerB), replies }, null, 2) + "\n", { mode: 0o600 });

  const fetchPi = async (from: string, to: string): Promise<void> => {
    const got = await remote(options.pi, `cat ${shq(from)} 2>/dev/null || true`);
    writeFileSync(to, got.out, { mode: 0o600 });
  };
  const journalOf = async (p: Proc): Promise<Observed[]> => {
    if (p.remoteJournal !== null) await fetchPi(p.remoteJournal, p.journal);
    return readJournal(p.journal);
  };

  const spawnLocal = async (name: string, script: string, args: string[], env: Record<string, string>): Promise<Proc> => {
    const journal = join(runDir, `${name}.journal.jsonl`);
    const stderr = options.keepStderr ? openSync(join(privateDir, `${name}.stderr`), "a", 0o600) : "ignore";
    const proc = Bun.spawn([process.execPath, "run", hubPath(script), ...args.map(arg => (arg === "<journal>" ? journal : arg))], {
      cwd: hubPath("."), env: { ...process.env, BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING: "1", ...env }, stdin: "ignore", stdout: "pipe", stderr,
    });
    if (typeof stderr === "number") closeSync(stderr);
    const p: Proc = { name, host: "mac", proc, pid: null, exited: false, journal, remoteJournal: null };
    procs.push(p);
    void proc.exited.then(() => { p.exited = true; });
    const said = await readyLine(proc.stdout as ReadableStream<Uint8Array>, 90_000);
    p.pid = said.pid ?? null;
    step(`${name}_${said.ready ? "ready" : "refused"}`, { pid: p.pid, ...(said.ready ? {} : { error: scrub(said.error ?? "", redactions) }) });
    if (!said.ready) throw new Error(`${name} did not start`);
    return p;
  };
  const spawnPi = async (name: string, script: string, args: string[], remoteJournal: string, env: Record<string, string>): Promise<Proc> => {
    const journal = join(runDir, `${name}.journal.jsonl`);
    const vars = Object.entries({ BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING: "1", PROVE_STOP_ON_STDIN_EOF: "1", ...env }).map(([key, value]) => `${key}=${shq(value)}`).join(" ");
    const command = `cd ${shq(options.piSrc)} && exec env ${vars} ${shq(options.piBun)} run ${shq(script)} ${args.map(shq).join(" ")} ${shq(remoteJournal)}`;
    const stderr = options.keepStderr ? openSync(join(privateDir, `${name}.stderr`), "a", 0o600) : "ignore";
    const proc = Bun.spawn(["ssh", ...SSH, options.pi, command], { stdin: "pipe", stdout: "pipe", stderr });
    if (typeof stderr === "number") closeSync(stderr);
    const p: Proc = { name, host: "pi", proc, pid: null, exited: false, journal, remoteJournal };
    procs.push(p);
    void proc.exited.then(() => { p.exited = true; });
    const said = await readyLine(proc.stdout as ReadableStream<Uint8Array>, 120_000);
    p.pid = said.pid ?? null;
    step(`${name}_${said.ready ? "ready" : "refused"}`, { pid: p.pid, ...(said.ready ? {} : { error: scrub(said.error ?? "", redactions) }) });
    if (!said.ready) throw new Error(`${name} did not start`);
    return p;
  };
  /** A process stopped the way it takes it: SIGTERM here, the end of its stdin there. Bounded; past the bound it is killed and that is said. */
  const stopProc = async (p: Proc, boundMs = 75_000): Promise<string> => {
    if (p.exited) return "exited_early";
    if (p.host === "mac") { try { p.proc.kill("SIGTERM"); } catch { /* gone */ } }
    else { try { (p.proc.stdin as { end(): void }).end(); } catch { /* gone */ } }
    const done = await Promise.race([p.proc.exited.then(() => true), Bun.sleep(boundMs).then(() => false)]);
    if (done) return "graceful";
    try { p.proc.kill("SIGKILL"); } catch { /* gone */ }
    cleanupErrors.push(`${p.name} did not stop within ${boundMs} ms and was killed`);
    return "killed";
  };

  /** The engine processes a host's runner journal recorded that are still alive there. */
  const livingOf = async (p: Proc): Promise<number[]> => {
    const { pids } = recorded(await journalOf(p));
    if (pids.length === 0) return [];
    if (p.host === "mac") return pids.filter(alive);
    const said = await remote(options.pi, `for p in ${pids.join(" ")}; do kill -0 $p 2>/dev/null && echo $p; done; true`);
    return said.out.split("\n").map(Number).filter(n => Number.isSafeInteger(n) && n > 1);
  };

  const runTurn = async (name: string, host: "mac" | "pi", text: string, runnerProc: Proc, wantMarkers: Record<string, string>, platformId?: string): Promise<Turn> => {
    const began = Date.now();
    const turn: Turn = { name, host, inbound: "", outcome: "not_sent", state: null, runner: null, executions: 0, reply_chunks: 0, posts_per_chunk: [],
      markers: {}, actions: null, engine_session: null, elapsed_ms: 0 };
    turns.push(turn);
    if (!fake || !read || interrupted !== null) { turn.outcome = "aborted"; return turn; }
    const before = fake.posts().length;
    const message = fake.deliver({ text, chat: ids.chat, ...(platformId ? { platform_message_id: platformId } : {}) });
    const id = inboundId(fake.platform.name, message.chat, message.platform_message_id);
    turn.inbound = id;
    step(`${name}_sent`, { inbound: id, host });
    for (;;) {
      if (interrupted !== null) { turn.outcome = "aborted"; break; }
      const rows = await read.sql("select state, runner from execution where inbound_id = $1 order by started_at", [id]);
      turn.executions = rows.length;
      const last = rows.at(-1);
      if (last) {
        turn.state = String(last.state);
        turn.runner = String(last.runner);
        if (TERMINAL.has(turn.state)) {
          if (turn.state !== "completed") { turn.outcome = "settled"; break; }
          const chunks = await read.sql("select body, delivered_at from outbox where inbound_id = $1 order by seq_in_reply", [id]);
          if (chunks.length > 0 && chunks.every(row => row.delivered_at !== null)) {
            const bodies = chunks.map(row => String(row.body));
            const posted = fake.posts().slice(before).filter(post => post.chat === ids.chat);
            turn.reply_chunks = bodies.length;
            turn.posts_per_chunk = bodies.map(body => posted.filter(post => post.text === body).length);
            for (const [label, marker] of Object.entries(wantMarkers)) turn.markers[label] = bodies.some(body => markerIn(body, marker));
            replies.push({ turn: name, chunks: bodies });
            saveReplies();
            turn.outcome = "settled";
            break;
          }
        }
      }
      if (runnerProc.exited) { turn.outcome = "runner_exited"; break; }
      if (Date.now() - began >= options.turnTimeoutMs) { turn.outcome = "timeout"; break; }
      await Bun.sleep(POLL_MS);
    }
    turn.elapsed_ms = Date.now() - began;
    const lines = await journalOf(runnerProc);
    const end = lines.filter((line): line is Extract<Observed, { kind: "turn_end" }> => line.kind === "turn_end" && line.message === id).at(-1);
    if (end) { turn.actions = end.actions; turn.engine_session = end.reported ?? end.session_id; }
    step(`${name}_${turn.outcome}`, { state: turn.state, runner: turn.runner, executions: turn.executions, posts_per_chunk: turn.posts_per_chunk,
      markers: turn.markers, actions: turn.actions, engine_session: turn.engine_session, elapsed_ms: turn.elapsed_ms });
    return turn;
  };

  /** The agent's newest move, waited for to be active on `to`. Every stage and block it passed is recorded. */
  const awaitMove = async (label: string, to: string, after: number): Promise<Record<string, unknown> | null> => {
    const began = Date.now();
    const seenStages: string[] = [];
    const blocks: string[] = [];
    let row: Record<string, unknown> | undefined;
    for (;;) {
      if (interrupted !== null) break;
      [row] = await read!.sql("select id, stage, block, source_machine, dest_machine, source_runner, dest_runner, native_session, native_state, note_state, " +
        "extract(epoch from created_at) * 1000 as created from topic_move where agent = $1 order by created_at desc limit 1", [ids.agent]);
      if (row && Number(row.created) >= after - 5_000) {
        const stage = String(row.stage);
        if (seenStages.at(-1) !== stage) { seenStages.push(stage); step(`${label}_stage`, { stage }); }
        const block = row.block === null ? null : scrub(JSON.stringify(row.block), redactions);
        if (block !== null && blocks.at(-1) !== block) { blocks.push(block); step(`${label}_block`, { block }); }
        if (stage === "active" && row.dest_machine === to) break;
        if (stage === "withdrawn" || stage === "awaiting_owner") break;
      }
      if (Date.now() - began >= options.moveTimeoutMs) break;
      await Bun.sleep(POLL_MS);
    }
    const out = row ? { label, id: String(row.id), stage: String(row.stage), from: row.source_machine, to: row.dest_machine, native_session: row.native_session,
      native_state: row.native_state, note_state: row.note_state, stages: seenStages, blocks, waited_ms: Date.now() - began } : { label, stage: "none", waited_ms: Date.now() - began };
    moves.push(out);
    step(`${label}_${out.stage === "active" && (out as { to?: unknown }).to === to ? "active" : "not_active"}`, out);
    return out.stage === "active" ? out : null;
  };

  let macRunner: Proc | null = null;
  let piRunner: Proc | null = null;
  try {
    // THE STORE, and the Pi's way to it: a reverse forward bound to the Pi's loopback.
    cluster = await startCluster();
    listen();
    const db = await freshDatabase(cluster);
    read = storeReader(cluster, db);
    const piPort = 20_000 + (randomBytes(2).readUInt16BE() % 20_000);
    tunnel = Bun.spawn(["ssh", ...SSH, "-N", "-o", "ExitOnForwardFailure=yes", "-R", `127.0.0.1:${piPort}:127.0.0.1:${cluster.port}`, options.pi], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let reached = false;
    for (let i = 0; i < 15 && !reached; i++) {
      await Bun.sleep(1_000);
      reached = (await remote(options.pi, `bash -c 'exec 3<>/dev/tcp/127.0.0.1/${piPort}' && echo ok`, null, 15_000)).out.trim() === "ok";
    }
    step("forward", { reached, pi_port: piPort });
    if (!reached) throw new Error("the reverse forward to the store did not come up");

    const macUrl = `postgres://127.0.0.1:${cluster.port}/${db}`;
    const spec: RegistrySpec = {
      hub: { store_url: macUrl, state_dir: mac.state, tick_seconds: 1, store_machine: "mac" },
      machines: [{ id: "mac", os: "macos", state_dir: mac.state }, { id: "pi", os: "linux", state_dir: piSide.state, store_url: `postgres://127.0.0.1:${piPort}/${db}` }],
      people: [{ id: ids.person, tree: mac.tree, general: ids.agent, allowed_senders: { [ids.door]: ["fixture-sender"] }, on: { pi: { tree: piSide.tree } } }],
      credentials: [{ id: ids.credential, kind: "claude-login", file: options.macCredential, owner: ids.person, on: { pi: { file: options.piCredential } } }],
      run: [
        { id: ids.door, kind: "door", machine: "mac", platform: "fake", person: ids.person, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
        { id: ids.mac, kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 1024, child_memory_limit_mb: 1536 },
        { id: ids.pi, kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 1024, child_memory_limit_mb: 1536 },
      ],
      presets: { proof: { adapter: "claude-code", model: options.model, provider: "anthropic", effort: options.effort, paid: "plan", credential: ids.credential } },
      agents: [{ id: ids.agent, person: ids.person, preset: "proof", chat: ids.chat, door: ids.door, runner: ids.mac }],
    };
    writeRegistry(dirname(mac.registry), spec);
    // The ONE clone: after it, the Pi's copy changes only by `deliverRegistry`.
    const cloned = await remote(options.pi, `umask 077 && cat > ${shq(piSide.registry)} && echo ok`, readFileSync(mac.registry, "utf8"));
    if (cloned.out.trim() !== "ok") throw new Error("the registry could not be cloned to the pi");
    step("registry", { digest: createHash("sha256").update(readFileSync(mac.registry)).digest("hex") });

    await spawnLocal("hub-mac", "live/prove-hub-loop.ts", [mac.registry, "mac", "<journal>"], {});
    await spawnPi("hub-pi", "live/prove-hub-loop.ts", [piSide.registry, "pi"], piSide.hubJournal, {});
    fake = createFakePlatform({ name: "fake" });
    const doorStart = new AbortController();
    const timer = setTimeout(() => doorStart.abort(), 60_000);
    try { door = await runDoor({ door: ids.door, registryFile: mac.registry, platform: fake.platform, signal: doorStart.signal }); } finally { clearTimeout(timer); }
    step("door_ready");
    const runnerEnv = (path: string) => ({ PATH: path, PROVE_REDACT: JSON.stringify(redactions), PROVE_STOP_BOUND_MS: "55000" });
    macRunner = await spawnLocal("runner-mac", "live/prove-engine-runner-child.ts", [mac.registry, ids.mac, "<journal>"], runnerEnv(`${macShim}:${process.env.PATH ?? ""}`));
    piRunner = await spawnPi("runner-pi", "live/prove-engine-runner-child.ts", [piSide.registry, ids.pi], piSide.runnerJournal,
      runnerEnv(`${piSide.shim}:${dirname(options.piBun)}:/usr/local/bin:/usr/bin:/bin`));

    // M1, then the marker file goes.
    const m1 = await runTurn("m1_read_a", "mac", readPrompt(fileA), macRunner, { a: markerA });
    unlinkSync(fileA);
    const [conv] = await read.sql("select id, native_session from conversation where agent = $1 and kind = 'master'", [ids.agent]);
    conversation = conv ? String(conv.id) : null;
    nativeSession = conv ? String(conv.native_session) : null;
    step("conversation", { conversation, native_session: nativeSession });
    if (m1.outcome !== "settled" || m1.state !== "completed") throw new Error("m1 did not complete");

    // M2: the owner asks for the move; the model asks the hub.
    const toPiId = String(++messageNo);
    const toPiAt = Date.now();
    await runTurn("m2_move_to_pi", "mac", movePrompt("pi", inboundId("fake", ids.chat, toPiId)), macRunner, { a: markerA }, toPiId);
    const first = await awaitMove("move_to_pi", "pi", toPiAt);
    checks.source_engine_alive_after_move_1 = await livingOf(macRunner);
    if (!first) throw new Error("the move to pi did not become active");

    // On the Pi: recall A, read B, then the owner asks to go back.
    await runTurn("p1_recall_a", "pi", RECALL_A, piRunner, { a: markerA, b: markerB });
    await runTurn("p2_read_b", "pi", readPrompt(fileB), piRunner, { a: markerA, b: markerB });
    const removedB = await remote(options.pi, `rm -f ${shq(fileB)} && test ! -e ${shq(fileB)} && echo ok`);
    checks.marker_b_removed = removedB.out.trim() === "ok";
    const toMacId = String(++messageNo);
    const toMacAt = Date.now();
    await runTurn("p3_move_to_mac", "pi", movePrompt("mac", inboundId("fake", ids.chat, toMacId)), piRunner, { a: markerA, b: markerB }, toMacId);
    const back = await awaitMove("move_to_mac", "mac", toMacAt);
    checks.source_engine_alive_after_move_2 = await livingOf(piRunner);
    if (!back) throw new Error("the move back to mac did not become active");

    // Back on the Mac: both, with no tool.
    await runTurn("m3_recall_ab", "mac", RECALL_AB, macRunner, { a: markerA, b: markerB });
  } catch (error) {
    failures.push(`scenario: ${scrub(error, redactions)}`);
    step("scenario_error", { error: scrub(error, redactions) });
  } finally {
    // THE RETAINED ARCHIVE, read before anything stops (the files only: never printed, only whether the markers are in them).
    if (conversation !== null) {
      try {
        const session = sessionDirFor(mac.state, ids.person, ids.agent, conversation);
        const parent = dirname(session);
        const archives = existsSync(parent) ? readdirSync(parent).filter(name => name.startsWith(`${basename(session)}-retained-`)) : [];
        const grepTree = (root: string): { a: boolean; b: boolean; files: number } => {
          let a = false; let b = false; let files = 0;
          const walk = (dir: string) => {
            for (const name of readdirSync(dir, { withFileTypes: true })) {
              const path = join(dir, name.name);
              if (name.isDirectory()) walk(path);
              else if (name.isFile() && name.name.endsWith(".jsonl")) { files += 1; const text = readFileSync(path, "utf8"); a ||= text.includes(markerA); b ||= text.includes(markerB); }
            }
          };
          if (existsSync(root)) walk(root);
          return { a, b, files };
        };
        checks.retained_archives = archives.map(name => ({ name: name.replace(basename(session), "<session>"), ...grepTree(join(parent, name, "session")) }));
        checks.current_session = grepTree(session);
      } catch (error) { failures.push(`archive read: ${scrub(error, redactions)}`); }
    }
    // Then everything stops, in the order a stop needs: runners (their engines with them), the door, the hubs, the forward, the store.
    const stops: Record<string, string> = {};
    for (const p of procs.filter(one => one.name.startsWith("runner-"))) stops[p.name] = await stopProc(p);
    if (door) {
      const stopped = await Promise.race([door.stop().then(() => true, () => false), Bun.sleep(30_000).then(() => false)]);
      stops.door = stopped ? "graceful" : "hung";
      if (!stopped) cleanupErrors.push("the door did not stop within 30 s");
    }
    for (const p of procs.filter(one => one.name.startsWith("hub-"))) stops[p.name] = await stopProc(p, 30_000);
    checks.stops = stops;
    // What each runner's sessions recorded and showed gone, and what is still alive.
    for (const p of procs.filter(one => one.name.startsWith("runner-"))) {
      const lines = await journalOf(p);
      const exits = lines.filter((line): line is Extract<Observed, { kind: "exit" }> => line.kind === "exit");
      const starts = lines.filter((line): line is Extract<Observed, { kind: "start" }> => line.kind === "start");
      const startFailed = lines.filter(line => line.kind === "start_failed").length;
      const living = await livingOf(p);
      checks[`${p.name}_sessions`] = { starts: starts.map(one => ({ start: one.start, plan: one.plan })), start_failed: startFailed,
        exits: exits.map(one => ({ start: one.start, confirmed: one.evidence?.confirmed === true, basis: one.evidence?.basis ?? null })), living };
      if (living.length > 0) cleanupErrors.push(`${p.name}: ${living.length} recorded engine process(es) still alive`);
      if (exits.length < starts.length - startFailed || exits.some(one => one.evidence?.confirmed !== true)) cleanupErrors.push(`${p.name}: an exit was not confirmed`);
    }
    if (piRunner) await fetchPi(piSide.hubJournal, join(runDir, "hub-pi.journal.jsonl"));
    if (read) {
      try {
        store.inbound = (await read.sql("select id, state from inbound where agent = $1 order by received_at", [ids.agent])).map(row => ({ id: String(row.id), state: String(row.state) }));
        store.executions = (await read.sql("select inbound_id, state, runner, native_session from execution where agent = $1 order by started_at", [ids.agent]))
          .map(row => ({ inbound: String(row.inbound_id), state: String(row.state), runner: String(row.runner), native_session: row.native_session === null ? null : String(row.native_session) }));
        store.conversation = (await read.sql("select id, machine, native_session, native_state, placement_generation from conversation where agent = $1 and kind = 'master'", [ids.agent]))
          .map(row => ({ id: String(row.id), machine: row.machine === null ? null : String(row.machine), native_session: String(row.native_session), native_state: String(row.native_state), placement_generation: Number(row.placement_generation) }));
        store.copies = (await read.sql("select move_id, machine, kind, generation, state from move_copy order by created_at")).map(row => ({ move: String(row.move_id), machine: String(row.machine), kind: String(row.kind), generation: Number(row.generation), state: String(row.state) }));
        store.move_ledger = (await read.sql("select kind, count(*)::int as n from ledger_event where kind like 'move.%' group by kind order by kind")).map(row => `${String(row.kind)}=${Number(row.n)}`);
        store.failures = (await read.sql("select kind, count(*)::int as n from ledger_event where kind like '%fail%' or kind like 'refused%' group by kind order by kind")).map(row => `${String(row.kind)}=${Number(row.n)}`);
        store.registry_installs = (await read.sql("select subject, count(*)::int as n from ledger_event where kind = 'registry.copy-installed' group by subject")).map(row => `${String(row.subject)}=${Number(row.n)}`);
        store.registry_agent_runner = { mac: /runner = "([^"]+)"/.exec(readFileSync(mac.registry, "utf8").split(`id = "${ids.agent}"`)[1] ?? "")?.[1] ?? null };
        store.outbox_undelivered = Number((await read.sql("select count(*)::int as n from outbox where delivered_at is null"))[0]?.n ?? -1);
      } catch (error) { cleanupErrors.push(`store read: ${scrub(error, redactions)}`); }
      await read.close().catch(() => {});
    }
    if (tunnel) { try { tunnel.kill("SIGTERM"); } catch { /* gone */ } await Promise.race([tunnel.exited, Bun.sleep(5_000)]); }
    if (cluster) database = await cluster.stop().then(() => "removed", error => { cleanupErrors.push(`cluster stop: ${scrub(error, redactions)}`); return "stop_failed_kept"; });
    for (const name of signals) process.removeAllListeners(name);
  }

  // THE JUDGMENT, from what was observed.
  const turn = (name: string) => turns.find(one => one.name === name);
  const need = (ok: boolean, name: string) => { if (!ok) failures.push(name); };
  for (const t of turns) {
    need(t.outcome === "settled" && t.state === "completed", `${t.name}_not_completed`);
    need(t.executions === 1, `${t.name}_executions_${t.executions}`);
    need(t.posts_per_chunk.length > 0 && t.posts_per_chunk.every(n => n === 1), `${t.name}_not_posted_exactly_once`);
  }
  const want = (name: string, ok: (t: Turn) => boolean, failure: string) => { const t = turn(name); need(t !== undefined && ok(t), `${name}_${failure}`); };
  want("m1_read_a", t => (t.actions ?? 0) >= 1 && t.runner === ids.mac && !t.markers.a, "tool_read_unsaid_on_mac");
  want("m2_move_to_pi", t => t.runner === ids.mac && (t.actions ?? 0) >= 1, "model_did_not_call_the_tool");
  want("p1_recall_a", t => t.runner === ids.pi && t.markers.a === true && t.actions === 0, "recall_a_on_pi");
  want("p2_read_b", t => t.runner === ids.pi && (t.actions ?? 0) >= 1 && !t.markers.b, "tool_read_unsaid_on_pi");
  want("p3_move_to_mac", t => t.runner === ids.pi && (t.actions ?? 0) >= 1, "model_did_not_call_the_tool");
  want("m3_recall_ab", t => t.runner === ids.mac && t.markers.a === true && t.markers.b === true && t.actions === 0, "recall_ab_on_mac");
  need(moves.length === 2 && moves.every(one => one.stage === "active"), "moves_not_both_active");
  const sessions = new Set(turns.map(one => one.engine_session).filter((one): one is string => one !== null));
  need(sessions.size === 1 && nativeSession !== null && sessions.has(nativeSession), "native_session_not_one");
  const macPlans = (checks["runner-mac_sessions"] as { starts?: { plan: { id: string; resume: boolean } | null }[] } | undefined)?.starts ?? [];
  const piPlans = (checks["runner-pi_sessions"] as { starts?: { plan: { id: string; resume: boolean } | null }[] } | undefined)?.starts ?? [];
  need(macPlans.length >= 2 && macPlans[0]?.plan?.resume === false && macPlans.slice(1).every(one => one.plan?.resume === true && one.plan.id === nativeSession), "mac_starts_not_fresh_then_resumed");
  need(piPlans.length >= 1 && piPlans.every(one => one.plan?.resume === true && one.plan.id === nativeSession), "pi_starts_not_resumed");
  need(Array.isArray(checks.source_engine_alive_after_move_1) && (checks.source_engine_alive_after_move_1 as number[]).length === 0, "mac_engine_alive_after_move_to_pi");
  need(Array.isArray(checks.source_engine_alive_after_move_2) && (checks.source_engine_alive_after_move_2 as number[]).length === 0, "pi_engine_alive_after_move_to_mac");
  const archives = (checks.retained_archives as { a: boolean; b: boolean; files: number }[] | undefined) ?? [];
  need(archives.length === 1 && archives[0].files >= 1 && archives[0].a && !archives[0].b, "retained_archive_not_the_old_copy");
  const current = checks.current_session as { a: boolean; b: boolean } | undefined;
  need(current !== undefined && current.a && current.b, "current_session_not_the_latest");
  const ledger = (store.move_ledger as string[] | undefined) ?? [];
  need(ledger.some(one => one.startsWith("move.return-archived=")) && ledger.some(one => one.startsWith("move.return-reconciled=")), "return_not_reconciled_in_ledger");
  need(store.outbox_undelivered === 0, "outbox_not_delivered");

  const writeReport = (cleanup: Record<string, unknown>): Verdict => {
    const unclean = cleanupErrors.length > 0;
    const verdict: Verdict = interrupted !== null ? "INTERRUPTED" : unclean ? "CLEANUP_UNVERIFIED" : failures.length === 0 ? "PASS_SCOPED" : "FAIL";
    writeFileSync(join(runDir, "report.json"), JSON.stringify({
      version: 1, kind: "return-move-proof", verdict, exit_code: EXIT_CODE[verdict], failures, cleanup_errors: cleanupErrors, interrupted,
      model: options.model, effort: options.effort, ids, hosts: { mac: { bin: realpathSync(options.macBin) }, pi: { host: options.pi.replace(/^[^@]*@/, ""), bin: options.piBin } },
      marker: { a_sha256: sha(markerA), b_sha256: sha(markerB) }, native_session: nativeSession, conversation, turns, moves, checks, store, cleanup,
      claims: "PASS_SCOPED means only: one real Claude conversation, asked by its owner through the door, had the model request a move with the " +
        "production tool; the runners and hubs of two real hosts (Mac 2.1.286, Pi 2.1.285) sharing one disposable store moved it to the Pi, " +
        "where it resumed the same native session and recalled a marker only the Mac's session held, then moved it BACK, archiving the Mac's " +
        "retained old copy (which holds the first marker and not the second) and resuming the latest session, which recalled both; every " +
        "input ran once and was answered once, and every engine process both runners recorded was shown gone.",
    }, null, 2) + "\n", { mode: 0o600 });
    return verdict;
  };
  writeReport({ database, scratch: options.keepScratch ? "kept_on_request" : "pending" });
  step("report_saved");
  let scratch = "kept_on_request";
  if (!options.keepScratch) {
    if (cleanupErrors.some(one => one.includes("still alive"))) scratch = "kept_process_alive";
    else {
      const local = disposeScratch([macScratch, macShim]);
      const gone = await remote(options.pi, `case ${shq(piScratch)} in /tmp/${SCRATCH_PREFIX}*) rm -rf -- ${shq(piScratch)};; esac; test ! -e ${shq(piScratch)} && echo ok`);
      if (gone.out.trim() !== "ok") cleanupErrors.push("pi scratch still present");
      cleanupErrors.push(...local.errors);
      scratch = local.errors.length === 0 && gone.out.trim() === "ok" ? "removed" : "removal_failed";
    }
  }
  if (!options.keepStderr) { try { if (readdirSync(privateDir).length === 0) rmdirSync(privateDir); } catch { /* left */ } }
  const verdict = writeReport({ database, scratch, mac: [macScratch, macShim], pi: [piScratch] });
  step(`scratch_${scratch}`);
  log(`[return-move] ${verdict} (${failures.length === 0 ? "no failures" : failures.join(", ")}) report=${join(runDir, "report.json")}`);
  return { verdict, exitCode: EXIT_CODE[verdict], report: join(runDir, "report.json") };
}

if (import.meta.main) {
  const parsed = parseReturnArgs(process.argv.slice(2));
  if (!parsed.ok) { process.stderr.write(`REFUSED ${parsed.refusal}\n`); process.exit(EXIT_CODE.REFUSED); }
  const result = await runReturnProof(parsed.options);
  process.exit(result.exitCode);
}
