import type {
  Adapter,
  AdapterProgress,
  AdapterSession,
  AdapterUsage,
  TurnEnd,
  TurnRefusal,
  WindowReading,
} from "./types.ts";

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
  if (options.sessionId) args.push("--resume", options.sessionId);

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
  });

  const receipts: ((messageId: string) => void)[] = [];
  const progress: ((event: AdapterProgress) => void)[] = [];
  const ends: ((end: TurnEnd) => void)[] = [];

  let sessionId = options.sessionId;
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
      const reported = (event.usage ?? {}) as Record<string, unknown>;
      sessionId = (event.session_id as string) ?? sessionId;
      const modelUsage = event.modelUsage;
      if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
        for (const model of Object.keys(modelUsage)) if (model) resolved.add(model);
      }
      const usage: AdapterUsage = {
        resolved_model_ids: [...resolved].sort(),
        primary_model_id: primary,
        input_tokens: numberOrNull(reported.input_tokens),
        cached_input_tokens: numberOrNull(reported.cache_read_input_tokens),
        output_tokens: numberOrNull(reported.output_tokens),
        plan_usage: planUsage,
        window,
        raw: {
          ...reported,
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
    // The child the runner's memory watch reads and, over its limit,
    // kills. It is this process's own child, with no unit of its own (D7).
    get pid() {
      return child.pid ?? null;
    },
    lacks: [],
    async feed(message) {
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
  start: open,
};
