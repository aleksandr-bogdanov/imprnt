// Test infrastructure: a loop the test drives, through the five-verb seam.
//
// The runner is handed its adapter registry as a parameter, so a
// check can register this under a name generated at run time and drive a turn
// to any point. It implements the `Adapter` interface pinned in the seam
// contract and NOTHING else: there is no tool verb of any kind on it, which is
// what makes it the probe for "a reply that depends on the model calling
// anything" (SPEC section 2 Forbidden, L1).
//
// It answers deterministically, `reply to <the fed text>`, so a check asserts
// the exact reply and an invented or empty answer fails.
//
// Three independent gates. Each one stops the turn at its own step and the test
// resumes it:
//
//   holdReceipt   the second verb. The loop has the message and has not said so.
//   holdProgress  the third verb. The loop has said so and has produced nothing.
//   holdTurnEnd   the fourth verb. The loop has produced text and has not ended.
//
// With a gate off, that step runs on its own and the turn continues to the next
// gate, so the default is a whole turn and a check only names what it holds.
//
// What this fixture probes with progress held is the RUNNER: a message is
// fed and acknowledged and no `started` stamp may exist until the loop has
// actually produced something.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Adapter,
  AdapterCapabilities,
  AdapterProgress,
  AdapterSession,
  AdapterUsage,
  ExitEvidence,
  TurnEnd,
} from "../../src/adapters/types.ts";
import { groupOf, groupPresence, presence } from "../../src/os/tree.ts";
import type { Preset } from "../../src/registry/presets.ts";

/**
 * What the loop said when it would not answer, and the window it
 * reported, written out HERE rather than imported from `src/adapters/types.ts`,
 * because that file carries the earlier shape and nothing here creates
 * under `src/`. The same reason `test/helpers/units.ts` keeps its own copy of
 * the two unit prefixes.
 */
export interface TurnRefusal {
  cause: "login" | "window" | "other";
  said: string;
}

export interface WindowReading {
  /** 0.0 to 1.0, the highest window the loop reported. */
  utilization: number;
  /** ISO 8601, from that window's own reset. */
  resets_at: string | null;
}

/** A turn end carrying the two fields beside the three. */
export interface ScriptedTurnEnd extends TurnEnd {
  refused: TurnRefusal | null;
}

/** The usage a scripted turn reports, with the normalised window beside it. */
export interface ScriptedUsage extends AdapterUsage {
  window: WindowReading | null;
}

/**
 * What a scripted loop says when `refusals` is what put it there. A check
 * asserts this sentence, so a refusal the fixture invented is still the
 * fixture's own and never mistaken for a measured one.
 */
export const SCRIPTED_REFUSAL: TurnRefusal = {
  cause: "login",
  said: "the scripted loop refused this turn",
};

export interface FedMessage {
  id: string;
  text: string;
  at: number;
  /**
   * WHICH SESSION this message was fed into, one-based in `starts()` order.
   *
   * THE FINDING: without it every session appends to
   * one log, so a runner that opens an unused fresh harvester session and feeds
   * the slice into the RESIDENT agent session is indistinguishable from one
   * that does it properly. Counting feeds cannot tell them apart, and neither
   * can counting starts. The session identity is what makes the pair of
   * observations a discriminator.
   *
   * It is added, never substituted, so every shipped check that reads `id`,
   * `text` or `at` reads exactly what it reads today.
   */
  session: number;
}

export interface StartRecord {
  sessionId: string | null;
  /** The native session the runner asked for, or null when it asked for none. */
  session: { id: string; resume: boolean } | null;
  preset: Preset | null;
  at: number;
  /** Whether the runner handed this start a boxing hook. */
  wrapped?: boolean;
  /**
   * The directory this session was started in, or null when the caller
   * named none.
   *
   * A harvest turn runs in the person's VAULT ROOT rather than in the agent's
   * tree, because that is where `imprnt init` wrote the filing rules as the
   * directory's own CLAUDE.md. A fixture that did not record the cwd could not
   * say which directory the loop was really started in, so check 9 would have
   * nothing to assert.
   */
  cwd: string | null;
}

/** One real child spawn, as the adapter really made it. */
export interface SpawnRecord {
  /** The argv the child was spawned with, after the runner's hook. */
  argv: string[];
  /** Whether a hook was supplied at all. */
  wrapped: boolean;
  pid: number;
  /** The `-f` profile in that argv, when there is one. */
  profile: string | null;
  /** Whether that profile was on disk AT THE MOMENT of the spawn. */
  profileExisted: boolean | null;
  /** The child itself, so a check can read what it reported. */
  child: HeldChild;
}

/**
 * The `-f <profile>` of a `sandbox-exec` argv, and null for anything else.
 *
 * The fixture's own copy of one shape, the way `test/helpers/units.ts` keeps its
 * own copy of the two prefixes: an oracle that asked the boxing code where it
 * put the profile would agree with a build that never wrote one.
 */
function profileOf(argv: string[]): string | null {
  const at = argv.indexOf("-f");
  if (at < 0 || at + 1 >= argv.length) return null;
  if (!/sandbox-exec$/.test(argv[0] ?? "")) return null;
  return argv[at + 1];
}

export interface ScriptedOptions {
  name?: string;
  /** What this loop does not have. An adapter that lacks "stream" sends one
   *  progress event carrying the whole text just before the end of turn. */
  lacks?: readonly string[];
  usage?: AdapterUsage;
  sessionId?: string;
  /**
   * With this, `start` spawns a REAL child that holds memory on command
   * and the session's `pid` is that process's id. Without it `pid` is null and
   * every check behaves exactly as it does today, which is what keeps
   * the 65 green. A scripted adapter with a FAKE pid would make the memory kill
   * check unable to fail, which is why the child is real.
   */
  child?: boolean;
  /**
   * A path the real child tries to READ the moment it starts, and
   * reports on its own stdout.
   *
   * The child is what "wear the box" is about, and a child that is boxed cannot
   * reach another person's tree. Nothing outside the process can see that on
   * macOS (`sandbox-exec` execs in place, so the process's own argv is the
   * TARGET's and never names the tool), so the child says what it saw and the
   * check reads the answer. The channel is an inherited stdout pipe rather than
   * a file, because an already-open descriptor needs no rule in any profile.
   */
  probePath?: string;
  /**
   * Answer REFUSED for the first n turns, then reply normally.
   *
   * A refused turn replays the user line (so the receipt lands and the row
   * reaches `acked`, which is what the measured no-login wire
   * does) and produces NO text at all, so no `started` stamp can land and the
   * runner has nothing to write into the outbox.
   *
   * Every turn counts, the first real input of a session included (a session's
   * history rides with it, so there is no turn before it).
   */
  refusals?: number;
  /** The window every turn of this loop reports, until it is changed. */
  window?: WindowReading;
  /**
   * What this loop answers, given the message it was fed.
   *
   * A harvest turn's reply is an envelope of notes, and `scriptedReply` can
   * only say `reply to <text>`. With this UNSET the turn end is byte for byte
   * what it is today, which is what keeps every check
   * behaving exactly as it does now.
   *
   * It is read at the moment the turn ENDS, so `setAnswer` reaches the next
   * turn, and it does not touch the progress event: a scripted loop still
   * streams `reply to <text>` as it works, and only the answer changes.
   */
  answer?: (fed: { id: string; text: string }) => string;
  /**
   * What this loop says it can do. UNSET, the adapter says nothing, which is
   * what every shipped adapter fixture does and what the runner reads as
   * "nothing that has to be proved": no session id is asked for and no
   * interrupted conversation is resumed.
   */
  capabilities?: AdapterCapabilities;
  /**
   * With this, a session can say what became of its processes: it has none of its
   * own, so once the runner closes it nothing of it is left, and the evidence it
   * gives is confirmed. UNSET, a session gives no evidence and an attempt the
   * runner ends without a result is `unknown`, which is what every shipped
   * fixture gets and what keeps them as they were. A check that needs a refused
   * turn to leave a terminal, held attempt (the input is held with real exit proof)
   * and the agent free for its next row asks for this.
   */
  exitProof?: boolean;
  /**
   * With `child`, the real child leads a process group of its own (as `claude-code` asks for, and checked against the process table the
   * same way), the session reports it (`group()`), the processes under it (`processes()`) and an exit evidence computed from the PROCESS
   * TABLE: the leader gone, every process recorded under it gone and the group empty, on the `process-group` basis, and a survivor
   * otherwise. It is what a topic move's drain intent and its `process-group` evidence are made of, so nothing here is scripted.
   */
  group?: boolean;
  /**
   * With `group`, the child also starts a grandchild in its group that `close()` does NOT end (it signals the leader, as the adapter does),
   * so the evidence after a close is real survivors. `true` is every child; a list is the children (one-based, in `starts()` order) that
   * leave one. `kill()` of the child and `reap()` end what the fixture made: the leader through the handle it holds, and the grandchild
   * through a stop file in a scratch directory the fixture made for this child (see `spawnHolder`): nothing is ever signalled by number.
   */
  survivor?: boolean | number[];
  /** `start` waits, after it has been recorded in `starts()`, until `releaseStart()`: a spawn paused inside the adapter's start. */
  startGate?: boolean;
  /**
   * With `child`, the real child is spawned plain even when the runner hands `start` a boxing hook (`wrapped` in `starts()` still says it did). For
   * a check of the drain's process groups and survivors under a person that HAS a tree (a move's scope look needs one), which the box would
   * change on Linux (a pid namespace: a survivor's pid is not the host's; a read-only host: the survivor's scratch directory is not writable)
   * and which is not what such a check is about: that the child wears the box is `box-worn.test.ts`'s.
   */
  unboxed?: boolean;
}

// ---------------------------------------------------------------------------
// The real child: a `bun -e` that holds memory on command and reports nothing.
//
// It is spawned by whoever owns the SESSION, which for a runner under test is
// the runner's own process, so `ps -o ppid=` on it names the runner. That is
// what check 12 reads, and it is why the child cannot live on the scripted
// adapter's server side: the server runs inside the test process and its pid
// would be the wrong parent.
//
// It is told how much to hold through a file it derives from its OWN pid, so
// nothing has to be plumbed through argv and a test in another process can
// reach it with the pid it already has. A file rather than a signal because
// standard signals do not queue: two SIGUSR2 in flight can coalesce into one,
// and a coalesced grow is a flaky check.
// ---------------------------------------------------------------------------

/** Where a child of this pid reads the number of megabytes it should hold. */
export function growFileFor(pid: number): string {
  return join(tmpdir(), `hub-child-${pid}.grow`);
}

const HOLDER = `
const fs = require("fs");
const os = require("os");
const parent = process.ppid;
if (parent === 1 && process.pid !== 2) process.exit(0);
const file = os.tmpdir() + "/hub-child-" + process.pid + ".grow";
// The scratch directory the FIXTURE made for this child (only a child that leaves a survivor has one): the stop file in it is the shutdown
// protocol, so nothing has to signal a process by its number.
const scratch = process.env.HUB_HOLDER_SCRATCH || "";
// One line on stdout before anything else: what this child could
// read of the path it was pointed at. Outside a box it reads it; inside one it
// does not, and that difference is what "the agent's process wears the box"
// means from where a check stands.
const probe = process.env.HUB_BOX_PROBE || "";
if (probe !== "") {
  let saw = null;
  let refused = null;
  try { saw = fs.readFileSync(probe, "utf8"); } catch (e) { refused = String(e.code || e.message); }
  try {
    process.stdout.write(JSON.stringify({ probe: probe, saw: saw, refused: refused }) + "\\n");
  } catch (e) {}
}
// A grandchild in this child's own group that outlives it when only the leader is signalled (HUB_HOLDER_SURVIVOR). Its pid is written
// in the scratch directory (reporting data for the fixture, never a target), it ends itself when the stop file appears there, and after
// two minutes whatever happens, so a test that forgets it leaks nothing for long.
if (process.env.HUB_HOLDER_SURVIVOR === "1" && scratch !== "") {
  try {
    const grandchild = require("child_process").spawn(process.execPath,
      ["-e", "/* hub-child-survivor */ const fs = require('fs'); setTimeout(() => process.exit(0), 120000); setInterval(() => { if (fs.existsSync(process.env.HUB_HOLDER_SCRATCH + '/stop')) process.exit(0); }, 25);"], { stdio: "ignore" });
    fs.writeFileSync(scratch + "/survivor", String(grandchild.pid));
  } catch (e) {}
}
const CHUNK = 16 * 1024 * 1024;
const held = [];
setInterval(() => {
  // A child whose parent went away is a leak, and a suite that leaks one of
  // these leaks the memory it was told to hold.
  if (process.ppid !== parent) process.exit(0);
  if (scratch !== "" && fs.existsSync(scratch + "/stop")) process.exit(0);
  let want = 0;
  try { want = Number(fs.readFileSync(file, "utf8").trim()) || 0; } catch (e) {}
  while (held.length * 16 < want) {
    const b = Buffer.alloc(CHUNK);
    b.fill(1);
    held.push(b);
  }
}, 100);
setInterval(() => {}, 1000000000);
`;

export interface BoxProbe {
  /** The path the child was told to read. */
  probe: string;
  /** Its contents, when the child could read them. */
  saw: string | null;
  /** The errno the box refused it with, when it could not. */
  refused: string | null;
}

export interface HeldChild {
  pid: number;
  exited: Promise<number>;
  /** The argv this child was really spawned with, boxed or not. */
  argv: string[];
  /** The process group this child leads when it was started with `group` and the process table says it does; null otherwise. */
  group: number | null;
  /** Whether the leader has exited. */
  gone(): boolean;
  /** The grandchildren it started in its group (`survivor`), whether or not they are still there. */
  survivors(): number[];
  /** What the child reported about `probePath`, once it has said it. */
  boxProbe(): BoxProbe | null;
  /** Ends the child, its group and what it started: everything this fixture made. */
  kill(): void;
  /** Ends the leader alone, as the adapter's `close()` does: what it started in its group is left. */
  leave(): void;
}

export interface HolderOptions {
  /**
   * The runner's own boxing hook, applied to the argv this holder
   * would otherwise be spawned with. The fixture calls it and spawns whatever
   * comes back, so a wrap that returns a boxed argv puts the child in the box
   * and a missing one leaves it plain.
   */
  wrap?: (argv: string[]) => string[];
  /** A path the child tries to read at once and reports on stdout. */
  probePath?: string;
  /** The child leads a process group of its own, checked against the process table. */
  group?: boolean;
  /** The child starts a grandchild in its group that outlives it. */
  survivor?: boolean;
}

export function spawnHolder(options: HolderOptions = {}): HeldChild {
  const plain = [process.execPath, "-e", HOLDER];
  const argv = typeof options.wrap === "function" ? options.wrap(plain) : plain;
  const wants = typeof options.probePath === "string" && options.probePath !== "";
  let said: BoxProbe | null = null;
  // A child that leaves a survivor gets a scratch directory of its own, made HERE by the owner of the child and unique to it: the
  // survivor's pid is written there and the stop file that ends it is, so no file named by a pid in the shared temp dir is ever read
  // and no process is ever signalled by a number.
  const scratch = options.survivor ? mkdtempSync(join(tmpdir(), "hub-holder-")) : null;
  const extra: Record<string, string | undefined> = {
    ...(wants ? { HUB_BOX_PROBE: options.probePath } : {}),
    ...(scratch !== null ? { HUB_HOLDER_SURVIVOR: "1", HUB_HOLDER_SCRATCH: scratch } : {}),
  };
  const proc = Bun.spawn(argv, {
    // The default is UNCHANGED, deliberately: `test/runner-memory.test.ts` and
    // `test/check-peak.test.ts` get exactly the process they have today, and
    // only a caller that asked for a probe gets a pipe to drain.
    stdout: wants ? "pipe" : "ignore",
    stderr: "ignore",
    stdin: "ignore",
    env: Object.keys(extra).length > 0 ? { ...process.env, ...extra } : undefined,
    // ASKED FOR AND READ BACK, as `claude-code` does: a child that leads a group of its own, or one that turned out not to.
    ...(options.group ? ({ detached: true } as object) : {}),
  });
  const group = options.group && groupOf(proc.pid) === proc.pid ? proc.pid : null;
  /** What the child reported of its grandchild, for the fixture's reports (`processes()`, `exitEvidence`): never the target of a signal. */
  const survivors = (): number[] => {
    if (scratch === null) return [];
    try {
      const pid = Number(readFileSync(join(scratch, "survivor"), "utf8").trim());
      return Number.isInteger(pid) && pid > 1 ? [pid] : [];
    } catch {
      return [];
    }
  };
  let cleaned = false;
  if (wants) {
    void (async () => {
      // Read LINE BY LINE as they arrive. The holder never exits, so waiting
      // for the stream to end would wait for the kill, and the probe would
      // always read null at the moment a check asks for it.
      const reader = proc.stdout!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (value) buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf("\n");
          while (cut >= 0) {
            const line = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 1);
            cut = buffer.indexOf("\n");
            if (line.trim() === "") continue;
            try {
              const parsed = JSON.parse(line) as BoxProbe;
              if (typeof parsed.probe === "string") said = parsed;
            } catch {
              // A line that is not the probe is the child's own noise.
            }
          }
          if (done) return;
        }
      } catch {
        // The child went away, which is what a kill looks like from here.
      }
    })();
  }
  return {
    pid: proc.pid,
    exited: proc.exited,
    argv: [...argv],
    group,
    gone: () => proc.exitCode !== null || proc.signalCode !== null,
    survivors,
    boxProbe: () => (said ? { ...said } : null),
    leave() {
      try { proc.kill(9); } catch { /* already gone */ }
    },
    kill() {
      // ONCE: a second call (`close()`, then `reap()`, then the test's own cleanup) finds everything done and touches nothing, so a number
      // that was freed and taken by somebody else is never the target of anything this fixture does.
      if (cleaned) return;
      cleaned = true;
      // Everything this fixture made, the survivors of a leader that was signalled alone included: the grandchild is told to end by the stop
      // file only this fixture can write (a process group or a pid is never signalled by its number: whether the number is still ours cannot
      // be known from the process table once the group could have emptied and been taken again), and the leader is ended through the handle.
      if (scratch !== null) {
        try { writeFileSync(join(scratch, "stop"), ""); } catch { /* the directory is gone */ }
      }
      if (options.wrap && proc.exitCode === null) {
        const table = Bun.spawnSync(["ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
        if (table.exitCode !== 0) throw new Error("fixture process tree could not be read");
        const rows = table.stdout.toString().trim().split("\n").map(line => line.trim().split(/\s+/).map(Number));
        const own = new Set([proc.pid]);
        for (let size = -1; size !== own.size;) {
          size = own.size;
          for (const [pid, parent] of rows) if (own.has(parent)) own.add(pid);
        }
        for (const pid of [...own].reverse()) {
          try { process.kill(pid, 9); } catch {}
        }
      }
      try {
        proc.kill(9);
      } catch {
        // already gone, which is what a memory kill looks like
      }
      try {
        rmSync(growFileFor(proc.pid), { force: true });
      } catch {
        // the grow file may never have been written
      }
      if (scratch !== null) {
        // Only LOOKED at, for a bounded time and off the caller's path: the grandchild ends itself within a poll of the stop file (the group
        // is empty a moment after this returns: a caller that needs it waits for it). The directory goes only once nothing reported under it,
        // nor the group the leader led, is still there; if something is (a number somebody else holds, say), it is left for the temp dir and
        // never signalled.
        const quiet = (): boolean => !survivors().some(one => presence(one) === "present") && (group === null || groupPresence(group) !== "present");
        void (async () => {
          for (const until = Date.now() + 5000; Date.now() < until && !quiet();) await Bun.sleep(25);
          if (quiet()) { try { rmSync(scratch, { recursive: true, force: true }); } catch { /* already gone */ } }
        })();
      }
    },
  };
}

/** Tell a child to hold this many megabytes. It picks it up on its next poll. */
export function growChild(pid: number, mb: number): void {
  writeFileSync(growFileFor(pid), String(mb), "utf8");
}

/** The resident size of a process in BYTES, from the platform's own tool. */
export function residentBytes(pid: number): number {
  const out = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const kb = Number((out.stdout?.toString() ?? "").trim());
  // `ps -o rss=` is KILOBYTES on both platforms. Every number in the memory
  // seam is bytes, so the conversion happens at this reader's own edge.
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/**
 * Every holder child still alive anywhere on this box, by pid.
 *
 * THE FINDING: killing the children a fixture still TRACKS is a
 * cleanup path, not proof that none survived. This asks the platform instead,
 * and it can see a holder whose owner forgot it, including one left by an
 * earlier file. The marker is the grow-file name the holder script carries in
 * its own source, which `ps` prints because the script is its command line.
 */
export function survivingHolders(): number[] {
  const out = Bun.spawnSync(["ps", "-axo", "pid=,command="], {
    stdout: "pipe",
    stderr: "pipe",
  });
  return (out.stdout?.toString() ?? "")
    .split("\n")
    .filter((line) => line.includes("hub-child-") && line.includes("setInterval"))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

/** Whether a process is gone. A memory kill is asserted with this. */
export function childGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

/** `AdapterSession` with the child pid the memory watch reads. */
export interface ChildSession extends AdapterSession {
  readonly pid: number | null;
}

export interface ScriptedAdapter {
  adapter: Adapter;
  /** Every real child this adapter still owns, so a test can reap them. */
  children(): HeldChild[];
  /** Every real child spawn, with the argv it really used. */
  spawns(): SpawnRecord[];
  /** Every message handed to the loop, with the moment it happened. */
  fed(): FedMessage[];
  /** Every start or resume the runner asked for. */
  starts(): StartRecord[];
  /**
   * Every session that was CLOSED, by its one-based `starts()` index.
   *
   * COUNTING STARTS IS NOT ENOUGH: it cannot
   * tell a runner that closes each harvester session from one that leaks it and
   * opens another, and `close` is a method this fixture implements, so there is
   * nothing to stop it recording the call. The harvester's session
   * is closed when the turn ends, so nothing of it survives to the next
   * harvest, and this is what makes that assertable.
   */
  closes(): number[];
  /** How many `start` calls are paused inside the adapter right now (`startGate`, `holdStart`). */
  startsHeld(): number;
  /** Pause (or resume) every `start` from now on; resuming releases the ones that wait. */
  holdStart(on: boolean): void;
  /** Resume `start`, and release the ones that wait. */
  releaseStart(): void;
  /** End every child this fixture made, with its group and whatever it started: a survivor included. */
  reap(): void;
  holdReceipt(on: boolean): void;
  sendReceipt(messageId: string): void;
  holdProgress(on: boolean): void;
  sendProgress(event?: AdapterProgress): void;
  holdTurnEnd(on: boolean): void;
  endTurn(): void;
  /**
   * What the NEXT turn end reports. Two turns of one session can then carry
   * different numbers, which is what makes a turn record copied from another
   * turn fail rather than pass.
   */
  setUsage(usage: AdapterUsage): void;
  /**
   * What this loop refuses with from the next turn on, or null to answer
   * normally again. It overrides whatever `refusals` had left to run.
   */
  setRefusal(refusal: TurnRefusal | null): void;
  /** The window every turn from here on reports, or null for none at all. */
  setWindow(window: WindowReading | null): void;
  /**
   * What this loop answers from the next turn on, or null to go back to
   * `reply to <the fed text>`. A check that drives two harvests with two
   * different replies changes it between them.
   */
  setAnswer(answer: ((fed: { id: string; text: string }) => string) | null): void;
  /** The numbers this loop reports right now. A check asserts them exactly. */
  readonly usage: AdapterUsage;
  lacks: readonly string[];
}

export function scriptedReply(text: string): string {
  return `reply to ${text}`;
}

const DEFAULT_USAGE: AdapterUsage = {
  input_tokens: 1234,
  cached_input_tokens: 900,
  output_tokens: 210,
  plan_usage: null,
  raw: { input_tokens: 1234, cache_read_input_tokens: 900, output_tokens: 210 },
};

export function createScriptedAdapter(
  options: ScriptedOptions = {},
): ScriptedAdapter {
  const name = options.name ?? "scripted";
  const lacks = options.lacks ?? [];
  // The usage a turn end reports is read at the moment it fires, so a test can
  // give each turn of one session its own numbers.
  let usage: AdapterUsage = options.usage ?? { ...DEFAULT_USAGE };
  // Both are null by default, so a turn end carries exactly what it
  // carries today plus two nulls, and every check behaves
  // as it does now.
  let window: WindowReading | null = options.window ?? null;
  // Null means `scriptedReply`, which is what every shipped check gets.
  let answer: ((fed: { id: string; text: string }) => string) | null =
    options.answer ?? null;
  let countdown = options.refusals ?? 0;
  let standing: TurnRefusal | null = countdown > 0 ? { ...SCRIPTED_REFUSAL } : null;

  const fedLog: FedMessage[] = [];
  const startLog: StartRecord[] = [];
  /** One-based `starts()` indices of the sessions that were closed, in order. */
  const closeLog: number[] = [];
  const children: HeldChild[] = [];
  const spawnLog: SpawnRecord[] = [];
  let opened = 0;

  let gateReceipt = false;
  let gateProgress = false;
  let gateEnd = false;
  let startHeld = options.startGate === true;
  const startWaiters: (() => void)[] = [];

  // Handlers belong to the session that registered them. A respawn starts a
  // fresh session, and a fixture that kept one shared handler list would report
  // every event twice after it, which would look like a runner writing two
  // stamps for one turn.
  interface Live {
    receipt: ((messageId: string) => void)[];
    progress: ((event: AdapterProgress) => void)[];
    end: ((end: TurnEnd) => void)[];
    sessionId: string | null;
    /** One-based, in `starts()` order, so a fed message names its session. */
    nth: number;
  }

  let current: Live | null = null;

  /**
   * ONE OPEN TURN PER SESSION, not one per fixture (the finding
   * on check 17).
   *
   * A runner serves its agents concurrently (`src/runner/run.ts` runs one
   * `runAgent` per agent), and every agent opens its own session on the ONE
   * adapter its runner was handed. With a single `turn` field on the fixture,
   * two agents feeding it at the same time overwrote each other: the second
   * feed replaced the first, the first turn could never end, and a gate release
   * advanced only whichever feed happened to land last. Two checks then
   * depended on scheduling rather than on the door or the runner.
   *
   * A session can still have at most one turn open at a time, which is the
   * runner's own rule, so this is a map from the session to its turn rather
   * than a queue.
   */
  interface Turn {
    id: string;
    text: string;
    live: Live;
  }
  const turns = new Map<Live, Turn>();

  const fireReceipt = (live: Live, id: string) => {
    for (const h of live.receipt) h(id);
  };
  const fireProgress = (live: Live, event: AdapterProgress) => {
    for (const h of live.progress) h(event);
  };
  const fireEnd = (live: Live, end: TurnEnd) => {
    for (const h of live.end) h(end);
  };

  const step3 = (live: Live) => {
    const ending = turns.get(live);
    if (!ending) return;
    const refused = standing;
    // The countdown is spent on the turn it refused, so `refusals: 2` is two
    // refused turns and the third replies.
    if (refused && countdown > 0) {
      countdown -= 1;
      if (countdown === 0) standing = null;
    }
    // Built as a VARIABLE and not as a literal at the call, so the two fields
    // the window fields travel without an excess property error against the older
    // `TurnEnd` the handler is typed with.
    const end: ScriptedTurnEnd = {
      // The text is empty whenever a refusal is set, so a runner that
      // ignored the field would write an empty chunk rather than an apology.
      // A REFUSAL STILL WINS over `answer`: a loop that would not answer says
      // nothing, whatever a fixture would have had it say.
      text: refused
        ? ""
        : answer
          ? answer({ id: ending.id, text: ending.text })
          : scriptedReply(ending.text),
      session_id: ending.live.sessionId,
      usage: { ...usage, window } as ScriptedUsage,
      refused,
    };
    turns.delete(live);
    fireEnd(live, end);
  };

  const step2 = (live: Live) => {
    const open = turns.get(live);
    if (!open) return;
    if (gateProgress) return;
    // A refused turn produces NOTHING, so no `started` stamp can land on a row
    // the loop never began answering.
    if (!standing) fireProgress(live, { kind: "text", text: scriptedReply(open.text) });
    if (gateEnd) return;
    step3(live);
  };

  const step1 = (live: Live) => {
    const open = turns.get(live);
    if (!open) return;
    if (gateReceipt) return;
    fireReceipt(live, open.id);
    step2(live);
  };

  /** Every session with a turn open right now, oldest first. */
  const openSessions = (): Live[] => [...turns.keys()];

  const openOne = (
    sessionId: string | null,
    wrap?: (argv: string[]) => string[],
    nth = 0,
  ): ChildSession => {
    const live: Live = { receipt: [], progress: [], end: [], sessionId, nth };
    current = live;
    // The adapter is BOX-AGNOSTIC: it imports nothing from
    // `src/box/`, knows no tool name, and spawns whatever the hook it was
    // handed returns. What it records is the argv it really used, so a check
    // reads the production code's own output at the seam rather than asking
    // the boxing code whether it boxed.
    const leaves = options.survivor === true || (Array.isArray(options.survivor) && options.survivor.includes(nth));
    const held = options.child
      ? spawnHolder({ wrap: options.unboxed ? undefined : wrap, probePath: options.probePath, group: options.group === true, survivor: leaves })
      : null;
    if (held) {
      children.push(held);
      spawnLog.push({
        argv: [...held.argv],
        wrapped: typeof wrap === "function",
        pid: held.pid,
        // Read at the MOMENT of the spawn: a profile written after the child
        // started is a profile `sandbox-exec` already refused to open.
        profileExisted: profileOf(held.argv) === null ? null : existsSync(profileOf(held.argv)!),
        profile: profileOf(held.argv),
        child: held,
      });
    }
    return {
      get sessionId() {
        return live.sessionId;
      },
      // A handle property like `close`, never a sixth verb. Null means
      // this loop has no local child for a hub to watch.
      get pid() {
        return held ? held.pid : null;
      },
      get lacks() {
        return lacks;
      },
      ...(options.exitProof
        ? {
            async exitEvidence(): Promise<ExitEvidence> {
              return { confirmed: true, leader: "exited", descendants: "none", pids: [], survivors: [], basis: "process-group",
                via: "the scripted loop has no process of its own and the session was closed" };
            },
          }
        : {}),
      // A real child that leads a group of its own says what the PROCESS TABLE says of it, the way `claude-code` does: nothing is scripted.
      ...(options.group && held
        ? {
            group: () => held.group,
            processes: (): number[] => (held.gone() ? [] : [held.pid, ...held.survivors().filter(one => presence(one) === "present")]),
            partial: () => false,
            async exitEvidence(): Promise<ExitEvidence> {
              const until = Date.now() + 1000;
              while (Date.now() < until && !(held.gone() && (held.group === null || groupPresence(held.group) === "absent"))) await Bun.sleep(25);
              const pids = [held.pid, ...held.survivors()];
              const looked = pids.map(one => [one, presence(one)] as const);
              const survivors = looked.filter(([, said]) => said === "present").map(([one]) => one);
              const unknown = looked.filter(([, said]) => said === "unknown").map(([one]) => one);
              const inGroup = held.group === null ? null : groupPresence(held.group);
              const leader = held.gone() ? "exited" : "alive";
              const others = survivors.some(one => one !== held.pid) || (held.gone() && inGroup === "present");
              const verified = inGroup === "absent" && unknown.length === 0;
              const descendants = others ? "survivors" : verified ? "none" : "unverified";
              return { confirmed: leader === "exited" && descendants === "none" && !survivors.includes(held.pid), leader, descendants, pids, survivors, unknown,
                partial: false, group: held.group, basis: inGroup === "absent" ? "process-group" : "observed-tree",
                via: "the scripted child's process group and every process recorded under it, looked up again" };
            },
          }
        : {}),
      async feed(message: { id: string; text: string }): Promise<void> {
        fedLog.push({
          id: message.id,
          text: message.text,
          at: Date.now(),
          session: live.nth,
        });
        turns.set(live, { id: message.id, text: message.text, live });
        // The verbs are asynchronous in every real loop, so nothing lands
        // inside the caller's own call stack here either.
        queueMicrotask(() => step1(live));
      },
      onReceipt(handler) {
        live.receipt.push(handler);
      },
      onProgress(handler) {
        live.progress.push(handler);
      },
      onTurnEnd(handler) {
        live.end.push(handler);
      },
      async close(): Promise<void> {
        // Recorded BEFORE the teardown, and only once per session however often
        // a caller asks, so a double close is not a second session closed.
        if (live.nth > 0 && !closeLog.includes(live.nth)) closeLog.push(live.nth);
        live.receipt.length = 0;
        live.progress.length = 0;
        live.end.length = 0;
        turns.delete(live);
        // With a survivor the leader alone is signalled, as the adapter does, and what it started in its group is left for the evidence to find.
        if (held) { if (leaves) held.leave(); else held.kill(); await held.exited; }
      },
    };
  };

  const adapter: Adapter = {
    name,
    ...(options.capabilities ? { capabilities: async () => ({ ...options.capabilities! }) } : {}),
    async start(where: {
      preset: Preset;
      sessionId: string | null;
      session?: { id: string; resume: boolean };
      cwd?: string;
      /** The runner's boxing hook, applied to this loop's argv. */
      wrap?: (argv: string[]) => string[];
    }): Promise<AdapterSession> {
      startLog.push({
        sessionId: where.sessionId,
        session: where.session ? { ...where.session } : null,
        preset: where.preset ?? null,
        at: Date.now(),
        wrapped: typeof where.wrap === "function",
        // The directory the caller asked for, exactly, and null when it
        // asked for none. The runner passes `cwd` only when the box has one.
        cwd: where.cwd ?? null,
      });
      opened += 1;
      const nth = opened;
      // A start paused INSIDE the adapter, after the runner asked and before any process exists: what a request that arrives meanwhile has
      // to account for. It is released by `releaseStart`, and the child is made only then.
      if (startHeld) await new Promise<void>(resolve => startWaiters.push(resolve));
      return openOne(
        where.session?.id ?? where.sessionId ?? options.sessionId ?? `scripted-session-${nth}`,
        where.wrap,
        nth,
      );
    },
  };

  return {
    adapter,
    children: () => [...children],
    spawns: () => spawnLog.map((one) => ({ ...one, argv: [...one.argv] })),
    fed: () => fedLog.map((f) => ({ ...f })),
    starts: () => startLog.map((s) => ({ ...s })),
    closes: () => [...closeLog],
    startsHeld: () => startWaiters.length,
    holdStart(on) {
      startHeld = on;
      if (!on) for (const release of startWaiters.splice(0)) release();
    },
    releaseStart() {
      startHeld = false;
      for (const release of startWaiters.splice(0)) release();
    },
    reap() {
      for (const child of children) child.kill();
    },
    // A GATE IS THE FIXTURE'S, so releasing one releases every turn this
    // fixture is holding. With one session open that is what it always did.
    // With two, which is a runner serving two agents, it is what lets a check
    // hold both and release both, instead of whichever feed landed last.
    holdReceipt(on) {
      gateReceipt = on;
      if (!on) for (const live of openSessions()) step1(live);
    },
    // A RECEIPT FOR AN ID NOBODY FED STILL REACHES THE RUNNER. That is what
    // `test/runner-receipt.test.ts` is about: L1 says "only when the loop
    // acknowledges that exact message", and the RUNNER is what has to filter.
    // A fixture that swallowed the wrong id would make that check pass for the
    // fixture's reason instead of the runner's.
    sendReceipt(messageId) {
      const open = openSessions();
      const matching = open.filter((live) => turns.get(live)?.id === messageId);
      const heard = matching.length > 0 ? matching : open.length > 0 ? open : current ? [current] : [];
      for (const live of heard) fireReceipt(live, messageId);
      for (const live of matching) step2(live);
    },
    holdProgress(on) {
      gateProgress = on;
      if (!on) for (const live of openSessions()) step2(live);
    },
    sendProgress(event) {
      for (const live of openSessions()) {
        const open = turns.get(live)!;
        fireProgress(live, event ?? { kind: "text", text: scriptedReply(open.text) });
      }
    },
    holdTurnEnd(on) {
      gateEnd = on;
      if (!on) for (const live of openSessions()) step3(live);
    },
    endTurn() {
      for (const live of openSessions()) step3(live);
    },
    setUsage(next) {
      usage = next;
    },
    setRefusal(next) {
      standing = next;
      countdown = 0;
    },
    setWindow(next) {
      window = next;
    },
    setAnswer(next) {
      answer = next;
    },
    get usage() {
      return usage;
    },
    lacks,
  };
}

// ---------------------------------------------------------------------------
// The same loop, driven from another process.
//
// The runner kill test runs the real `runRunner` inside a `bun` child, so the
// adapter it is handed has to reach back across a socket to the test that holds
// the gates. Events travel as one JSON object per line on a streaming response,
// which is what lets the test release a gate while the child is mid-turn.
// ---------------------------------------------------------------------------

/**
 * What one session over the wire did: the messages it was fed and the pid of
 * the real child the CLIENT spawned for it.
 *
 * This is how a check maps an agent to its child across a process boundary: by the
 * id of a message the session was fed (the row it answered). A session is fed
 * nothing until an input is claimed for it: the chat history a fresh master child is
 * owed rides on that first input as background, not as a message of its own.
 */
export interface SeenSession {
  session: string;
  pid: number | null;
  fed: { id: string; text: string }[];
}

export interface AdapterServer {
  url: string;
  /** Every session the wire opened, with its child's pid and what it was fed. */
  seen(): SeenSession[];
  /** The child's pid of the LATEST session fed a message with this id. */
  childFor(messageId: string): number | null;
  /** Every child pid, oldest first, of the sessions fed a message with this id.
   *  A message is fed once, so this names one session per id; a check tells the child
   *  that died from the one that replaced it by two ids. */
  childPids(messageId: string): number[];
  stop(): Promise<void>;
}

interface WireEvent {
  kind: "receipt" | "progress" | "end";
  /**
   * WHOSE event this is. A server that broadcasts every event with no session
   * on it leaves a client
   * serving two agents no way to route one, and it hands all three kinds to
   * every handler it holds. Moving the handler arrays into the sessions alone
   * would not have fixed that: without this field there is nothing to route BY.
   */
  session: string;
  messageId?: string;
  progress?: AdapterProgress;
  /** The two fields ride along, because the whole object is serialised. */
  end?: ScriptedTurnEnd;
}

export async function serveAdapter(
  scripted: ScriptedAdapter,
): Promise<AdapterServer> {
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const encoder = new TextEncoder();
  const sessions = new Map<string, AdapterSession>();
  const seen = new Map<string, SeenSession>();
  let token = 0;

  const push = (event: WireEvent) => {
    const line = encoder.encode(JSON.stringify(event) + "\n");
    for (const controller of streams) {
      try {
        controller.enqueue(line);
      } catch {
        // a reader that went away takes its stream with it
      }
    }
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            streams.add(controller);
            controller.enqueue(new TextEncoder().encode("\n"));
          },
        });
        return new Response(stream, {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      if (url.pathname === "/start") {
        const asked = (await request.json()) as {
          preset: Preset;
          sessionId: string | null;
          cwd?: string;
        };
        const opened = await scripted.adapter.start(asked);
        const id = `s${++token}`;
        sessions.set(id, opened);
        seen.set(id, { session: id, pid: null, fed: [] });
        opened.onReceipt((messageId) => push({ kind: "receipt", session: id, messageId }));
        opened.onProgress((progress) => push({ kind: "progress", session: id, progress }));
        // The handler is typed with the narrower `TurnEnd`, and what this
        // fixture really fires carries the two fields as well. The whole
        // object is serialised, so they cross the wire on their own.
        opened.onTurnEnd((end) =>
          push({ kind: "end", session: id, end: end as ScriptedTurnEnd }),
        );
        return Response.json({
          session: id,
          sessionId: opened.sessionId,
          lacks: opened.lacks,
        });
      }
      if (url.pathname === "/feed") {
        const asked = (await request.json()) as {
          session: string;
          id: string;
          text: string;
        };
        const opened = sessions.get(asked.session);
        if (!opened) return new Response("no such session", { status: 404 });
        seen.get(asked.session)?.fed.push({ id: asked.id, text: asked.text });
        await opened.feed({ id: asked.id, text: asked.text });
        return Response.json({ ok: true });
      }
      if (url.pathname === "/child") {
        // The client spawned the real child, because the child has to be a
        // child of the RUNNER's process and not of the test's.
        const asked = (await request.json()) as { session: string; pid: number };
        const row = seen.get(asked.session);
        if (row) row.pid = Number(asked.pid);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/close") {
        const asked = (await request.json()) as { session: string };
        const opened = sessions.get(asked.session);
        if (opened) await opened.close();
        sessions.delete(asked.session);
        return Response.json({ ok: true });
      }
      return new Response("not an adapter verb", { status: 404 });
    },
  });

  return {
    url: `http://127.0.0.1:${server.port}`,
    seen: () => [...seen.values()].map((s) => ({ ...s, fed: [...s.fed] })),
    childFor(messageId) {
      const all = [...seen.values()].filter((row) =>
        row.fed.some((f) => f.id === messageId),
      );
      return all.length ? all[all.length - 1].pid : null;
    },
    childPids(messageId) {
      return [...seen.values()]
        .filter((row) => row.fed.some((f) => f.id === messageId))
        .map((row) => row.pid)
        .filter((pid): pid is number => typeof pid === "number");
    },
    async stop() {
      for (const controller of streams) {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
      streams.clear();
      await server.stop(true);
    },
  };
}

/**
 * The `Adapter` a runner in another process is handed.
 *
 * With `child: true` it spawns the REAL child here, inside the runner's own
 * process, so `ps -o ppid=` on that child names the runner (check 12) and the
 * runner's memory watch has a pid it can actually read and kill (check 11). A
 * child spawned on the server side would be a child of the TEST process, and
 * both of those checks would be about the wrong parent.
 */
/** One session's own handlers, which is the unit the fix below turns on. */
interface WiredSession {
  receipt: ((messageId: string) => void)[];
  progress: ((event: AdapterProgress) => void)[];
  end: ((end: TurnEnd) => void)[];
}

export function adapterClient(
  url: string,
  name = "scripted-over-http",
  options: { child?: boolean } = {},
): Adapter {
  /**
   * HANDLERS BELONG TO A SESSION, not to this client.
   *
   * One subprocess builds ONE client for all of its agents, and the three
   * HANDLER ARRAYS MUST NOT LIVE HERE, on the client. Every session registered
   * into them and `close()` emptied all three, so a runner respawning agent
   * A's child (a preset change, or a child the memory watch killed) deafened
   * agent B in the middle of B's turn: B's `onTurnEnd` was gone, the turn never
   * finished, and what the ledger showed was a started row with no end. It also
   * cleared `pumping` without cancelling its reader, so the next `start`
   * created a second pump while the first was still blocked on the same stream.
   *
   * Three things had to change together, and the first is why the smallest fix
   * is not just moving the arrays: the server had to put the session on every
   * event, or there is nothing to route BY.
   */
  const bySession = new Map<string, WiredSession>();
  let pumping: Promise<void> | null = null;
  // Only `cancel` is ever called on it from outside the pump, so that is all
  // this holds: the reader's own type differs between runtimes and naming it
  // here would be pinning a runtime detail rather than the behaviour.
  let reader: { cancel(): Promise<void> } | null = null;
  let stopped = false;

  let pumpError: Error | null = null;
  const pump = async () => {
    const res = await fetch(`${url}/events`);
    const own = res.body!.getReader();
    reader = own;
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await own.read();
      if (done || stopped) return;
      buffer += decoder.decode(value, { stream: true });
      let cut = buffer.indexOf("\n");
      while (cut >= 0) {
        const line = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 1);
        if (line.trim() !== "") {
          const event = JSON.parse(line) as WireEvent;
          // An event for a session this client has closed belongs to nobody,
          // which is different from belonging to everybody.
          const its = bySession.get(String(event.session));
          if (its) {
            if (event.kind === "receipt") {
              for (const h of its.receipt) h(String(event.messageId));
            } else if (event.kind === "progress") {
              for (const h of its.progress) h(event.progress!);
            } else if (event.kind === "end") {
              for (const h of its.end) h(event.end!);
            }
          }
        }
        cut = buffer.indexOf("\n");
      }
    }
  };

  return {
    name,
    async start(where) {
      stopped = false;
      if (!pumping) {
        // A stream that ends because the test stopped the server is not a
        // failure of the run. One that ends otherwise is kept so a check can
        // say so rather than hanging.
        pumping = pump().catch((error: Error) => {
          if (!stopped) pumpError = error;
        });
      }
      const res = await fetch(`${url}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          preset: where.preset,
          sessionId: where.sessionId,
          cwd: where.cwd,
        }),
      });
      const opened = (await res.json()) as {
        session: string;
        sessionId: string | null;
        lacks: string[];
      };
      const wired: WiredSession = { receipt: [], progress: [], end: [] };
      bySession.set(opened.session, wired);
      const held = options.child ? spawnHolder() : null;
      if (held) {
        await fetch(`${url}/child`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session: opened.session, pid: held.pid }),
        }).catch(() => {});
      }
      const session: ChildSession = {
        get sessionId() {
          return opened.sessionId;
        },
        get pid() {
          return held ? held.pid : null;
        },
        get lacks() {
          return opened.lacks;
        },
        async feed(message) {
          await fetch(`${url}/feed`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              session: opened.session,
              id: message.id,
              text: message.text,
            }),
          });
        },
        onReceipt(handler) {
          wired.receipt.push(handler);
        },
        onProgress(handler) {
          wired.progress.push(handler);
        },
        onTurnEnd(handler) {
          wired.end.push(handler);
        },
        async close() {
          // THIS session's handlers, and no other's. A closed session cannot
          // see a turn reported twice, and an open one beside it keeps hearing.
          bySession.delete(opened.session);
          if (held) held.kill();
          // The stream is shared, so it goes only when the last session does,
          // and it is CANCELLED and awaited rather than dropped: a pump left
          // blocked on a reader nobody holds is a second pump the next `start`
          // would create beside it.
          if (bySession.size === 0) {
            stopped = true;
            const reading = reader;
            reader = null;
            await reading?.cancel().catch(() => {});
            const running = pumping;
            pumping = null;
            await running?.catch(() => {});
          }
          await fetch(`${url}/close`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ session: opened.session }),
          }).catch(() => {});
          if (pumpError) throw pumpError;
        },
      };
      return session;
    },
  };
}
