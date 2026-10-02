import type { AdapterProgress, TurnRefusal } from "./types.ts";

/**
 * How the hub speaks to a running `opencode serve`, and how what it says is read.
 * HTTP for the commands, one server-sent-event stream for everything that happens.
 *
 * READ AGAINST THE REAL SPEC. Every name and field below was checked against the pinned
 * v1.18.34 OpenAPI document (`opencode-openapi.json`, 162 paths), not recalled:
 *   - `POST /session/{id}/prompt_async` takes `{ parts, messageID? (^msg), model? { providerID, modelID },
 *     agent?, variant?, noReply?, ... }` and answers 204 "Prompt accepted"; `messageID` is the caller's;
 *   - `message.updated` is `{ sessionID, info }` with `info` a `UserMessage` (`model { providerID, modelID,
 *     variant? }`) or an `AssistantMessage` (`parentID`, `providerID`, `modelID`, `variant?`, `error?`,
 *     `tokens { input, output, reasoning, cache { read, write } }`, `cost`);
 *   - `message.part.updated` is `{ sessionID, part, time }`: it carries NO `delta`. The deltas are their own
 *     event, `message.part.delta` `{ sessionID, messageID, partID, field, delta }`, which does not say what kind
 *     of part it belongs to, so a delta is attributed through the `message.part.updated` that named the part;
 *   - `session.idle` `{ sessionID }`, `session.status` `{ sessionID, status: idle | retry | busy }`,
 *     `session.error` `{ sessionID?, error }`, `session.created` `{ sessionID, info: Session (parentID?) }`;
 *   - a request for something the hub never grants is `permission.asked` `{ sessionID, permission, ... }`,
 *     `permission.v2.asked` `{ sessionID, action, ... }`, `question.asked` or `question.v2.asked` `{ sessionID }`;
 *   - the error union (`ProviderAuthError`, `APIError` with `statusCode`, `ContextOverflowError`,
 *     `ContentFilterError`, `MessageAbortedError`, `MessageOutputLengthError`, `StructuredOutputError`,
 *     `UnknownError`) is `{ name, data { message, ... } }`;
 *   - `GET /provider` is `{ all: Provider[], default, connected }` and a model's `variants` is an object whose
 *     keys are the engine's own variant names.
 *
 * WHAT THE SPEC CANNOT SAY, and no measurement has yet: the order in which a turn's events arrive (user
 * `message.updated` before its parts, a part's `message.part.updated` before its first delta), whether
 * `session.idle` follows `session.error`, and whether a message id the caller chose sorts as the engine expects
 * (the spec only requires the `msg` prefix). Each is read so that either order is safe, and none is assumed.
 * The `session.next.*` events (a second, newer family that also names a prompt's `messageID` and has its own
 * `text.delta`) are NOT read: nothing shows that a `prompt_async` publishes them, and reading both families of
 * text would say every word twice.
 */

/** A bus event as the stream delivers it. */
export interface BusEvent {
  type: string;
  properties?: Record<string, unknown>;
}

export interface OpenCodeHttp {
  readonly base: string;
  request(method: "GET" | "POST", path: string, body?: unknown, options?: { timeoutMs?: number; signal?: AbortSignal }): Promise<{ status: number; body: unknown }>;
  /** The event stream. The caller owns the abort. */
  stream(signal: AbortSignal): Promise<Response>;
}

/**
 * The client of one server: loopback, one port, basic auth with the password the launch
 * made. A server that answers a wrong password with 401 is not the one this launch started,
 * which is what tells it from a stranger on a port that was free a moment ago.
 */
export function openCodeHttp(port: number, password: string): OpenCodeHttp {
  const base = `http://127.0.0.1:${port}`;
  const headers = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  return {
    base,
    async request(method, path, body, options = {}) {
      const response = await fetch(base + path, {
        method,
        headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
      const text = await response.text();
      let parsed: unknown = null;
      if (text !== "") { try { parsed = JSON.parse(text); } catch { parsed = text; } }
      return { status: response.status, body: parsed };
    },
    stream: signal => fetch(base + "/event", { headers: { ...headers, Accept: "text/event-stream" }, signal }),
  };
}

/** The events of one stream, one parsed object each. A block that is not JSON is skipped and counted by the caller's own check. */
export async function* busEvents(response: Response): AsyncGenerator<BusEvent> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    // Normalised over the whole buffer, so a CRLF split across two chunks is still one line ending.
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
    let cut = buffer.indexOf("\n\n");
    while (cut >= 0) {
      const block = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      cut = buffer.indexOf("\n\n");
      const data = block.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).replace(/^ /, "")).join("\n");
      if (data === "") continue;
      let event: unknown;
      try { event = JSON.parse(data); } catch { continue; }
      if (event && typeof event === "object" && typeof (event as BusEvent).type === "string") yield event as BusEvent;
    }
  }
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => value && typeof value === "object" && !Array.isArray(value) ? value as Json : null;
const str = (value: unknown): string | null => typeof value === "string" ? value : null;

/** What the engine said went wrong, and the status when it was an HTTP one. */
export interface EngineError {
  name: string;
  message: string;
  status: number | null;
}

export function engineError(raw: unknown): EngineError | null {
  const error = obj(raw);
  if (!error) return null;
  const data = obj(error.data);
  const status = data?.statusCode ?? data?.status;
  return {
    name: str(error.name) ?? "UnknownError",
    message: str(data?.message) ?? str(error.message) ?? str(error.name) ?? "the engine reported an error",
    status: typeof status === "number" ? status : null,
  };
}

/** Whether what was said names an allowance or a throttle rather than a credential. Nothing parses a number out of it. */
const RATE_WORDS = /rate[ _-]?limit|usage limit|quota|too many requests|insufficient/i;

/**
 * Why the engine would not answer, typed so the runner branches on no engine's name. A `login`
 * is a credential no retry fixes; `ProviderAuthError` and a 401 are that. Anything the
 * provider throttled is `window`, which for a per-token key has no reset to wait for and holds
 * only the agent that met it. Everything else is `other`.
 */
export function refusalOf(error: EngineError): TurnRefusal {
  if (error.name === "ProviderAuthError" || error.status === 401) return { cause: "login", said: error.message };
  if (error.status === 429 || RATE_WORDS.test(error.message)) return { cause: "window", said: error.message };
  return { cause: "other", said: error.message };
}

/** A message's `info`, as far as the hub reads it. */
export interface MessageInfo {
  id: string;
  role: string;
  /** An assistant message's user message. Null where the message does not say. */
  parentID: string | null;
  providerID: string | null;
  modelID: string | null;
  /** The variant the message records: an assistant's own, or the one on a user message's `model`. */
  variant: string | null;
  summary?: boolean;
  finish?: string | null;
  tokens: { input: number | null; output: number | null; cached: number | null };
  error: EngineError | null;
}

export function messageInfo(raw: unknown): MessageInfo | null {
  const info = obj(raw);
  const id = str(info?.id);
  if (!info || !id) return null;
  const tokens = obj(info.tokens);
  // A user message names its model under `model`; an assistant names it directly.
  const bound = obj(info.model);
  const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    id, role: str(info.role) ?? "", parentID: str(info.parentID),
    providerID: str(info.providerID) ?? str(bound?.providerID), modelID: str(info.modelID) ?? str(bound?.modelID),
    variant: str(info.variant) ?? str(bound?.variant),
    tokens: { input: num(tokens?.input), output: num(tokens?.output), cached: num(obj(tokens?.cache)?.read) },
    error: engineError(info.error),
    summary: info.summary === true,
    finish: str(info.finish),
  };
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
let stamped = 0;
let counted = 0;

/**
 * A message id the hub chooses for the prompt it posts, so the engine's echo of that very message is the
 * receipt and an answer is tied to it by `parentID`. The spec requires only the `msg` prefix (`^msg`, and
 * `^msg_` on the newer events). The engine's own ids rise with time and its prompt loop is believed to compare
 * them to decide which user message an assistant message answers, so this one is made the way the engine makes
 * its own: `msg_`, 48 bits of millisecond clock and a counter in hex, then 14 random base-62 characters. That
 * ordering rule is recalled, not in the spec; a plain random id would have broken it, and this one cannot.
 */
export function newMessageId(now = Date.now()): string {
  if (now !== stamped) { stamped = now; counted = 0; }
  counted += 1;
  const clock = ((BigInt(now) * 0x1000n + BigInt(counted)) & 0xffffffffffffn).toString(16).padStart(12, "0");
  const random = Array.from(crypto.getRandomValues(new Uint8Array(14)), byte => BASE62[byte % 62]).join("");
  return `msg_${clock}${random}`;
}

/** What a preset's effort says when it asks for the engine's own default: no variant is sent at all. */
export const DEFAULT_EFFORT = "default";

/**
 * The variant names the engine itself lists for a model (`GET /provider`, `all[].models[model].variants`),
 * sorted. NULL when the provider or the model is not in the engine's catalogue at all, which is not the same
 * as a model that lists none (an empty array).
 */
export function variantsOf(providers: unknown, provider: string, model: string): string[] | null {
  const all = obj(providers)?.all;
  if (!Array.isArray(all)) return null;
  const found = obj(obj(all.map(obj).find(one => one?.id === provider)?.models)?.[model]);
  return found ? Object.keys(obj(found.variants) ?? {}).sort() : null;
}

/**
 * Whether a preset's effort can be honoured on this model. `default` is always honoured, by sending no variant.
 * Any other effort is honoured only as a variant of the very same name that the running engine lists for the
 * model: there is no translation table, so no effort is guessed at. NULL is "honoured", anything else is why not.
 */
export function effortRefusal(effort: string, variants: readonly string[] | null): string | null {
  if (effort === DEFAULT_EFFORT) return null;
  if (variants === null) return `opencode-effort-unsupported: ${effort} (the model is not in the engine's catalogue, so no variant of it can be checked)`;
  if (!variants.includes(effort)) return `opencode-effort-unsupported: ${effort} (this model's variants: ${variants.length > 0 ? variants.join(", ") : "none"})`;
  return null;
}

/**
 * The counts of a turn, summed over its assistant messages. A count any message did not report
 * is null, never a partial sum. The engine writes zero for a provider that reported nothing, and
 * a real turn never reads zero input and writes zero output, so that pair is read as unknown.
 */
export function usageOf(infos: readonly MessageInfo[]): { input: number | null; cached: number | null; output: number | null } {
  const total = (pick: (info: MessageInfo) => number | null) => {
    const counts = infos.map(pick);
    return infos.length > 0 && counts.every((count): count is number => count !== null) ? counts.reduce((a, b) => a + b, 0) : null;
  };
  const read = { input: total(one => one.tokens.input), cached: total(one => one.tokens.cached), output: total(one => one.tokens.output) };
  return read.input === 0 && read.output === 0 ? { input: null, cached: null, output: null } : read;
}

/** The text of a fetched message: its text parts, in order, without those the engine marked as its own insertions. */
export function textOf(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts.map(obj).filter((part): part is Json => part !== null && part.type === "text" && part.synthetic !== true && part.ignored !== true)
    .map(part => str(part.text) ?? "").join("");
}

/** How a turn ended, by the stream's account. The adapter fetches the messages and settles it. */
export interface TurnOutcome {
  /** The assistant messages of this turn, in the order they appeared, and the newest `info` of each. */
  messages: { id: string; info: MessageInfo }[];
  /** The text the stream carried for the last assistant message that had any. Used only if the message cannot be fetched. */
  streamed: string;
  /** Only these messages may supply the answer after the latest compaction. */
  answerIds?: string[];
  error: EngineError | null;
  /** What the engine asked for that the hub never grants (a permission, a question). Either one ends the turn as a refusal. */
  permission: string | null;
  /** Sessions other than this one that spoke: a child session is native delegation. */
  foreign: string[];
  /** The engine's echo of the user message the hub posted, when the stream showed it. Its `variant` is what the engine applied. */
  echoed: MessageInfo | null;
}

export interface TurnSink {
  receipt(): void;
  progress(event: AdapterProgress): void;
  ended(outcome: TurnOutcome): void;
}

/** A part the stream has named: what it is, which message it belongs to, and the text it is known to hold. */
interface SeenPart { message: string; type: string; text: string }

/**
 * One session's turn, read from the events the server publishes, as a pure state machine.
 *
 * `begin` is called before the prompt is posted, with the message id the hub chose for it, and from
 * then on:
 *   - the receipt is the engine's own `message.updated` for THAT id (a user message). Failing the id
 *     matching, an assistant message that names it as its `parentID` also shows the engine has it. A
 *     second copy of the same text under any other id outside a verified overflow replay is the engine not keeping the caller's id, which
 *     ends the turn as an error and never as a receipt. Without an id (a caller that has none) the old
 *     rule applies: the first new user message whose text part is exactly what was sent, or the first
 *     new assistant message;
 *   - assistant text is progress, from `message.part.delta` events (attributed through the part the
 *     engine named) and from the growth of a part's own text in `message.part.updated`, never both for
 *     the same words; a tool's first sight is an `action` and its completion an `action_result` that
 *     carries no text;
 *   - the turn ends on `session.idle` (or a status of `idle`) after the receipt, or at once on
 *     `session.error` (except a recoverable context overflow, held until idle or a verified
 *     compaction continuation), or at once on something the hub never grants. An idle before the receipt is the
 *     last turn's and is ignored.
 *
 * It decides nothing about the answer. What was said is fetched by the adapter from the
 * engine's own record of the messages, so a dropped event cannot shorten a reply.
 */
export class TurnTracker {
  private phase: "idle" | "fed" = "idle";
  private sent = "";
  private currentUser: string | null = null;
  private latestUser: string | null = null;
  private previousUser = new Map<string, string | null>();
  private userTexts = new Map<string, string>();
  private compaction: { id: string; source: string; overflow: boolean; complete: boolean } | null = null;
  private answerIds = new Set<string>();
  private sentId: string | null = null;
  private candidate: string | null = null;
  private echoed: MessageInfo | null = null;
  private acknowledged = false;
  private roles = new Map<string, string>();
  private before = new Set<string>();
  private assistants = new Map<string, MessageInfo>();
  private parts = new Map<string, SeenPart>();
  /** Deltas that arrived before the part they belong to was named, kept until it is. */
  private early = new Map<string, string>();
  private tools = new Map<string, "started" | "done">();
  private error: EngineError | null = null;
  private overflow: EngineError | null = null;
  private permission: string | null = null;
  private foreign = new Set<string>();

  constructor(readonly session: string, private readonly sink: TurnSink) {}

  get open(): boolean { return this.phase === "fed"; }

  /** `messageId` is the id the prompt is posted under. Without one the receipt is read from the text, as before. */
  begin(text: string, messageId: string | null = null): void {
    this.phase = "fed";
    this.sent = text;
    this.sentId = messageId;
    this.currentUser = messageId;
    this.latestUser = null;
    this.previousUser.clear();
    this.userTexts.clear();
    this.compaction = null;
    this.answerIds.clear();
    this.candidate = null;
    this.echoed = null;
    this.acknowledged = false;
    this.before = new Set(this.roles.keys());
    this.assistants = new Map();
    this.parts = new Map();
    this.early = new Map();
    this.tools = new Map();
    this.error = null;
    this.overflow = null;
    this.permission = null;
    this.foreign = new Set();
  }

  handle(event: BusEvent): void {
    const properties = event.properties ?? {};
    switch (event.type) {
      case "message.updated": {
        const raw = obj(properties.info);
        if (this.elsewhere(raw?.sessionID ?? properties.sessionID)) return;
        const info = messageInfo(raw);
        if (info) this.message(info);
        return;
      }
      case "message.part.updated": {
        const part = obj(properties.part);
        if (this.elsewhere(part?.sessionID ?? properties.sessionID) || !part) return;
        this.part(part);
        return;
      }
      case "message.part.delta": {
        if (this.elsewhere(properties.sessionID)) return;
        // Only a text field is words; anything else a part streams (a tool's input) is not read.
        if (properties.field !== "text") return;
        const message = str(properties.messageID), part = str(properties.partID), delta = str(properties.delta);
        if (message && part && delta) this.delta(message, part, delta);
        return;
      }
      case "session.created": {
        const info = obj(properties.info);
        if (this.phase === "fed" && str(info?.id) && info!.id !== this.session) this.foreign.add(String(info!.id));
        return;
      }
      case "session.idle":
        if (properties.sessionID === this.session) this.idle();
        return;
      case "session.status":
        if (properties.sessionID === this.session && obj(properties.status)?.type === "idle") this.idle();
        return;
      case "session.error": {
        if (properties.sessionID !== undefined && properties.sessionID !== this.session) return;
        if (this.phase !== "fed") return;
        const reported = engineError(properties.error);
        // processor.ts publishes ContextOverflowError before returning "compact".
        // It is terminal only if idle arrives without a verified continuation.
        if (reported?.name === "ContextOverflowError" && this.acknowledged) {
          this.overflow = reported;
          return;
        }
        this.error = reported ?? { name: "UnknownError", message: "the engine reported an error", status: null };
        this.finish();
        return;
      }
      // Anything the engine stops to ask is a headless session waiting for nobody: no permission is ever
      // granted and no question is ever answered, so each is a turn that ends here, as a refusal.
      case "permission.asked":
      case "permission.v2.asked":
      case "question.asked":
      case "question.v2.asked": {
        if (properties.sessionID !== this.session || this.phase !== "fed") return;
        this.permission = event.type.startsWith("question.") ? "question" : str(properties.permission) ?? str(properties.action) ?? "unnamed";
        this.finish();
        return;
      }
    }
  }

  /** Whether an event belongs to another session, which is remembered during a turn and is never ours to read. */
  private elsewhere(session: unknown): boolean {
    if (session === this.session || session === undefined) return false;
    if (this.phase === "fed" && typeof session === "string") this.foreign.add(session);
    return true;
  }

  private acknowledge(): void {
    if (this.acknowledged || this.phase !== "fed") return;
    this.acknowledged = true;
    this.sink.receipt();
  }

  private message(info: MessageInfo): void {
    const first = !this.roles.has(info.id);
    this.roles.set(info.id, info.role);
    if (this.phase !== "fed" || this.before.has(info.id)) return;
    if (info.role === "user") {
      if (first) {
        this.previousUser.set(info.id, this.latestUser);
        this.latestUser = info.id;
      }
      if (this.sentId !== null) {
        // The engine's own message for the id the hub chose: it has the prompt.
        if (info.id === this.sentId) { this.echoed = info; this.acknowledge(); }
      } else if (this.candidate === null && first) this.candidate = info.id;
      return;
    }
    if (info.role !== "assistant") return;
    // v1.18.34 compaction.ts: summaries answer a separate compaction user. They are
    // accounting/error evidence, never reply text or a receipt for the hub's prompt.
    if (info.summary) {
      if (this.compaction?.id !== info.parentID) return;
      this.assistants.set(info.id, info);
      this.compaction.complete = Boolean(info.finish) && !info.error;
      if (info.error) this.error = info.error;
      return;
    }
    if (this.sentId !== null && info.parentID !== null && info.parentID !== this.currentUser) return;
    if (this.compaction && this.currentUser === this.compaction.source) return;
    this.answerIds.add(info.id);
    if (this.compaction?.complete && this.currentUser !== this.compaction.source) this.overflow = null;
    this.assistants.set(info.id, info);
    if (this.sentId === null || info.parentID === this.sentId) this.acknowledge();
  }

  private part(part: Json): void {
    if (this.phase !== "fed") return;
    const message = str(part.messageID);
    if (!message || this.before.has(message)) return;
    const role = this.roles.get(message);
    const text = part.type === "text";
    if (role === "user") {
      if (text && typeof part.text === "string") this.userTexts.set(message, part.text);
      // Correlation is an uninterrupted chain from the acknowledged hub user, not
      // permission to absorb every new message in the session.
      if (part.type === "compaction" && part.auto === true && this.acknowledged &&
          this.previousUser.get(message) === this.currentUser && this.currentUser !== null) {
        if (this.compaction?.id !== message) {
          this.compaction = { id: message, source: this.currentUser, overflow: part.overflow === true, complete: false };
          this.answerIds.clear();
        }
        return;
      }
      if (part.type === "compaction" && part.auto === true) {
        this.error = { name: "CompactionUncorrelated", message: "the engine compacted without an uninterrupted chain from the hub prompt", status: null };
        this.answerIds.clear();
        return;
      }
      const compact = this.compaction;
      if (compact?.complete && this.latestUser === message && this.previousUser.get(message) === compact.id && text &&
          ((part.synthetic === true && obj(part.metadata)?.compaction_continue === true) ||
           (compact.overflow && part.text === this.userTexts.get(compact.source)))) {
        this.currentUser = message;
        return;
      }
    }
    if (this.sentId !== null && text && part.text === this.sent && message !== this.sentId && message !== this.currentUser && role === "user") {
      // The prompt came back as a user message under an id the hub did not choose. Nothing correlates
      // it to the post any more, so it is an error and not a receipt.
      this.error = { name: "MessageIdNotKept", message: "the engine recorded the prompt under another message id than the one the hub chose", status: null };
      this.finish();
      return;
    }
    if (role === "user") {
      const mine = this.sentId !== null ? message === this.sentId : message === this.candidate;
      if (mine && text && part.text === this.sent) this.acknowledge();
      return;
    }
    if (!this.answerIds.has(message)) return;
    this.acknowledge();
    const key = str(part.id) ?? str(part.callID) ?? `${message}:${String(part.type)}`;
    if (text) {
      // The part's own text is a snapshot. The deltas seen so far are the words already said, and what
      // the snapshot adds to them is new; a snapshot that is behind them adds nothing, and one that
      // does not begin with them replaces them without being said again.
      const known = this.parts.get(key);
      // Deltas that came before the part was named are its first words, said now and once.
      const buffered = known ? "" : this.early.get(key) ?? "";
      this.early.delete(key);
      if (buffered !== "") this.sink.progress({ kind: "text", text: buffered });
      const said = known?.text ?? buffered;
      const snapshot = str(part.text) ?? "";
      const next = said.startsWith(snapshot) ? said : snapshot;
      this.parts.set(key, { message, type: "text", text: next });
      if (next.length > said.length && next.startsWith(said)) this.sink.progress({ kind: "text", text: next.slice(said.length) });
      return;
    }
    if (part.type !== "tool") {
      // Reasoning and the like are never words of the answer: its deltas, buffered or yet to come, are dropped.
      this.early.delete(key);
      this.parts.set(key, { message, type: String(part.type), text: "" });
      return;
    }
    const status = str(obj(part.state)?.status);
    if (!status) return;
    if (!this.tools.has(key)) {
      this.tools.set(key, "started");
      this.sink.progress({ kind: "action", text: str(part.tool) ?? "" });
    }
    if ((status === "completed" || status === "error") && this.tools.get(key) !== "done") {
      this.tools.set(key, "done");
      // Only the fact is passed on: a tool's output is a tool's and never leaves this file.
      this.sink.progress({ kind: "action_result", text: "" });
    }
  }

  /**
   * A `message.part.delta`. It names no kind of part, so it is words only once the part has been named as text,
   * and one that arrives first is kept until the part is named (or dropped if it turns out not to be text).
   */
  private delta(message: string, part: string, delta: string): void {
    if (this.phase !== "fed" || this.before.has(message) || this.roles.get(message) === "user") return;
    const seen = this.parts.get(part);
    if (!seen) { this.early.set(part, (this.early.get(part) ?? "") + delta); return; }
    if (seen.type !== "text" || !this.answerIds.has(message)) return;
    seen.text += delta;
    this.sink.progress({ kind: "text", text: delta });
  }

  private idle(): void {
    if (this.phase !== "fed" || !this.acknowledged) return;
    this.finish();
  }

  /** The text the stream carried for one message: its text parts, in the order they first appeared. */
  private streamedBy(message: string): string {
    return [...this.parts.values()].filter(part => part.message === message && part.type === "text").map(part => part.text).join("");
  }

  private finish(): void {
    const order = [...this.assistants.keys()];
    const lastWithText = [...order].reverse().find(id => this.answerIds.has(id) && this.streamedBy(id) !== "");
    if (this.compaction && this.answerIds.size === 0 && !this.error) {
      this.error = { name: "CompactionIncomplete", message: "the engine compacted the turn without a correlated continuation answer", status: null };
    }
    const outcome: TurnOutcome = {
      messages: order.map(id => ({ id, info: this.assistants.get(id)! })),
      answerIds: [...this.answerIds],
      streamed: lastWithText ? this.streamedBy(lastWithText) : "",
      error: this.error ?? this.overflow,
      permission: this.permission,
      foreign: [...this.foreign],
      echoed: this.echoed,
    };
    this.phase = "idle";
    this.sink.ended(outcome);
  }
}
