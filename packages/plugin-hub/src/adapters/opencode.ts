import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OPENCODE_CONFIG_ENV, OPENCODE_KEY_ENV, effectiveRefusal, identityOf, type OpenCodeIdentity } from "./opencode-config.ts";
import { watchChild } from "./opencode-process.ts";
import {
  DEFAULT_EFFORT, TurnTracker, busEvents, effortRefusal, messageInfo, newMessageId, openCodeHttp, refusalOf, textOf, usageOf, variantsOf,
  type BusEvent, type MessageInfo, type OpenCodeHttp, type TurnOutcome,
} from "./opencode-wire.ts";
import {
  FeedNotWritten,
  type Adapter, type AdapterCapabilities, type AdapterProgress, type AdapterSession, type AdapterUsage, type TurnEnd, type TurnRefusal,
} from "./types.ts";

/**
 * The OpenCode adapter: the engine's own server, driven over its own HTTP and event API. The hub
 * writes no model loop and no tool loop. One server process per conversation, in its own box and
 * its own session directory, and the five verbs map onto what the server publishes:
 *
 *   feed        `POST /session/:id/prompt_async`, asked for after the event stream is open
 *   receipt     the engine's own echo of the user message on the event stream
 *   progress    assistant text, tool starts and tool results from the same stream
 *   end of turn `session.idle`, and the answer read from the engine's record of its messages
 *   resume      the hub's session id mapped to the engine's own (`hub-session.json`), never "the latest"
 *   stop        `POST /session/:id/abort`, then the process tree, judged by the process table
 *
 * NOTHING IS SENT TWICE AND NOTHING FALLS BACK. A prompt is posted once. A rejection of that post
 * is uncertain (only `FeedNotWritten` says nothing was sent, and it is thrown only before the first
 * byte; the spec's 400 and 404 are not read as "not written" either, because a server that answered
 * late or after a restart cannot be told from one that never saw the post). A lost event stream ends
 * the session as exited and does not re-post anything, a session that is not in the map is refused and
 * not replaced by a fresh one, and a model the engine answered with that is not the bound one refuses
 * the turn.
 *
 * THE PROMPT CARRIES THE HUB'S OWN MESSAGE ID (`messageID`, which the spec's prompt body accepts), so the
 * engine's echo of that message is the receipt and nothing is correlated by guessing at text.
 *
 * EFFORT IS NEVER DROPPED. A preset's `effort` of `default` sends no variant. Any other value is sent as the
 * `variant` of the same name, and only after the running engine has listed that variant for this model
 * (`GET /provider`); a model with no such variant, or one the engine does not know, is a start refused
 * by name (`opencode-effort-unsupported`) before any session is made.
 */

/**
 * The builds on which something was actually measured: a build is listed for what was run against the
 * real server, with the observation written beside it, exactly as the Claude adapter's tables are. A build
 * that is not listed has that capability false.
 *
 *   sessionStore       a session created by the server survives the server being stopped and started
 *                      again under the same data directory, and `GET /session/:id` finds it.
 *   delegationControl  the effective configuration read back from the running server holds the `task`
 *                      permission at deny and the subagent depth at 0, and lists no subagent. It is a
 *                      statement about the CONFIGURATION AS READ BACK. It is not a statement that a call
 *                      to the task tool is refused when a model makes one.
 *   safeResume         a session resumed after an interrupted turn replays no unfinished tool call
 *                      and continues no assignment on its own.
 *
 * 1.18.34 (the pinned darwin-arm64 binary, `opencode-lifecycle-mac.json` and `opencode-lifecycle-pi.json`,
 * root's two machines, and the boxed run `opencode-boxed-mac.json`; no model was called in any of them):
 *   sessionStore       listed. The session a first server created was found again by id by a second server
 *                      started over the same data directory, on both machines, and through this adapter
 *                      (boxed) by the id the hub's map names.
 *   delegationControl  listed, for exactly the statement above. Both machines read back `task` deny, depth 0
 *                      and no listed subagent, and the adapter's own start (which refuses a server whose
 *                      effective configuration differs) held on the real binary. NOT shown: that the task tool
 *                      refuses a call (`GET /experimental/tool/ids` still lists `task`: that is the registry of
 *                      tools, not the effective permissions), that a shell cannot reach a model API, or
 *                      anything about a tool profile other than the one the boxed run used.
 *   safeResume         NOT listed. Nothing interrupted a turn that had an unfinished tool call and resumed
 *                      it, because that needs a model. Without it a conversation with held work is not
 *                      resumed by the runner (`safe-resume-unvalidated`) and a fresh turn is not started on it.
 */
export interface OpenCodeValidated {
  sessionStore: readonly string[];
  delegationControl: readonly string[];
  safeResume: readonly string[];
}

export const VALIDATED: OpenCodeValidated = { sessionStore: ["1.18.34"], delegationControl: ["1.18.34"], safeResume: [] };

export interface OpenCodeOptions {
  validated?: OpenCodeValidated;
  /** How long a server may take to answer its health check. */
  startTimeoutMs?: number;
}

/** What the adapter keeps beside the engine's own state: which engine session is which hub session, and under what identity. */
interface SessionMap {
  version: 1;
  sessions: Record<string, { engine_session: string; identity: OpenCodeIdentity; engine_version: string | null }>;
}

const mapFile = (cwd: string) => join(cwd, "opencode", "hub-session.json");

function readMap(cwd: string): SessionMap {
  let text: string;
  try { text = readFileSync(mapFile(cwd), "utf8"); } catch { return { version: 1, sessions: {} }; }
  let value: SessionMap;
  try { value = JSON.parse(text) as SessionMap; } catch { throw new Error("opencode-session-map-unreadable"); }
  if (value?.version !== 1 || !value.sessions || typeof value.sessions !== "object") throw new Error("opencode-session-map-unreadable");
  return value;
}

function writeMap(cwd: string, map: SessionMap): void {
  const file = mapFile(cwd);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file + ".next", JSON.stringify(map), { mode: 0o600 });
  renameSync(file + ".next", file);
}

const sameIdentity = (a: OpenCodeIdentity, b: OpenCodeIdentity) =>
  a.adapter === b.adapter && a.provider === b.provider && a.model === b.model && a.endpoint === b.endpoint;

/** The identity a launch was prepared for, read back out of the configuration it carries. */
function identityOfLaunch(expected: Record<string, unknown>, preset: { provider: string; model: string }): OpenCodeIdentity {
  const [provider, ...rest] = String(expected.model ?? "").split("/");
  const options = ((expected.provider as Record<string, { options?: { baseURL?: unknown } }> | undefined)?.[provider])?.options;
  const identity = identityOf({ provider, model: rest.join("/") }, typeof options?.baseURL === "string" ? options.baseURL : null);
  if (identity.provider !== preset.provider || identity.model !== preset.model) throw new Error("opencode-identity-mismatch");
  return identity;
}

async function freePort(): Promise<number> {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}

const TAIL_BYTES = 4096;

async function open(options: Parameters<Adapter["start"]>[0], settings: { startTimeoutMs: number }): Promise<AdapterSession> {
  // A prepared launch is the only way in: what the engine is told is the launch's, and a default
  // argv here would be a server nobody restricted.
  const env = options.env ?? {};
  const rawConfig = env[OPENCODE_CONFIG_ENV];
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (!options.argv || !options.cwd || !rawConfig || !password) throw new Error("opencode-launch-required");
  const expected = JSON.parse(rawConfig) as Record<string, unknown>;
  const identity = identityOfLaunch(expected, options.preset);
  const permission = expected.permission as Record<string, unknown>;
  if ((permission.bash === "allow" || permission.edit === "allow") && !options.wrap) throw new Error("box-required");
  // `default` is the engine's own default: no variant is sent. Anything else is a variant of that name, checked below.
  const effort = options.preset.effort;
  if (typeof effort !== "string" || effort.trim() === "") throw new Error("opencode-effort-unsupported: the preset names no effort");
  const variant = effort === DEFAULT_EFFORT ? null : effort;
  if (options.sessionId) throw new Error("opencode-session-unsupported");

  // The refusals that need no process come first. A resume of a session this machine's map does not
  // hold, or holds under another identity, is a conversation the engine cannot continue as it was:
  // it is refused by name and a new session is never made in its place.
  const hubId = options.session?.id ?? null;
  const mapped = hubId === null ? null : readMap(options.cwd).sessions[hubId] ?? null;
  if (options.session?.resume) {
    if (!mapped) throw new Error("opencode-session-unknown");
    if (!sameIdentity(mapped.identity, identity)) throw new Error("opencode-identity-mismatch");
  } else if (mapped) {
    throw new Error("opencode-session-exists");
  }

  const port = await freePort();
  const args = [...options.argv, "--port", String(port)];
  const argv = typeof options.wrap === "function" ? options.wrap(args) : args;
  const child = Bun.spawn(argv, {
    stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: options.cwd, env: options.env,
    // ASKED FOR, NEVER ASSUMED: a child that leads a process group of its own can be stopped and looked
    // for as a group. Whether the runtime honoured it is read back from the process table.
    ...({ detached: true } as object),
  });
  const watch = watchChild(child);

  // The last of what the server wrote, for the message of a start that failed, with the key and the
  // password taken out of it. Drained for the life of the child so a full pipe never stops it.
  let tail = "";
  const secrets = [env[OPENCODE_KEY_ENV], password].filter((one): one is string => typeof one === "string" && one !== "");
  const redact = (text: string) => secrets.reduce((said, secret) => said.split(secret).join("[redacted]"), text);
  for (const stream of [child.stdout, child.stderr] as ReadableStream<Uint8Array>[]) {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          tail = (tail + decoder.decode(value, { stream: true })).slice(-TAIL_BYTES);
        }
      } catch { /* the child took the pipe with it */ }
    })();
  }

  const receipts: ((messageId: string) => void)[] = [];
  const progress: ((event: AdapterProgress) => void)[] = [];
  const ends: ((end: TurnEnd) => void)[] = [];
  let closed = false;
  // An ended turn nobody is waiting for any more (a stop, a close) says nothing to the runner.
  let quiet = false;
  let terminal!: (cause: unknown) => void;
  const exited = new Promise<unknown>(resolve => { terminal = resolve; });
  void child.exited.then(code => terminal({ cause: "child-exited", code }));
  const controller = new AbortController();

  const shut = async (): Promise<void> => {
    if (closed) { await child.exited; return; }
    closed = true;
    quiet = true;
    controller.abort();
    try { child.kill(); } catch { /* it was already gone */ }
    // A server that is waiting for a tool to finish is not waited for for ever.
    const force = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      if (watch.ownGroup !== null) { try { process.kill(-watch.ownGroup, "SIGKILL"); } catch { /* empty */ } }
    }, 5000);
    try { await child.exited; } finally { clearTimeout(force); }
  };

  const http: OpenCodeHttp = openCodeHttp(port, password);
  let engineSession = "";
  let streaming!: AsyncIterator<BusEvent>;
  let version: string | null = null;
  try {
    // The server is up when it says so, and it is THIS launch's server when it answers its own
    // password and refuses a wrong one: a stranger on a port that was free a moment ago does neither.
    const stranger = openCodeHttp(port, `${password}-not`);
    const until = Date.now() + settings.startTimeoutMs;
    for (;;) {
      if (watch.gone()) throw new Error(`opencode-server-exited: ${redact(tail).trim()}`);
      if (Date.now() > until) throw new Error(`opencode-server-timeout: ${redact(tail).trim()}`);
      try {
        const health = await http.request("GET", "/global/health", undefined, { timeoutMs: 2000 });
        if (health.status === 200 && (health.body as { healthy?: unknown } | null)?.healthy === true) {
          version = typeof (health.body as { version?: unknown }).version === "string" ? (health.body as { version: string }).version : null;
          break;
        }
        if (health.status === 401) throw new Error("opencode-server-not-ours");
      } catch (error) {
        if ((error as Error).message === "opencode-server-not-ours") throw error;
      }
      await Bun.sleep(100);
    }
    if ((await stranger.request("GET", "/global/health", undefined, { timeoutMs: 5000 })).status !== 401) throw new Error("opencode-server-unauthenticated");

    // THE RESTRICTIONS ARE READ BACK, not assumed. A server whose effective configuration is not the
    // one that was asked for is not started on, and nothing is substituted.
    const effective = await http.request("GET", "/config", undefined, { timeoutMs: 10_000 });
    const why = effective.status === 200 ? effectiveRefusal(expected, effective.body) : `config-status-${effective.status}`;
    if (why !== null) throw new Error(`opencode-config-unverified: ${why}`);
    // The key reached the server when the provider reads as connected. That is a read and costs no model call.
    const providers = await http.request("GET", "/provider", undefined, { timeoutMs: 10_000 });
    const connected = (providers.body as { connected?: unknown } | null)?.connected;
    if (providers.status !== 200 || !Array.isArray(connected) || !connected.includes(identity.provider)) throw new Error("opencode-provider-not-connected");
    // THE PRESET'S EFFORT IS HONOURED OR REFUSED, before any session is made or mapped. The same read says
    // which variants the engine itself lists for this model, and only one of those names is ever sent.
    const refusedEffort = effortRefusal(effort, variantsOf(providers.body, identity.provider, identity.model));
    if (refusedEffort !== null) throw new Error(refusedEffort);

    if (options.session?.resume) {
      // The engine is asked for the session the map names, and it is that one or the start is refused.
      const found = await http.request("GET", `/session/${encodeURIComponent(mapped!.engine_session)}`, undefined, { timeoutMs: 10_000 });
      if (found.status !== 200 || (found.body as { id?: unknown } | null)?.id !== mapped!.engine_session) throw new Error("opencode-session-missing");
      engineSession = mapped!.engine_session;
    } else {
      const made = await http.request("POST", "/session", { title: hubId === null ? "hub" : `hub:${hubId}` }, { timeoutMs: 10_000 });
      const id = (made.body as { id?: unknown } | null)?.id;
      if (made.status !== 200 || typeof id !== "string" || id === "") throw new Error("opencode-session-not-created");
      engineSession = id;
      if (hubId !== null) {
        const map = readMap(options.cwd);
        map.sessions[hubId] = { engine_session: id, identity, engine_version: version };
        writeMap(options.cwd, map);
      }
    }

    // The stream is open BEFORE anything is posted, so no event of the turn can be missed.
    const response = await http.stream(controller.signal);
    if (response.status !== 200) throw new Error(`opencode-events-unavailable: ${response.status}`);
    streaming = busEvents(response)[Symbol.asyncIterator]();
    let waiting: ReturnType<typeof setTimeout> | undefined;
    const first = await Promise.race([streaming.next(), new Promise<null>(resolve => { waiting = setTimeout(() => resolve(null), 10_000); })]);
    clearTimeout(waiting);
    if (!first || first.done || first.value.type !== "server.connected") throw new Error("opencode-events-unavailable");
  } catch (error) {
    await shut().catch(() => {});
    throw error instanceof Error ? new Error(redact(error.message)) : error;
  }

  let pending: { id: string; text: string } | null = null;
  const route = { providerID: identity.provider, modelID: identity.model };

  /** Read the answer from the engine's own record of the turn's messages, and settle. */
  const conclude = async (outcome: TurnOutcome): Promise<void> => {
    let end: TurnEnd;
    try { end = await settle(outcome); } catch (error) {
      end = { text: "", session_id: hubId, refused: { cause: "other", said: redact(String((error as Error)?.message ?? error)) },
        usage: usageFor([], null, outcome, null) };
    }
    if (quiet) return;
    for (const listener of ends) listener(end);
  };

  const evidenceOf = (status: number | null): Record<string, unknown> | null =>
    status === null ? null : { kind: "authenticated-response", status, credential: options.credentialId };

  const usageFor = (infos: readonly MessageInfo[], evidence: Record<string, unknown> | null, outcome: TurnOutcome, note: string | null): AdapterUsage => {
    const counts = usageOf(infos);
    const models = [...new Set(infos.map(one => one.modelID).filter((one): one is string => one !== null))].sort();
    return {
      input_tokens: counts.input, cached_input_tokens: counts.cached, output_tokens: counts.output,
      plan_usage: null, window: null,
      resolved_model_ids: models, primary_model_id: [...infos].reverse().find(one => one.modelID !== null)?.modelID ?? null,
      raw: {
        engine: "opencode", engine_version: version, engine_session: engineSession, variant,
        providers: [...new Set(infos.map(one => one.providerID).filter((one): one is string => one !== null))].sort(),
        messages: outcome.messages.map(one => one.id), evidence, ...(note ? { note } : {}),
      },
    };
  };

  const abort = async () => {
    try { await http.request("POST", `/session/${encodeURIComponent(engineSession)}/abort`, undefined, { timeoutMs: 5000 }); } catch { /* the turn is refused either way */ }
  };

  const settle = async (outcome: TurnOutcome): Promise<TurnEnd> => {
    const refused = (refusal: TurnRefusal, infos: readonly MessageInfo[], evidence: Record<string, unknown> | null): TurnEnd =>
      ({ text: "", session_id: hubId, refused: refusal, usage: usageFor(infos, evidence, outcome, null) });
    // No permission is ever granted, and no child session is ever expected: either one is the engine doing
    // something the hub did not allow, and the turn is stopped and refused rather than let to go on.
    if (outcome.permission !== null) {
      await abort();
      return refused({ cause: "other", said: `opencode asked for a permission the hub never grants: ${outcome.permission}` }, [], null);
    }
    if (outcome.foreign.length > 0) {
      await abort();
      return refused({ cause: "other", said: "native delegation observed: a session other than the conversation's spoke" }, [], null);
    }
    // What the engine itself holds of each message is what counts. A message that cannot be read falls
    // back to what the stream carried of it, which is the same data read from the other place.
    const infos: MessageInfo[] = [];
    let text = "";
    for (const { id, info } of outcome.messages) {
      let held = info, said: string | null = null;
      try {
        const got = await http.request("GET", `/session/${encodeURIComponent(engineSession)}/message/${encodeURIComponent(id)}`, undefined, { timeoutMs: 10_000 });
        const body = got.body as { info?: unknown; parts?: unknown } | null;
        if (got.status === 200 && body) {
          held = messageInfo(body.info) ?? info;
          said = textOf(body.parts);
        }
      } catch { /* the stream's own account stands for this message */ }
      infos.push(held);
      if ((said ?? "") !== "") text = said!;
    }
    if (text === "") text = outcome.streamed;
    const error = outcome.error ?? infos.find(one => one.error !== null)?.error ?? null;
    if (error?.name === "MessageIdNotKept") await abort();
    if (error) return refused(refusalOf(error), infos, evidenceOf(error.status === 401 ? 401 : null));
    // A VARIANT THE ENGINE RECORDED AS ANOTHER THAN THE ONE ASKED FOR is a different effort from the one the
    // preset names, so the turn is refused and its text is not posted. A record that names no variant at all
    // proves nothing either way and is not read as a contradiction.
    if (variant !== null) {
      const applied = [outcome.echoed?.variant ?? null, ...infos.map(one => one.variant)].filter((one): one is string => one !== null);
      const wrong = applied.find(one => one !== variant);
      if (wrong !== undefined) {
        return refused({ cause: "other", said: `opencode recorded the variant ${wrong} and the preset's effort is ${variant}` }, infos, null);
      }
    }
    // THE MODEL THAT ANSWERED IS THE BOUND ONE OR THE TURN IS REFUSED. An engine that answered from another
    // provider or model has fallen back to something nobody approved, and its text is not posted.
    const stray = infos.find(one => (one.providerID !== null && one.providerID !== identity.provider) || (one.modelID !== null && one.modelID !== identity.model));
    if (stray) {
      return refused({ cause: "other", said: `opencode answered with ${stray.providerID ?? "?"}/${stray.modelID ?? "?"} and the session is bound to ${identity.provider}/${identity.model}` }, infos, null);
    }
    return { text, session_id: hubId, refused: null, usage: usageFor(infos, evidenceOf(200), outcome, null) };
  };

  const tracker = new TurnTracker(engineSession, {
    receipt: () => {
      const taken = pending;
      if (!taken) return;
      pending = null;
      for (const listener of receipts) listener(taken.id);
    },
    progress: event => { for (const listener of progress) listener(event); },
    ended: outcome => { void conclude(outcome); },
  });

  void (async () => {
    try {
      for (;;) {
        const next = await streaming.next();
        if (next.done || closed) return;
        tracker.handle(next.value);
      }
    } catch {
      if (!closed) terminal({ cause: "stream-failed" });
    } finally {
      // An event stream that ends under a server that is still there is a session whose events can no
      // longer be seen. It is reported as exited and nothing is posted again.
      if (!closed) terminal({ cause: "stream-ended" });
    }
  })();

  return {
    exited,
    get sessionId() { return hubId; },
    // The engine's own session, mapped to the hub's: the id the hub asked for is reported only once the
    // engine has answered for the session behind it (created it, or found it by the id the map names).
    get reportedSessionId() { return hubId; },
    get pid() { return child.pid ?? null; },
    lacks: [],
    processes: () => watch.snapshot(),
    partial: () => watch.partial(),
    group: () => watch.ownGroup,
    exitEvidence: () => watch.exitEvidence(),
    async interrupt({ graceMs }) {
      // Nothing more is fed, and what the aborted turn ends with is nobody's any more.
      closed = true;
      quiet = true;
      watch.snapshot();
      if (tracker.open) {
        await abort();
        const until = Date.now() + Math.min(graceMs, 2000);
        while (tracker.open && Date.now() < until) await Bun.sleep(25);
      }
      controller.abort();
      return await watch.stop(graceMs);
    },
    async feed(message) {
      // THE ONLY REJECTIONS THAT SAY NOTHING WAS WRITTEN: nothing has been touched yet. Once the post
      // below has begun, any failure of it is uncertain and is thrown as it is.
      if (closed || watch.gone()) throw new FeedNotWritten(closed ? "session-closed" : "server-exited");
      if (tracker.open) throw new FeedNotWritten("turn-open");
      pending = { id: message.id, text: message.text };
      // The id is the hub's, made before the post, so the engine's echo of it is the receipt.
      const messageID = newMessageId();
      tracker.begin(message.text, messageID);
      const sent = await http.request("POST", `/session/${encodeURIComponent(engineSession)}/prompt_async`,
        { messageID, parts: [{ type: "text", text: message.text }], model: route, agent: "build", ...(variant === null ? {} : { variant }) },
        { timeoutMs: 30_000 });
      // Whatever the status, a post that has begun is uncertain: 204 is "accepted", and nothing but the
      // echo on the stream says the message is held.
      if (sent.status < 200 || sent.status >= 300) throw new Error(`opencode-prompt-rejected: ${sent.status}`);
    },
    onReceipt(handler) { receipts.push(handler); },
    onProgress(handler) { progress.push(handler); },
    onTurnEnd(handler) { ends.push(handler); },
    close: shut,
  };
}

export function createOpenCode(options: OpenCodeOptions = {}): Adapter {
  const validated = options.validated ?? VALIDATED;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  return {
    name: "opencode",
    // No `session` port: what the engine keeps for a conversation lives in its own database under the
    // conversation's session directory, and nobody has measured that a copy of it resumes anywhere else.
    // A conversation of this engine therefore does not move between machines, and that is said by the
    // absence of the port and not by a pretence of one.
    async capabilities(context) {
      // Loaded here and not at the top: see `opencode-launch.ts`.
      const [launch, found] = await Promise.all([import("./launch.ts"), import("./opencode-launch.ts")]);
      // The credential is checked the way a launch checks it, so a key that is gone is "nothing shown".
      found.readModelKey(launch.credentialSource(context.registry, context.preset));
      const version = found.probeOpenCodeVersion(context.probe?.bin, context.probe?.timeoutMs);
      const stableSession = validated.sessionStore.includes(version);
      return {
        stableSession,
        // For this engine "delegation disabled" is the configuration as the running server reports it (see
        // `OpenCodeValidated`), which `start` re-reads on every launch. It is not a claim that a task call is refused.
        delegationDisabled: validated.delegationControl.includes(version),
        safeResume: stableSession && validated.safeResume.includes(version),
        version,
      } satisfies AdapterCapabilities;
    },
    async prepareLaunch(input, probe) {
      const launch = await import("./opencode-launch.ts");
      const version = launch.probeOpenCodeVersion(probe?.bin, probe?.timeoutMs);
      // A build whose restrictions nobody read back is not one an ordinary agent is launched on: it is
      // refused by name and its version, and nothing is substituted. The launch also reads the
      // configuration back from the running server, so this is the second statement of one rule.
      if (input.purpose === "ordinary" && !validated.delegationControl.includes(version)) {
        throw new Error(`native-tool-control-unvalidated: opencode ${version}`);
      }
      return launch.makeOpenCodeLaunch(input, probe?.bin ?? "opencode");
    },
    start: options_ => open(options_, { startTimeoutMs }),
  };
}

export const openCode: Adapter = createOpenCode();
