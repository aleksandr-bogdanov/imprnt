import { alive, groupAlive, groupOf, groupPresence, observeTree, presence } from "../os/tree.ts";
import {
  FeedNotWritten,
  type Adapter,
  type AdapterCapabilities,
  type AdapterProgress,
  type AdapterSession,
  type AdapterUsage,
  type ExitEvidence,
  type TurnEnd,
  type TurnRefusal,
  type WindowReading,
} from "./types.ts";

/**
 * The installed builds whose resume of an interrupted session has been
 * validated to replay no unfinished tool call and to continue nothing on its
 * own. A build is here only for what was actually run against the real CLI, and
 * a build that is not here has `safeResume` false: a fresh turn after an
 * interruption is not started on it.
 *
 * 2.1.285, measured twice (Sonnet 5.5, Hub's exact stream-json input, replay and
 * partial flags): the CLI was killed with SIGKILL after one MCP tool call had made
 * one fsynced effect and its `tool_use` was durable with NO `tool_result`. The same
 * session id resumed with a NEW question kept the marker it had been given, made no
 * tool call of its own and the effect count stayed 1 → 1: the CLI wrote an
 * interrupted-tool error for the unfinished call and did not run it again. That is
 * the whole of the observation. It is NOT evidence about a shell command, a tool
 * that detached, another tool profile, another machine, a person's box, or the Pi;
 * the model chose to stay quiet when asked not to continue, and nothing here
 * prevents a resumed model from choosing to act.
 */
export const VALIDATED_SAFE_RESUME: readonly string[] = ["2.1.285"];

/**
 * The installed builds on which an explicit `--tools` list was OBSERVED to be the
 * whole of the effective tool set, with the native delegation, team, workflow and
 * scheduling tools absent, and what that list was (`VALIDATED_BUILTIN_TOOLS`).
 * 2.1.284: the restricted Read, Glob and Grep list. 2.1.285: the nine ordinary
 * tools with one MCP server beside them (see there). Neither is evidence about any
 * other list, and `delegationDisabled` says only what this says. A build that is
 * not here is refused for an ordinary launch by name (`native-tool-control-unvalidated`).
 */
export const VALIDATED_TOOL_CONTROL: readonly string[] = ["2.1.284", "2.1.285"];

/**
 * The BUILTIN tools each validated build was observed to expose exactly, when
 * they were asked for by an explicit list. An agent's configured builtins must lie
 * inside its build's set, or the launch is refused by name
 * (`tool-profile-unvalidated`): a builtin nobody observed on that build is not
 * launched under a claim that the effective tool set is known. MCP tools are not
 * builtins: a person's configured servers are passed exactly as configured. A tool
 * named with a specifier (`Bash(git:*)`) counts by its name.
 *
 * 2.1.284 (root's restricted probe): Read, Glob, Grep, and nothing wider.
 * 2.1.285 (the measured probes, `--tools` the nine, one stdio MCP server): all nine
 * exposed, the MCP server connected, and none of the denied names present; nothing
 * unrequested appeared.
 */
export const VALIDATED_BUILTIN_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "2.1.284": ["Read", "Glob", "Grep"],
  "2.1.285": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch"],
};

/**
 * The ordinary working tools an agent that names none is launched with, per
 * build, as an explicit list and never as the CLI's own default (which still
 * carries Workflow, background and scheduling tools). Only a profile somebody read
 * back from the real CLI is here: 2.1.285's nine. A build with none has an agent
 * with no tool list of its own refused by name (`ordinary-tool-profile-unvalidated`);
 * agents that DO name their tools are launched with exactly those, if the build
 * validated them (`VALIDATED_BUILTIN_TOOLS`).
 */
export const VALIDATED_ORDINARY_PROFILES: Readonly<Record<string, readonly string[]>> = {
  "2.1.285": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch"],
};

/**
 * The first loop, driven headless over its stream-json protocol.
 *
 * One child process per session, started by the runner, fed one JSON line per
 * message on stdin and read one JSON line per event on stdout. The five verbs
 * map onto the protocol as measured against the real CLI:
 *
 *   feed        a `user` line on stdin
 *   receipt     the same message replayed back with `isReplay`
 *   progress    `stream_event` text deltas and tool blocks
 *   end of turn the `result` event, with its usage
 *   resume      `--resume <session id>`, which needs session persistence on
 *
 * A `system` event of subtype `init` opens every turn and is NOT progress: a
 * runner that stamped `started` from it would stamp before the model had
 * produced anything.
 */
const FLAGS = [
  "--print",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--replay-user-messages",
  "--include-partial-messages",
];

interface Pending {
  id: string;
  text: string;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/**
 * The highest utilization this loop reported, with THAT window's own
 * reset, out of the `unifiedWindows` object measured on 2026-09-16:
 * `{"five_hour":{"utilization":0.27,"resetsAt":1789523400},
 *   "seven_day":{"utilization":0.55,"resetsAt":1789808400}}`.
 *
 * The highest and not `five_hour`, because a weekly cap at 100% would otherwise
 * never pause anything and the household would be held by the provider with
 * nothing said. `resetsAt` is unix SECONDS on the wire and ISO 8601 here.
 */
function readWindow(info: Record<string, unknown> | undefined): WindowReading | null {
  const windows = info?.unifiedWindows as Record<string, unknown> | undefined;
  if (!windows || typeof windows !== "object") return null;
  let highest: WindowReading | null = null;
  for (const one of Object.values(windows)) {
    const window = one as { utilization?: unknown; resetsAt?: unknown };
    if (typeof window?.utilization !== "number") continue;
    if (highest !== null && window.utilization <= highest.utilization) continue;
    highest = {
      utilization: window.utilization,
      resets_at:
        typeof window.resetsAt === "number"
          ? new Date(window.resetsAt * 1000).toISOString()
          : null,
    };
  }
  return highest;
}

/**
 * Whether what the loop said names the plan's allowance rather than a
 * credential. Nothing parses a NUMBER out of it: the sentence is copied whole
 * into `said` and this only chooses which cause it is.
 *
 * A used-up plan window's exact wire shape was never observed, because a live
 * window cannot be exhausted for a probe, so this is the honest half of it:
 * the measured path is `utilization`, and this is what a loop that
 * says it in prose gets.
 */
function namesARateLimit(said: string): boolean {
  return /rate[ _-]?limit|usage limit|quota|too many requests/i.test(said);
}

/**
 * What the loop said about the end of a turn: its own text AND its `error`
 * field, because the rule is any `result` with `is_error: true` whose
 * text OR `error` names a rate limit. A `result` carrying the sentence in
 * `error` while `terminal_reason` is `api_error` would otherwise be read as a
 * dead login, and the login notice is the one that tells a human to go and log
 * in again.
 */
function endingWords(event: Record<string, unknown>): string {
  return `${String(event.result ?? "")} ${String(event.error ?? "")}`.trim();
}

async function open(options: Parameters<Adapter["start"]>[0]): Promise<AdapterSession> {
  const args = options.argv ? [...options.argv] : ["claude", ...FLAGS, "--model", options.preset.model, "--effort", options.preset.effort];
  if (args.includes("--dangerously-skip-permissions") && !options.wrap) {
    throw new Error("box-required");
  }
  // The session is the conversation's own, chosen by the hub. Launched under
  // that id the first time and resumed under it after, and never `--continue`,
  // which resumes whatever was newest in the directory.
  if (options.session) args.push(options.session.resume ? "--resume" : "--session-id", options.session.id);
  else if (options.sessionId) args.push("--resume", options.sessionId);

  // Whatever the runner handed over, applied to this loop's own
  // argv. This file names no tool and imports nothing from `src/box/`: what
  // comes back is simply what gets spawned.
  const argv = typeof options.wrap === "function" ? options.wrap(args) : args;

  const child = Bun.spawn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: options.cwd,
    env: options.env,
    // ASKED FOR, NEVER ASSUMED: a child that leads a process group of its own can
    // be stopped and looked for as a group, tools reparented to init included.
    // Whether the runtime honoured it is read back from the process table below,
    // and a child that turned out to share the runner's group is treated as one.
    ...({ detached: true } as object),
  });
  const ownGroup: number | null = (() => {
    if (!child.pid || child.pid === process.pid) return null;
    return groupOf(child.pid) === child.pid ? child.pid : null;
  })();

  const receipts: ((messageId: string) => void)[] = [];
  const progress: ((event: AdapterProgress) => void)[] = [];
  const ends: ((end: TurnEnd) => void)[] = [];

  let sessionId = options.session?.id ?? options.sessionId;
  let pending: Pending | null = null;
  // The plan windows arrive once per process rather than once per turn, so the
  // newest the loop has reported is what every turn of this session records.
  let planUsage: Record<string, unknown> | null = null;
  // The NEWEST reading, up or down. Keeping the highest one ever seen
  // would hold a household on a number that has already reset: the window came
  // back and every runner still reads the old percent.
  let window: WindowReading | null = null;
  // A refusal the stream has already named, waiting for the event that
  // ends the turn. The measured no-login stream says it on the `assistant` line
  // and then again on the `result`, and a stream with only the second is the
  // other route to the same cause.
  let seen: TurnRefusal | null = null;
  let closed = false;
  // What the engine itself said its session is, as early as it says it. Kept
  // apart from `sessionId`, which starts as the id the hub asked for: comparing
  // a request with itself would verify nothing.
  let reported: string | null = null;
  // Every process ever seen under the loop. A leader that has exited says nothing
  // about its tools, so what is judged afterwards is everything that was ever
  // observed under it, and never only the tree as it stands now: a tool that
  // detached after it was seen is still a process this record names.
  const seenTree = new Set<number>();
  // Whether a read of the process table failed while the tree was observed. Such a
  // read is not an empty tree, and it is said.
  let incomplete = false;
  const gone = () => child.exitCode !== null || child.signalCode !== null;
  const snapshot = (): number[] | null => {
    if (!child.pid) return null;
    if (gone()) return [];
    const under = observeTree(child.pid);
    if (!under.complete) incomplete = true;
    const tree = [child.pid, ...under.pids];
    for (const one of tree) seenTree.add(one);
    return tree;
  };
  const evidence = (via: string): ExitEvidence => {
    const pids = [...seenTree];
    const looked = pids.map(one => [one, presence(one)] as const);
    const survivors = looked.filter(([, said]) => said === "present").map(([one]) => one);
    // A lookup that failed is neither present nor gone.
    const unknown = looked.filter(([, said]) => said === "unknown").map(([one]) => one);
    const leader = child.pid === undefined ? "unknown" : gone() ? "exited" : "alive";
    // THE GROUP IS THE ONLY WITNESS FOR WHAT WAS NEVER SEEN. Once the leader is gone,
    // anything still in its group is a survivor whether or not it was ever seen, and a
    // group the system says is empty, with every process recorded under it gone, is a
    // bounded claim about the processes this child managed. It says nothing about a
    // process that left the group (its own session, its own group) before anyone
    // recorded it, and it says nothing about an effect outside the process table. A
    // child that shares the runner's group, or a group that could not be looked up, has
    // no such witness, and what was observed of the tree alone is never "none".
    const inGroup = ownGroup === null ? null : groupPresence(ownGroup);
    const others = survivors.some(one => one !== child.pid) || (gone() && inGroup === "present");
    const verified = inGroup === "absent" && unknown.length === 0;
    const descendants = others ? "survivors" : verified ? "none" : "unverified";
    return { confirmed: leader === "exited" && descendants === "none" && !survivors.includes(child.pid!), leader, descendants, pids, survivors,
      unknown, partial: incomplete, basis: inGroup === "absent" ? "process-group" : "observed-tree", group: ownGroup, via };
  };
  let terminal!: (cause: unknown) => void;
  const exited = new Promise<unknown>(resolve => { terminal = resolve; });
  void child.exited.then(code => terminal({ cause: "child-exited", code }));
  const resolved = new Set<string>();
  let primary: string | null = null;

  /**
   * Let the child go, once. The adapter itself calls this on a refused
   * credential and the runner calls it when the session ends, so it has to be
   * safe both ways round: a second call waits on the same exit rather than
   * ending a stream that is already gone.
   */
  const shut = async (): Promise<void> => {
    if (closed) {
      await child.exited;
      return;
    }
    closed = true;
    try {
      child.stdin.end();
    } catch {
      // The child took the pipe with it, which is the outcome this wanted.
    }
    child.kill();
    await child.exited;
  };

  const settle = (end: TurnEnd) => {
    seen = null;
    for (const listener of ends) listener(end);
    resolved.clear();
    primary = null;
  };

  /**
   * The end of a turn the loop refused, with no `result` behind it.
   *
   * `text` is empty, so a runner that ignored `refused` altogether would
   * write an empty chunk rather than the loop's own apology into a person's
   * chat. The usage is the shape every other turn end carries, with nothing in
   * it, because zero tokens is what a refused turn really used.
   */
  const refuse = (refusal: TurnRefusal, raw: Record<string, unknown>) => {
    settle({
      text: "",
      session_id: sessionId,
      refused: refusal,
      usage: {
        input_tokens: null,
        cached_input_tokens: null,
        output_tokens: null,
        plan_usage: planUsage,
        window,
        resolved_model_ids: [...resolved].sort(),
        primary_model_id: primary,
        raw,
      },
    });
  };

  const handle = (event: Record<string, unknown>) => {
    const inner = event.event as Record<string, unknown> | undefined;
    const message = (event.type === "assistant" ? event.message
      : event.type === "stream_event" && inner?.type === "message_start" ? inner.message : null) as { model?: unknown } | null;
    if (typeof message?.model === "string" && message.model !== "") {
      resolved.add(message.model);
      if (!event.parent_tool_use_id) primary = message.model;
    }
    if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
      reported = event.session_id;
      return;
    }
    if (event.type === "rate_limit_event") {
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      planUsage = (info?.unifiedWindows as Record<string, unknown>) ?? info ?? null;
      window = readWindow(info);
      return;
    }
    // A synthetic assistant line carrying the refusal as text, with a
    // top-level `error` field naming the cause. Measured with an empty
    // CLAUDE_CONFIG_DIR: `error: "authentication_failed"`,
    // `is_api_error_message: true`, and the text "Not logged in · Please run
    // /login". The `result` right behind it is what ends the turn.
    if (
      event.type === "assistant" &&
      event.error === "authentication_failed" &&
      event.is_api_error_message === true
    ) {
      const message = event.message as { content?: unknown } | undefined;
      const blocks = Array.isArray(message?.content) ? message.content : [];
      const said = blocks
        .map((block) => (block as { text?: unknown }).text)
        .filter((text): text is string => typeof text === "string")
        .join(" ");
      seen = { cause: "login", said: said || String(event.error) };
      return;
    }
    // The CLI does not give up on a refused credential: measured with an
    // invalid key it emits one of these per attempt with delays 623, 1153,
    // 2188, 4969, 8302, 18484 and 35294 ms and rising, ten attempts, and writes
    // no `result` meanwhile. No retry fixes a dead credential and the RUNNER
    // owns the retry clock (L10 rule 3), so the adapter ends the turn on the
    // FIRST 401 and closes the child rather than holding a person's message
    // open for minutes.
    //
    // EVERY OTHER STATUS IS PASSED OVER, 429 as much as 503. "No retry fixes
    // it" is an argument about a dead
    // credential. A 429 is the provider asking the loop to wait and the CLI's
    // own backoff is what waits, so ending the turn on the first one would put
    // a household-wide hold on one transient throttle: the child killed, the
    // outage opened with cause `window`, and every person on that credential
    // told the plan's allowance was gone. What says a window is really used up
    // is the `utilization` the loop reports and a `result` that ends
    // the turn naming a rate limit. A retry line is neither.
    if (event.type === "system" && event.subtype === "api_retry") {
      if (event.error_status !== 401) return;
      refuse(
        { cause: "login", said: String(event.error ?? "authentication_failed") },
        { ...event, evidence: { kind: "authenticated-response", status: 401, credential: options.credentialId } },
      );
      // Fire and forget, so the reader this is running inside is not held on a
      // process exit, and CAUGHT, because a fire-and-forget promise that
      // rejects is an unhandled rejection with nobody to report it to. Killing
      // a child that has already gone is the ordinary case here.
      void shut().catch(() => {});
      return;
    }
    // A tool the loop ran has reported back. Only the FACT is passed on: the
    // block's content is a tool's output and never leaves this file.
    if (event.type === "user" && event.isReplay !== true) {
      const returned = (event.message as { content?: unknown } | undefined)?.content;
      if (Array.isArray(returned) && returned.some((block) => (block as { type?: unknown } | null)?.type === "tool_result")) {
        for (const listener of progress) listener({ kind: "action_result", text: "" });
      }
    }
    if (event.type === "user" && event.isReplay === true && pending) {
      const replayed = (event.message as { content?: unknown } | undefined)?.content;
      if (typeof replayed === "string" && replayed !== pending.text) return;
      const acknowledged = pending.id;
      pending = null;
      for (const listener of receipts) listener(acknowledged);
      return;
    }
    if (event.type === "stream_event") {
      const inner = event.event as Record<string, unknown> | undefined;
      const delta = inner?.delta as { type?: string; text?: string } | undefined;
      if (inner?.type === "content_block_delta" && delta?.type === "text_delta") {
        for (const listener of progress) listener({ kind: "text", text: delta.text ?? "" });
      }
      const block = inner?.content_block as { type?: string; name?: string } | undefined;
      if (inner?.type === "content_block_start" && block?.type === "tool_use") {
        for (const listener of progress) listener({ kind: "action", text: block.name ?? "" });
      }
      return;
    }
    if (event.type === "result") {
      const usageReported = (event.usage ?? {}) as Record<string, unknown>;
      if (typeof event.session_id === "string") reported = event.session_id;
      sessionId = (event.session_id as string) ?? sessionId;
      const modelUsage = event.modelUsage;
      if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
        for (const model of Object.keys(modelUsage)) if (model) resolved.add(model);
      }
      const usage: AdapterUsage = {
        resolved_model_ids: [...resolved].sort(),
        primary_model_id: primary,
        input_tokens: numberOrNull(usageReported.input_tokens),
        cached_input_tokens: numberOrNull(usageReported.cache_read_input_tokens),
        output_tokens: numberOrNull(usageReported.output_tokens),
        plan_usage: planUsage,
        window,
        raw: {
          ...usageReported,
          evidence: seen?.cause === "login" ? { kind: "authenticated-response", status: 401, credential: options.credentialId }
            : event.is_error !== true ? { kind: "authenticated-response", status: 200, credential: options.credentialId }
            : window ? { kind: "plan-window", utilization: window.utilization, credential: options.credentialId } : null,
          ...(modelUsage ? { modelUsage } : {}),
          num_turns: event.num_turns,
          result: event.result,
          total_cost_usd: event.total_cost_usd,
        },
      };
      const said = String(event.result ?? "");
      // MEASURED, and it is the trap this branch exists for: the no-login
      // `result` carries `subtype: "success"` AND `is_error: true`. An adapter
      // reading `subtype` alone settles it as a reply, the runner writes "Not
      // logged in" into the outbox and the door posts it to the person, which
      // is the per-row apology L10 forbids by name.
      if (event.is_error === true) {
        const refusal: TurnRefusal = seen
          ? { cause: seen.cause, said: said || seen.said }
          : namesARateLimit(endingWords(event))
            ? { cause: "window", said }
            : event.terminal_reason === "api_error"
              ? { cause: "login", said }
              : { cause: "other", said };
        settle({ text: "", session_id: sessionId, usage, refused: refusal });
        return;
      }
      settle({ text: said, session_id: sessionId, usage, refused: null });
    }
  };

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || closed) return;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf("\n");
        while (cut >= 0) {
          const line = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 1);
          cut = buffer.indexOf("\n");
          if (line.trim() !== "") handle(JSON.parse(line) as Record<string, unknown>);
        }
      }
    } catch {
      terminal({ cause: "stream-failed" });
    } finally {
      terminal({ cause: "stream-ended" });
    }
  })();

  return {
    exited,
    get sessionId() {
      return sessionId;
    },
    get reportedSessionId() {
      return reported;
    },
    // The child the runner's memory watch reads and, over its limit,
    // kills. It is this process's own child, with no unit of its own (D7).
    get pid() {
      return child.pid ?? null;
    },
    lacks: [],
    processes: () => snapshot(),
    partial: () => incomplete,
    group: () => ownGroup,
    async exitEvidence() {
      // A leader still running is not waited for: it is not gone. One that is
      // exiting is given a moment, because the reader learns of an exit a beat
      // before the process table does.
      if (!gone()) await Promise.race([child.exited, Bun.sleep(200)]);
      return evidence(ownGroup === null
        ? "the process tree observed under the loop (no process group of its own, so what was never observed is not covered)"
        : "the loop's process group and every process recorded under it, looked up again (a process that left the group before it was recorded is not covered)");
    },
    async interrupt({ graceMs }) {
      // The tree is read while the leader is alive, because once it is gone its
      // tools are reparented and nothing names them any more.
      snapshot();
      closed = true;
      try { child.stdin.end(); } catch { /* the pipe went with the child */ }
      const tools = [...seenTree].filter(one => one !== child.pid).reverse();
      const signal = (pids: number[], name: NodeJS.Signals) => {
        for (const one of pids) { try { process.kill(one, name); } catch { /* it left first */ } }
      };
      // The loop's own group, and only that one: it is signalled by the negative of
      // a group id this adapter checked it leads, never by a number it was handed.
      const signalGroup = (name: NodeJS.Signals) => {
        if (ownGroup === null) return;
        try { process.kill(-ownGroup, name); } catch { /* the group is empty */ }
      };
      const settled = async (limitMs: number) => {
        const empty = () => gone() && [...seenTree].every(one => !alive(one)) && (ownGroup === null || !groupAlive(ownGroup));
        const until = Date.now() + limitMs;
        while (Date.now() < until) {
          if (empty()) return true;
          await Bun.sleep(25);
        }
        return empty();
      };
      // Tools first, then the loop: the loop is what would report the tools
      // exiting, and a loop ended first leaves them running unobserved. The group
      // follows, for what was reparented out of sight.
      signal(tools, "SIGTERM");
      if (child.pid) signal([child.pid], "SIGTERM");
      signalGroup("SIGTERM");
      if (!await settled(graceMs)) {
        signal(tools, "SIGKILL");
        if (child.pid) signal([child.pid], "SIGKILL");
        signalGroup("SIGKILL");
        await settled(2000);
      }
      return evidence(ownGroup === null
        ? "terminate, then kill after the grace, judged on the observed process tree"
        : "terminate, then kill after the grace, judged on the process group and the observed process tree");
    },
    async feed(message) {
      // THE ONLY REJECTION THAT SAYS NOTHING WAS WRITTEN: nothing has been touched yet, and the
      // session is closed or its process is already gone. Once the write below has begun, any
      // failure of it or of the flush is uncertain and is thrown as it is.
      if (closed || gone()) throw new FeedNotWritten(closed ? "session-closed" : "child-exited");
      pending = { id: message.id, text: message.text };
      child.stdin.write(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: message.text },
        }) + "\n",
      );
      await child.stdin.flush();
    },
    onReceipt(handler) {
      receipts.push(handler);
    },
    onProgress(handler) {
      progress.push(handler);
    },
    onTurnEnd(handler) {
      ends.push(handler);
    },
    close: shut,
  };
}

export const claudeCode: Adapter = {
  name: "claude-code",
  // Read off what the installed CLI says about itself and off the list of builds
  // somebody validated, and never assumed from documentation: a flag the help
  // does not name is a capability the launch does not have.
  async capabilities(context) {
    const launch = await import("./launch.ts");
    const found = await launch.loopCapabilitiesFor(launch.credentialSource(context.registry, context.preset), context.probe);
    const stableSession = found.native.includes("--session-id") && found.native.includes("--resume");
    return {
      stableSession,
      // A flag in the help text is not an effective tool set. This is true only
      // for a build whose effective tools were read back by running it.
      delegationDisabled: found.native.includes("--disallowedTools") && VALIDATED_TOOL_CONTROL.includes(found.version),
      safeResume: stableSession && VALIDATED_SAFE_RESUME.includes(found.version),
      version: found.version,
    } satisfies AdapterCapabilities;
  },
  async prepareLaunch(input, probe) {
    const launch = await import("./launch.ts");
    // Probed once per binary and login, and the login is checked every time.
    const found = await launch.loopCapabilitiesFor(input.credential ?? launch.credentialSource(input.registry, input.agent.preset), probe);
    // No native delegation is not a setting an old CLI can be asked for: a build
    // that cannot deny a tool is a build this launch will not start.
    if (!found.native.includes("--disallowedTools")) throw new Error("native-delegation-unsupported");
    // A build whose effective tool set nobody read back is not one an ordinary
    // agent is launched on: it is refused by name and its version, and nothing is
    // substituted. Triage and harvest launch a fixed restricted list of their own.
    if (input.purpose === "ordinary" && !(VALIDATED_TOOL_CONTROL.includes(found.version) && VALIDATED_BUILTIN_TOOLS[found.version])) {
      throw new Error(`native-tool-control-unvalidated: claude ${found.version}`);
    }
    // An agent that names no tools gets this build's validated ordinary profile
    // as an explicit list, and where there is none it is refused by name in
    // `makeLoopLaunch`: the CLI's own "default" is never handed over. Configured
    // builtins outside what the build was observed with are refused there too.
    const profile = VALIDATED_ORDINARY_PROFILES[found.version];
    const builtins = VALIDATED_BUILTIN_TOOLS[found.version];
    return await launch.makeLoopLaunch({ ...input, ...(profile ? { toolProfile: profile } : {}), ...(builtins ? { validatedBuiltins: builtins, buildVersion: found.version } : {}) });
  },
  start: open,
};
