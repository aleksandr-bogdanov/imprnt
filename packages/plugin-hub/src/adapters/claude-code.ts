import type {
  Adapter,
  AdapterProgress,
  AdapterSession,
  AdapterUsage,
  TurnEnd,
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

async function open(options: {
  preset: { model: string; effort: string };
  sessionId: string | null;
  cwd?: string;
}): Promise<AdapterSession> {
  const args = ["claude", ...FLAGS, "--model", options.preset.model, "--effort", options.preset.effort];
  if (options.sessionId) args.push("--resume", options.sessionId);

  const child = Bun.spawn(args, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "inherit",
    cwd: options.cwd,
  });

  const receipts: ((messageId: string) => void)[] = [];
  const progress: ((event: AdapterProgress) => void)[] = [];
  const ends: ((end: TurnEnd) => void)[] = [];

  let sessionId = options.sessionId;
  let pending: Pending | null = null;
  // The plan windows arrive once per process rather than once per turn, so the
  // newest the loop has reported is what every turn of this session records.
  let planUsage: Record<string, unknown> | null = null;
  let closed = false;

  const handle = (event: Record<string, unknown>) => {
    if (event.type === "rate_limit_event") {
      const info = event.rate_limit_info as Record<string, unknown> | undefined;
      planUsage = (info?.unifiedWindows as Record<string, unknown>) ?? info ?? null;
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
      const usage: AdapterUsage = {
        input_tokens: numberOrNull(reported.input_tokens),
        cached_input_tokens: numberOrNull(reported.cache_read_input_tokens),
        output_tokens: numberOrNull(reported.output_tokens),
        plan_usage: planUsage,
        raw: {
          ...reported,
          num_turns: event.num_turns,
          result: event.result,
          total_cost_usd: event.total_cost_usd,
        },
      };
      for (const listener of ends) {
        listener({ text: String(event.result ?? ""), session_id: sessionId, usage });
      }
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
      // The loop went away, which is what closing it looks like from here.
    }
  })();

  return {
    get sessionId() {
      return sessionId;
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
    async close() {
      closed = true;
      child.stdin.end();
      child.kill();
      await child.exited;
    },
  };
}

export const claudeCode: Adapter = {
  name: "claude-code",
  start: (options) => open(options),
};
