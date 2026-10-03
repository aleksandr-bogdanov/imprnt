import type { Preset } from "../registry/presets.ts";
import type { Bundle, BundleLimits } from "../transfer/bundle.ts";
import type { StageReceipt } from "../transfer/workspace.ts";
import type { LoopLaunchInput, LoopProbeOptions } from "./launch.ts";

/**
 * The seam. A loop does exactly five things and the rest of the hub knows
 * nothing else about it: feed a message, report the receipt, stream text,
 * report the end of turn with usage, resume or start a session.
 *
 * No loop code lives in this file and nothing in it names a loop.
 */
export interface AdapterProgress {
  /**
   * `text` and `action` are the two the hub has always had. `action_result` is
   * OPTIONAL for a loop to send: a tool the loop started has reported back. It
   * carries no text, and a loop that cannot tell it apart sends nothing, so the
   * door then knows only the last tool start and says exactly that.
   */
  kind: "text" | "action" | "action_result";
  text: string;
}

/**
 * Why a loop would not answer, typed, so the runner branches on no
 * loop's name and no loop's prose.
 *
 * A `login` is a credential no retry fixes. A `window` is the plan's own
 * allowance, which comes back on its own clock. Anything else is `other`.
 */
export interface TurnRefusal {
  cause: "login" | "window" | "other";
  /** What the loop itself said, copied. Nothing parses a number out of it. */
  said: string;
}

/**
 * The plan window a loop reported, normalised: the HIGHEST utilization
 * across every window it named, with that window's own reset.
 */
export interface WindowReading {
  /** 0.0 to 1.0. */
  utilization: number;
  /** ISO 8601, or null when the loop reported no reset for it. */
  resets_at: string | null;
}

/** What the loop said it used. A count it did not report is null, never zero. */
export interface AdapterUsage {
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  plan_usage: Record<string, unknown> | null;
  /**
   * The normalised reading beside the raw `plan_usage`, never instead of it.
   *
   * OPTIONAL rather than required, because a shipped assertion depends on it:
   * `test/turn-record.test.ts`, `test/chatlog.test.ts` and
   * `test/helpers/scripted-adapter.ts` build `AdapterUsage` literals, and
   * `tsc --noEmit` is part of what green means, so a required field would
   * turn four shipped files red. The
   * Claude Code adapter always sets it, null included, and a check binds that.
   */
  window?: WindowReading | null;
  resolved_model_ids?: string[];
  primary_model_id?: string | null;
  raw: Record<string, unknown>;
}

export interface TurnEnd {
  /** Empty whenever `refused` is not null, so an ignored field still posts nothing. */
  text: string;
  session_id: string | null;
  usage: AdapterUsage;
  refused: TurnRefusal | null;
}

export interface AdapterSession {
  /** Legacy adapters may omit this; production process adapters always report it. */
  readonly exited?: Promise<unknown>;
  readonly sessionId: string | null;
  /**
   * The session id the ENGINE has reported, and null until it has. `sessionId`
   * starts as the id the hub asked for, so only this one can verify that the
   * engine is running the conversation it was told to.
   */
  readonly reportedSessionId?: string | null;
  /**
   * The process id of the child this loop is, when the hub has one to watch.
   *
   * A handle property like `close`, never a sixth verb: the memory watch needs
   * the pid of every child the runner spawned, and D11's five verbs are what the
   * loop DOES, not what the handle IS. Null means this loop has no local child
   * for this hub to watch (a hosted loop), and the memory watch skips it.
   */
  readonly pid: number | null;
  /**
   * The verbs this loop does not have. An adapter that lacks "stream" emits one
   * progress event carrying the whole text just before the end of turn, so the
   * runner behaves the same for every loop and branches on none of them.
   */
  readonly lacks: readonly string[];
  /**
   * Hand the loop one message. The runner records a feed intent before this call.
   *
   * A REJECTION IS NOT PROOF THAT NOTHING WAS DELIVERED. Only a `FeedNotWritten`
   * says so: the adapter checked, before it wrote a byte, that it could not. Any
   * other rejection (a write or a flush that failed, a pipe that broke) may have
   * come after some or all of the message reached the engine, and is uncertain
   * exactly as a crash or an exit after the call is. An adapter that cannot tell
   * must reject with anything but `FeedNotWritten`.
   */
  feed(message: { id: string; text: string }): Promise<void>;
  onReceipt(handler: (messageId: string) => void): void;
  onProgress(handler: (event: AdapterProgress) => void): void;
  onTurnEnd(handler: (end: TurnEnd) => void): void;
  /** Not a sixth verb: the handle's stop, the same as a door's or a runner's. */
  close(): Promise<void>;
  /**
   * The loop's process tree right now, leader first, or null when it has no
   * local processes for this hub to name. What a crash is later judged
   * against, so it is recorded while the turn runs.
   */
  processes?(): number[] | null;
  /**
   * Whether any read of the process table failed since this session began, so that
   * the processes reported may lack one that was there. Absent means nothing is
   * claimed about it either way.
   */
  partial?(): boolean;
  /**
   * The process group the loop leads, when it was started as the leader of a
   * group of its own and that was checked against the process table; null when it
   * shares the runner's group or nothing can be said. It is what lets a stop reach
   * a tool that was reparented, and it is never a promise about one that left it.
   */
  group?(): number | null;
  /**
   * Whether the loop's processes are gone, judged from what this session saw of
   * them. `confirmed` needs the leader to have exited AND every process last
   * seen under it to be gone: the parent leaving is not the tools leaving.
   */
  exitEvidence?(): Promise<ExitEvidence>;
  /**
   * Stop the loop on request: ask, wait up to `graceMs`, then end what is left,
   * and report what is provably gone. Only ever called for an explicit stop.
   */
  interrupt?(options: { graceMs: number }): Promise<ExitEvidence>;
}

/**
 * What is known about whether a loop's processes are gone. `unverified` is never
 * `none`, and `confirmed` is never true while the leader is not shown to have
 * exited: a leader that is alive, or of which nothing is known, is not an
 * attempt that ended.
 *
 * THE ONLY POSITIVE THERE IS, apart from a machine that booted again: the loop
 * led a process group of its own and the system says that group is empty, every
 * process recorded under it is gone, and the leader exited. A lookup that failed
 * is `unknown`, never absent. A process that was never recorded and left the
 * group (its own session, its own group) is not covered by that, and nothing here
 * says it is: without a verified group, the answer is `unverified`. Nothing says a
 * tool's effect on anything outside the process table (a file, an API, a
 * message) was undone, either.
 */
export interface ExitEvidence {
  confirmed: boolean;
  leader: "exited" | "alive" | "unknown";
  descendants: "none" | "survivors" | "unverified";
  /** Every process the session had seen under the loop. */
  pids: number[];
  /** Those of them still present. */
  survivors: number[];
  /** Those of them whose lookup failed: neither present nor gone. */
  unknown?: number[];
  /** True when a read of the process table failed while the tree was observed, so the record may lack a process. */
  partial?: boolean;
  /**
   * What the answer rests on. `boot`: the machine started again. `process-group`:
   * the loop was its own group, the group is empty, and the recorded tree is gone.
   * `observed-tree`: only what was seen of the tree is gone, which does not cover
   * a process nobody saw or one that left the loop's group. `none`: nothing.
   */
  basis?: "boot" | "process-group" | "observed-tree" | "none";
  /** The loop's own process group, when the child was started as the leader of one. */
  group?: number | null;
  /** How the answer was reached, in words a person can read in the diary. */
  via: string;
}

/**
 * What an engine can be relied on for, per launch. A capability the adapter
 * cannot show is false, never true: a missing answer is the same as no.
 */
export interface AdapterCapabilities {
  /** Launchable under an id the hub chooses, and resumable under it later. */
  stableSession: boolean;
  /**
   * A resumed session does not replay the tool calls an interrupted turn left
   * unfinished and does not continue the old assignment on its own. Only true
   * for an engine build somebody validated.
   */
  safeResume: boolean;
  /** The engine's own delegation tools are off in a hub launch. */
  delegationDisabled: boolean;
  version?: string;
}

/** What a prepared launch hands to `Adapter.start`, alongside the preset and the session. */
export interface PreparedLaunch {
  cwd?: string;
  argv?: string[];
  env?: Record<string, string | undefined>;
  credentialId?: string;
  /** Runner-private accessor for engines with an in-memory authentication RPC.
   * Never serialize this value into the child environment, argv, config or logs. */
  privateModelKey?: () => string;
  wrap?: (argv: string[]) => string[];
}

/** What an adapter is asked about, without the adapter naming the registry's types. */
export interface CapabilityContext {
  registry: unknown;
  agent: { id: string; preset: string };
  preset: string;
  probe?: LoopProbeOptions;
}

/*
 * Moving a loop's own session between two machines: what the engine keeps on
 * disk for a conversation, taken from one session directory and put into
 * another, with nothing about the bytes interpreted or rewritten.
 *
 * This is the engine's half of a move and only that. It starts no model, reads
 * no login, touches no store and has no delivery policy: when to export, when
 * to import, when a move counts as done and what happens to a message while a
 * refusal stands are the caller's. Every method is synchronous and none retries
 * or falls back to a fresh session; a refusal is a `NativeRefusal` (or the
 * transfer library's own `TransferError`, passed through unchanged) and leaves
 * the caller's input as it was.
 *
 * The caller serialises every call on one session directory, and supplies the
 * `version` of the build that will actually run there.
 */

/** One end of a move, as the engine sees it. */
export interface NativeSide {
  /** The engine build, exactly as `capabilities` reports it. */
  version: string;
  os: "darwin" | "linux";
  /** The realpath of the session directory: the engine's working directory. */
  cwd: string;
  /** The name of the engine's per-directory folder for `cwd`, observed at the source and applied at the destination. */
  project_dir: string;
}

/** One carried file. `path` is relative to the session directory. */
export interface NativeFile { path: string; sha256: string; size: number; mode: number }

/** What an export says it carried. Its canonical JSON is what `NativeExport.digest` is the sha256 of. */
export interface NativeManifest {
  version: 1;
  adapter: string;
  native_session: string;
  /** The name of the locator rule the source's table entry applied to check what it observed. */
  rule: string;
  from: NativeSide;
  /** Source-relative, in the source's own layout. Exactly one today: the session's transcript. */
  files: NativeFile[];
}

export interface NativeExport {
  manifest: NativeManifest;
  /** sha256 of the manifest's canonical JSON (`native_manifest_digest`). */
  digest: string;
  /** Class `native`, in the source's layout: the transcript bytes as they were read. */
  bundle: Bundle;
}

export interface NativeImport {
  native_manifest_digest: string;
  /** The destination's side: applied by the destination's rule, not observed from the engine. */
  to: NativeSide;
  /** The digest of the bundle as staged (its path is the destination's), not of the source's. */
  bundle_digest: string;
  transcript: NativeFile;
  receipt: StageReceipt;
  /** True when a complete stage of this same operation and bundle was already there (a retry), and nothing was written. */
  reused: boolean;
}

export type NativeCode =
  /** The engine build, on this host, is not one whose layout somebody measured. */
  | "native_build_unvalidated"
  /** Both builds are measured, but a move between this pair of host and build never was. */
  | "native_pair_unvalidated"
  | "native_session_invalid"
  | "native_transcript_missing"
  | "native_locator_ambiguous"
  /** What the source's engine wrote is not where its build's rule says it would. */
  | "native_locator_rule_mismatch"
  /** Something beside the transcript is in the session's engine directory, and nobody measured that a move without it resumes. Names it. */
  | "native_side_state_unsupported"
  /** The destination's working directory is outside the subset of paths the rule was measured on. */
  | "native_locator_unsupported_path"
  | "native_dest_session_collision"
  | "native_export_mismatch"
  /** After a resumed turn, the session directory is not what a resume of this transcript is measured to leave. */
  | "native_resume_unverified";

/** A named refusal of a native session move. `path` is the one path at fault, relative to the session directory when it is one. */
export class NativeRefusal extends Error {
  readonly code: NativeCode;
  readonly path?: string;

  constructor(code: NativeCode, path?: string) {
    super(code);
    this.name = "NativeRefusal";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}

export interface NativeSessionPort {
  /**
   * PURE: where this host's measured build would place a session at `sessionDir`, by the very rule `importSession` applies (one
   * shared helper), so a preflight and the import cannot drift. It resolves the deepest existing ancestor of `sessionDir` and writes,
   * creates and opens nothing. Refuses with `native_build_unvalidated`, `native_locator_unsupported_path` or `destination-invalid`.
   */
  destination(input: { sessionDir: string; version: string }): NativeSide;
  /**
   * PURE: the measured move between two builds, with the evidence the table holds for it. `from` and `to` are `os:version`. Refuses
   * with `native_build_unvalidated` (either end) or `native_pair_unvalidated` (two measured builds nobody moved between).
   */
  portability(input: { from: { os: string; version: string }; to: { os: string; version: string } }):
    { adapter: string; from: string; to: string; evidence: string };
  /** Read the one transcript of `nativeSession` under `sessionDir/config`, and nothing else in it. The caller has proved the source quiet. */
  exportSession(input: { sessionDir: string; nativeSession: string; version: string; limits: BundleLimits }): NativeExport;
  /**
   * Put an export's transcript into `sessionDir`, which must not exist (or hold only a complete stage of this same
   * operation and bundle, which is a crash retry and writes nothing). Serialised per conversation by the caller; nothing
   * here is atomic beyond what the transfer library's staging says of itself. The caller compares `digest` with its own
   * authoritative record of the export (the port only checks that the manifest matches the digest it came with), and
   * recovers a stage interrupted before its marker said complete (no receipt, so a collision here): an integration gate.
   */
  importSession(input: {
    manifest: unknown; digest: string; bundle: Bundle; sessionDir: string; version: string; operation: string; limits: BundleLimits;
  }): NativeImport;
  /**
   * Remove what `importSession` staged, by the library's receipt and only what it made. A file marker cannot tell a
   * session nothing has launched from one that has: the caller serialises this with every other use of the
   * directory and MUST have proved there was no activation and no live child before it asks. The library stops for a
   * recorded file that changed, but not for a directory or the root that gained entries: it may remove the unchanged
   * transcript, its empty directories and the marker, and only then fail with `stage-ambiguous`, leaving no record.
   */
  discardImport(receipt: StageReceipt): void;
  /**
   * After the first resumed turn of the imported session: whether the directory is what the measured resume left.
   * A conservative check for the one layout that was measured (the resumed transcript kept the imported bytes as its
   * prefix and was longer), not a proof about long or compacted sessions. A transcript that has not grown is refused.
   * Throws `native_resume_unverified` and nothing else changes.
   */
  checkResumed(input: { sessionDir: string; imported: NativeImport; nativeSession: string; reportedSessionId: string | null; limits: BundleLimits }): void;
}

export interface Adapter {
  readonly name: string;
  /** Permanent configured-engine prerequisite, checked before claiming work. */
  readonly activationBlock?: { cause: string; remedy: string };
  /**
   * What this engine can do, or absent when the adapter says nothing, which the
   * runner reads as "nothing that has to be proved". Asked before a claim, so
   * it must not start a model.
   */
  capabilities?(context: CapabilityContext): Promise<AdapterCapabilities>;
  /**
   * Moving this engine's own session between machines, or absent when the
   * engine has none this hub can move. Never used to start a model.
   */
  session?: NativeSessionPort;
  /**
   * Everything about a launch that is this engine's own: the configuration it
   * is given, the tools it is left with, the servers it is told about, the
   * session it is launched under. The shared context (the person's paths, the
   * box, the credential's owner) comes in through `input` and is not the
   * adapter's to change.
   */
  prepareLaunch?(input: LoopLaunchInput, probe?: LoopProbeOptions): Promise<PreparedLaunch>;
  start(options: {
    preset: Preset;
    sessionId: string | null;
    /**
     * A session the hub chose. `resume: false` launches the engine under this
     * id for the first time, `resume: true` resumes it. Never "the latest":
     * the id is the conversation's own.
     */
    session?: { id: string; resume: boolean };
    credentialId?: string;
    privateModelKey?: PreparedLaunch["privateModelKey"];
    cwd?: string;
    argv?: string[];
    env?: Record<string, string | undefined>;
    /**
     * The runner's boxing hook, applied to whatever argv this loop
     * would otherwise spawn. The adapter spawns `wrap(argv)` when it is given
     * one and `argv` when it is not.
     *
     * The adapter stays loop-specific and BOX-AGNOSTIC: it imports nothing from
     * `src/box/`, names no tool, and knows nothing about what the wrapping does.
     * That is what keeps "which box" a question the runner answers from the
     * registry and not one every new loop has to answer again.
     */
    wrap?: (argv: string[]) => string[];
  }): Promise<AdapterSession>;
}

/**
 * A feed that was refused BEFORE any byte of it was written, and the adapter knows
 * it: the session was already closed, or its process already gone. It is the only
 * rejection that lets an input the engine never had be tried again, and only when
 * nothing else was fed to that attempt first (the runner feeds one input per attempt, with
 * any background inside it, so that holds for a first feed; an earlier build's tail was a feed).
 */
export class FeedNotWritten extends Error {
  constructor(readonly why: string) {
    super(`feed-not-written: ${why}`);
    this.name = "FeedNotWritten";
  }
}

/** A preset naming a loop nobody registered. Loud, never a silent wait. */
export class AdapterMissing extends Error {
  readonly adapter: string;

  constructor(adapter: string, known: string[]) {
    super(
      `${adapter} is not a loop this hub has. The adapters are ${known.join(", ") || "none"}. ` +
        `A preset names one of them.`,
    );
    this.name = "AdapterMissing";
    this.adapter = adapter;
  }
}
