// The OpenCode adapter driving a real child process that speaks the server's HTTP and event
// API: start, read-back, receipt, progress, the end of a turn, refusal, resume, stop, and what
// happens when the connection is lost.
//
// SYNTHETIC, and said so: the server is `helpers/fake-opencode.ts`, a script that behaves as a
// scenario says. It publishes the event and message shapes of the pinned v1.18.34 OpenAPI document,
// but it chooses the ORDER of events and what a `messageID` or a `variant` does, which the spec does
// not say. A pass here proves the adapter's logic (what it sends, how often, what it refuses, what it
// settles) and NOT that a real OpenCode build behaves so. That is `live/prove-opencode.ts` against
// the pinned binary, and the measurements the result file asks root for.

import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpenCode } from "../src/adapters/opencode.ts"
import { OPENCODE_CONFIG_ENV, OPENCODE_KEY_ENV } from "../src/adapters/opencode-config.ts"
import { makeOpenCodeLaunch } from "../src/adapters/opencode-launch.ts"
import { FeedNotWritten, type AdapterProgress, type AdapterSession, type TurnEnd } from "../src/adapters/types.ts"

const dirs: string[] = []
const open: AdapterSession[] = []
afterAll(async () => {
  for (const session of open.splice(0)) await session.close().catch(() => {})
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const adapter = createOpenCode({ startTimeoutMs: 15_000 })
const PRESET = { adapter: "opencode", model: "synthetic-model", provider: "synthetic-provider", effort: "default", paid: "key" }

function fixture() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hub-opencode-adapter-")))
  dirs.push(dir)
  const tree = join(dir, "tree")
  mkdirSync(tree, { recursive: true })
  const key = "synthetic-model-key-" + crypto.randomUUID()
  mkdirSync(join(dir, "secrets"))
  const keyFile = join(dir, "secrets", "provider.token")
  writeFileSync(keyFile, key + "\n", { mode: 0o600 })
  mkdirSync(join(dir, "bin"))
  const wrapper = join(dir, "bin", "opencode")
  writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "helpers", "fake-opencode.ts"))} "$@"\n`, { mode: 0o755 })
  const sessionDir = join(dir, "state", "p1", "sessions", "p1-lair", "conversation-1")
  const log = join(dir, "fake.log")
  const credential = { id: "provider-key", kind: "model-key", file: keyFile, owner: "p1" }
  const agent = { id: "p1-lair", person: "p1", preset: "opencode-daily", runner: "runner-pi", door: "door-d", chat: "1000000001", tools: ["Read", "Bash"] }
  const input = (preset = PRESET) => ({ registry: null, preset, credential, agent, sessionDir, purpose: "ordinary",
    box: { agent: "p1-lair", person: "p1", tree, otherTrees: [], stateRoot: join(dir, "state", "p1"), sessionDir, purpose: "ordinary" } }) as any
  const entries = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, any>) : [])
  return { dir, key, wrapper, sessionDir, log, input, entries }
}
type Fixture = ReturnType<typeof fixture>

/** Start the adapter on a prepared launch, with the fake server told what to do. The box is the identity: only the engine is scripted. */
async function begin(f: Fixture, scenario: Record<string, unknown> = {}, session?: { id: string; resume: boolean }, preset = PRESET, wrap: ((argv: string[]) => string[]) | undefined = argv => argv) {
  const launch = makeOpenCodeLaunch(f.input(preset), f.wrapper)
  const env = { ...launch.env, FAKE_OPENCODE: JSON.stringify(scenario), FAKE_LOG: f.log }
  const started = await adapter.start({ preset, sessionId: null, ...(session ? { session } : {}), cwd: launch.cwd, argv: launch.argv, env,
    credentialId: launch.credentialId, wrap })
  open.push(started)
  return started
}

/** One turn: what was acknowledged, what was said as progress, and how it ended. */
async function turn(session: AdapterSession, text: string, id = "message-1") {
  const receipts: string[] = []
  const progress: AdapterProgress[] = []
  session.onReceipt(one => receipts.push(one))
  session.onProgress(one => progress.push(one))
  const ended = new Promise<TurnEnd>((resolve, reject) => {
    session.onTurnEnd(resolve)
    setTimeout(() => reject(new Error("the turn did not end")), 10_000)
  })
  await session.feed({ id, text })
  return { receipts, progress, end: await ended }
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

test("a turn: one prompt, the engine's echo is the receipt, progress is streamed, the answer is read from the engine's record, usage is the engine's", async () => {
  const f = fixture()
  const session = await begin(f, { tool: true, answer: "Привет, мир" }, { id: "hub-session-1", resume: false })
  expect(session.sessionId).toBe("hub-session-1")
  expect(session.reportedSessionId).toBe("hub-session-1")
  expect(session.pid).toBeGreaterThan(0)
  expect(session.lacks).toEqual([])
  const done = await turn(session, "hello from the household")
  expect(done.receipts).toEqual(["message-1"])
  expect(done.progress.map(one => one.kind)).toEqual(["action", "action_result", "text", "text"])
  expect(done.progress[0].text).toBe("bash")
  expect(done.progress.filter(one => one.kind === "text").map(one => one.text).join("")).toBe("Привет, мир")
  // Only the fact that a tool answered is passed on, never what it said.
  expect(JSON.stringify(done.progress)).not.toContain("TOOL-OUTPUT-SENTINEL")
  expect(done.end.refused).toBeNull()
  expect(done.end.text).toBe("Привет, мир")
  expect(done.end.session_id).toBe("hub-session-1")
  expect(done.end.usage).toMatchObject({ input_tokens: 100, cached_input_tokens: 10, output_tokens: 20, plan_usage: null, window: null,
    resolved_model_ids: ["synthetic-model"], primary_model_id: "synthetic-model" })
  expect(done.end.usage.raw).toMatchObject({ engine: "opencode", engine_session: "ses_1", providers: ["synthetic-provider"],
    evidence: { kind: "authenticated-response", status: 200, credential: "provider-key" } })

  // The engine was handed exactly one prompt, authenticated, on the bound model, as the agent that has no delegation.
  const prompts = f.entries().filter(one => one.at === "prompt")
  expect(prompts).toHaveLength(1)
  expect(prompts[0]).toMatchObject({ session: "ses_1", authenticated: true,
    body: { parts: [{ type: "text", text: "hello from the household" }], model: { providerID: "synthetic-provider", modelID: "synthetic-model" }, agent: "build" } })
  // The prompt carries the hub's own message id, in the engine's own id shape, and the default effort sends no variant at all.
  expect(prompts[0].body.messageID).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  expect("variant" in prompts[0].body).toBe(false)
  expect(done.end.usage.raw.variant).toBeNull()
  // The hub's id for the conversation is mapped to the engine's, on this machine, with the identity it is bound to.
  const map = JSON.parse(readFileSync(join(f.sessionDir, "opencode", "hub-session.json"), "utf8"))
  expect(map.sessions["hub-session-1"]).toMatchObject({ engine_session: "ses_1", identity: { adapter: "opencode", provider: "synthetic-provider", model: "synthetic-model", endpoint: null } })
  // The key is in the child's environment only: not in what the engine was sent, not in the map, not in the log.
  expect(JSON.stringify(f.entries())).not.toContain(f.key)
  expect(JSON.stringify(map)).not.toContain(f.key)
  await session.close()
  expect(alive(session.pid!)).toBe(false)
  await expect(session.feed({ id: "later", text: "x" })).rejects.toBeInstanceOf(FeedNotWritten)
}, 30_000)

test("a session with no hub id is made and is not mapped, and reports none", async () => {
  const f = fixture()
  const session = await begin(f, {})
  expect(session.sessionId).toBeNull()
  expect(session.reportedSessionId).toBeNull()
  const done = await turn(session, "hello")
  expect(done.end.session_id).toBeNull()
  expect(existsSync(join(f.sessionDir, "opencode", "hub-session.json"))).toBe(false)
  await session.close()
}, 30_000)

test("a server that does not hold the restrictions asked for is not started on, and its process is gone", async () => {
  const f = fixture()
  await expect(begin(f, { weak: true }, { id: "hub-weak", resume: false })).rejects.toThrow("opencode-config-unverified: config-permission-differs: task")
  const started = f.entries().find(one => one.at === "start")!
  expect(started).toBeDefined()
  await Bun.sleep(100)
  expect(alive(started.pid)).toBe(false)
  // Nothing was made or mapped, and nothing was sent.
  expect(f.entries().some(one => one.at === "session.create" || one.at === "prompt")).toBe(false)
  expect(existsSync(join(f.sessionDir, "opencode", "hub-session.json"))).toBe(false)
}, 30_000)

test("a provider that is not connected, and a server that does not ask for the password, are refused by name", async () => {
  const f = fixture()
  await expect(begin(f, { disconnected: true })).rejects.toThrow("opencode-provider-not-connected")
  const g = fixture()
  await expect(begin(g, { noauth: true })).rejects.toThrow("opencode-server-unauthenticated")
  await Bun.sleep(100)
  expect(alive(g.entries().find(one => one.at === "start")!.pid)).toBe(false)
}, 30_000)

test("a launch the adapter was not prepared for is refused before any process", async () => {
  const f = fixture()
  const launch = makeOpenCodeLaunch(f.input(), f.wrapper)
  const base = { preset: PRESET, sessionId: null, cwd: launch.cwd, argv: launch.argv, env: { ...launch.env, FAKE_LOG: f.log } }
  await expect(adapter.start({ ...base, argv: undefined, wrap: a => a })).rejects.toThrow("opencode-launch-required")
  await expect(adapter.start({ ...base, env: { ...base.env, [OPENCODE_CONFIG_ENV]: undefined }, wrap: a => a })).rejects.toThrow("opencode-launch-required")
  // A shell and a write tool are not started outside a box.
  await expect(adapter.start({ ...base })).rejects.toThrow("box-required")
  // The launch was for another model than the preset says.
  await expect(adapter.start({ ...base, preset: { ...PRESET, model: "another-model" }, wrap: a => a })).rejects.toThrow("opencode-identity-mismatch")
  await expect(adapter.start({ ...base, sessionId: "ses_engine", wrap: a => a })).rejects.toThrow("opencode-session-unsupported")
  expect(f.entries()).toEqual([])
})

test("a session resumes by the hub's id, and is never replaced: unknown, existing and re-bound ids are refused", async () => {
  const f = fixture()
  const first = await begin(f, {}, { id: "hub-resume", resume: false })
  expect((await turn(first, "one")).end.refused).toBeNull()
  await first.close()

  // The same id, resumed, finds the engine's own session in the engine's own store.
  const second = await begin(f, {}, { id: "hub-resume", resume: true })
  expect(second.sessionId).toBe("hub-resume")
  expect(second.reportedSessionId).toBe("hub-resume")
  const done = await turn(second, "two")
  expect(done.end.refused).toBeNull()
  expect(done.end.usage.raw.engine_session).toBe("ses_1")
  expect(f.entries().filter(one => one.at === "session.create")).toHaveLength(1)
  await second.close()

  const starts = () => f.entries().filter(one => one.at === "start").length
  const before = starts()
  // An id this machine's map does not hold is not resumed and not replaced by a fresh session.
  await expect(begin(f, {}, { id: "hub-other", resume: true })).rejects.toThrow("opencode-session-unknown")
  // An id the engine already has is not launched as new again.
  await expect(begin(f, {}, { id: "hub-resume", resume: false })).rejects.toThrow("opencode-session-exists")
  // The same conversation under another model is another identity, and the owner decides what becomes of it.
  await expect(begin(f, {}, { id: "hub-resume", resume: true }, { ...PRESET, model: "another-model" })).rejects.toThrow("opencode-identity-mismatch")
  await expect(begin(f, {}, { id: "hub-resume", resume: true }, { ...PRESET, provider: "another-provider" })).rejects.toThrow("opencode-identity-mismatch")
  // None of those started a process.
  expect(starts()).toBe(before)

  // A map entry whose session the engine no longer has is refused by name, and nothing is created in its place.
  const sessions = join(f.sessionDir, "opencode", "data", "fake-sessions.json")
  writeFileSync(sessions, "[]")
  await expect(begin(f, {}, { id: "hub-resume", resume: true })).rejects.toThrow("opencode-session-missing")
  expect(f.entries().filter(one => one.at === "session.create")).toHaveLength(1)
  // A damaged map is not read as empty.
  writeFileSync(join(f.sessionDir, "opencode", "hub-session.json"), "{not json")
  await expect(begin(f, {}, { id: "hub-resume", resume: true })).rejects.toThrow("opencode-session-map-unreadable")
}, 60_000)

test("a refusal is typed, empty of text, and carries evidence only when the provider itself answered 401", async () => {
  const login = await (async () => {
    const f = fixture()
    const session = await begin(f, { error: { name: "APIError", data: { message: "Incorrect API key", statusCode: 401 } } })
    const done = await turn(session, "hello")
    await session.close()
    return done
  })()
  expect(login.end.refused).toEqual({ cause: "login", said: "Incorrect API key" })
  expect(login.end.text).toBe("")
  expect(login.end.usage.raw.evidence).toEqual({ kind: "authenticated-response", status: 401, credential: "provider-key" })
  expect(login.receipts).toEqual(["message-1"])

  const f = fixture()
  const throttled = await begin(f, { error: { name: "APIError", data: { message: "Rate limit reached", statusCode: 429 } } })
  const done = await turn(throttled, "hello")
  expect(done.end.refused).toEqual({ cause: "window", said: "Rate limit reached" })
  expect(done.end.usage.raw.evidence).toBeNull()
  await throttled.close()

  // A key the engine itself could not find is a login refusal with no proof the provider was reached.
  const g = fixture()
  const missing = await begin(g, { error: { name: "ProviderAuthError", data: { message: "no key" } } })
  const none = await turn(missing, "hello")
  expect(none.end.refused).toEqual({ cause: "login", said: "no key" })
  expect(none.end.usage.raw.evidence).toBeNull()
  await missing.close()
}, 60_000)

test("an answer from another model than the bound one is refused and its text is never posted", async () => {
  const f = fixture()
  const session = await begin(f, { model: "a-cheaper-model", answer: "this must not be posted" })
  const done = await turn(session, "hello")
  expect(done.end.text).toBe("")
  expect(done.end.refused?.cause).toBe("other")
  expect(done.end.refused?.said).toContain("a-cheaper-model")
  expect(done.end.refused?.said).toContain("synthetic-provider/synthetic-model")
  await session.close()
}, 30_000)

test("a preset's effort is sent as the engine's own variant of that name, or the start is refused: it is never dropped", async () => {
  const high = { ...PRESET, effort: "high" }
  const f = fixture()
  const session = await begin(f, { variants: { low: {}, high: {} } }, { id: "hub-effort", resume: false }, high)
  const done = await turn(session, "think hard")
  expect(done.end.refused).toBeNull()
  expect(done.end.text).toBe("Hello world")
  expect(done.end.usage.raw.variant).toBe("high")
  const prompts = f.entries().filter(one => one.at === "prompt")
  expect(prompts).toHaveLength(1)
  expect(prompts[0].body.variant).toBe("high")
  await session.close()

  // An effort the model does not list is refused by name, naming the variants the engine does list, before a session is made.
  const g = fixture()
  await expect(begin(g, { variants: { low: {}, high: {} } }, { id: "hub-ultra", resume: false }, { ...PRESET, effort: "ultra" }))
    .rejects.toThrow("opencode-effort-unsupported: ultra (this model's variants: high, low)")
  await expect(begin(g, {}, { id: "hub-ultra", resume: false }, high)).rejects.toThrow("opencode-effort-unsupported: high (this model's variants: none)")
  // A model the engine does not list cannot have a variant checked.
  await expect(begin(g, { unknownModel: true }, { id: "hub-ultra", resume: false }, high)).rejects.toThrow("not in the engine's catalogue")
  for (const entry of g.entries().filter(one => one.at === "start")) {
    await Bun.sleep(100)
    expect(alive(entry.pid)).toBe(false)
  }
  expect(g.entries().some(one => one.at === "session.create" || one.at === "prompt")).toBe(false)
  expect(existsSync(join(g.sessionDir, "opencode", "hub-session.json"))).toBe(false)
  // The default effort needs no variant and no catalogue entry.
  const h = fixture()
  const plain = await begin(h, { unknownModel: true }, { id: "hub-default", resume: false })
  await plain.close()
  // An effort the preset does not name at all is not guessed.
  await expect(begin(fixture(), {}, undefined, { ...PRESET, effort: "" })).rejects.toThrow("opencode-effort-unsupported")

  // A variant the engine recorded as another than the one asked for is a different effort: refused, and its text is not posted.
  const k = fixture()
  const wrong = await begin(k, { variants: { low: {}, high: {} }, wrongVariant: "low", answer: "this must not be posted" }, undefined, high)
  const refused = await turn(wrong, "hello")
  expect(refused.end.text).toBe("")
  expect(refused.end.refused?.cause).toBe("other")
  expect(refused.end.refused?.said).toBe("opencode recorded the variant low and the preset's effort is high")
  await wrong.close()
}, 90_000)

test("the receipt is the echo of the id the hub chose: an engine that keeps another id gives none and the turn is refused", async () => {
  const f = fixture()
  const session = await begin(f, { idNotKept: true, answer: "this must not be posted" })
  const done = await turn(session, "hello")
  expect(done.receipts).toEqual([])
  expect(done.end.text).toBe("")
  expect(done.end.refused?.cause).toBe("other")
  expect(done.end.refused?.said).toContain("another message id")
  expect(f.entries().filter(entry => entry.at === "abort")).toHaveLength(1)
  expect(f.entries().filter(entry => entry.at === "prompt")).toHaveLength(1)
  await session.close()
}, 30_000)

test("a permission request, a question and a child session each stop the turn as a refusal, and the engine is told to abort", async () => {
  const asked = fixture()
  const one = await begin(asked, { permission: true })
  const first = await turn(one, "hello")
  expect(first.end.refused?.cause).toBe("other")
  expect(first.end.refused?.said).toContain("permission the hub never grants: bash")
  expect(asked.entries().filter(entry => entry.at === "abort")).toHaveLength(1)
  await one.close()

  const questioned = fixture()
  const ask = await begin(questioned, { question: true })
  const inquiry = await turn(ask, "hello")
  expect(inquiry.end.refused?.said).toContain("permission the hub never grants: question")
  expect(questioned.entries().filter(entry => entry.at === "abort")).toHaveLength(1)
  await ask.close()

  const spawned = fixture()
  const two = await begin(spawned, { foreign: true })
  const second = await turn(two, "hello")
  expect(second.end.refused?.cause).toBe("other")
  expect(second.end.refused?.said).toContain("native delegation observed")
  expect(spawned.entries().filter(entry => entry.at === "abort")).toHaveLength(1)
  await two.close()
}, 60_000)

test("a lost connection never posts again: the post is uncertain, the session is exited, and a later feed is not-written", async () => {
  const f = fixture()
  const session = await begin(f, { crashOnPrompt: true }, { id: "hub-crash", resume: false })
  const rejection = await session.feed({ id: "message-1", text: "hello" }).then(() => null, (error: unknown) => error)
  // The engine had the post when it died: that is NOT "nothing was written".
  expect(rejection).toBeInstanceOf(Error)
  expect(rejection).not.toBeInstanceOf(FeedNotWritten)
  const cause = await Promise.race([session.exited, Bun.sleep(5000).then(() => "timeout")]) as { cause?: string }
  expect(cause.cause).toBeDefined()
  await Bun.sleep(100)
  // A feed after that is the only kind that says nothing was written, and nothing is re-posted.
  await expect(session.feed({ id: "message-2", text: "again" })).rejects.toBeInstanceOf(FeedNotWritten)
  expect(f.entries().filter(one => one.at === "prompt")).toHaveLength(1)
}, 30_000)

test("an event stream that ends under a live server ends the session as exited, and nothing is posted", async () => {
  const f = fixture()
  const session = await begin(f, { cutEvents: true })
  const cause = await Promise.race([session.exited, Bun.sleep(5000).then(() => "timeout")]) as { cause?: string }
  expect(cause.cause).toBe("stream-ended")
  expect(f.entries().filter(one => one.at === "prompt")).toHaveLength(0)
  await session.close()
}, 30_000)

test("a second input while a turn is open is not written, and a stop asks the engine to abort, ends the tree and reports what is gone", async () => {
  const f = fixture()
  const session = await begin(f, { hang: true })
  const receipts: string[] = []
  const ends: TurnEnd[] = []
  session.onReceipt(one => receipts.push(one))
  session.onTurnEnd(one => ends.push(one))
  await session.feed({ id: "message-1", text: "a long task" })
  for (let waited = 0; receipts.length === 0 && waited < 100; waited++) await Bun.sleep(50)
  expect(receipts).toEqual(["message-1"])
  await expect(session.feed({ id: "message-2", text: "overlap" })).rejects.toBeInstanceOf(FeedNotWritten)
  expect(session.processes!()?.[0]).toBe(session.pid!)

  const evidence = await session.interrupt!({ graceMs: 2000 })
  expect(f.entries().filter(one => one.at === "abort")).toHaveLength(1)
  expect(evidence.leader).toBe("exited")
  expect(evidence.pids).toContain(session.pid!)
  expect(evidence.survivors).toEqual([])
  expect(alive(session.pid!)).toBe(false)
  // What the aborted turn ended with is nobody's any more: the stop is the runner's.
  await Bun.sleep(200)
  expect(ends).toEqual([])
  expect(f.entries().filter(one => one.at === "prompt")).toHaveLength(1)
  expect((await session.exitEvidence!()).leader).toBe("exited")
  await expect(session.feed({ id: "message-3", text: "after" })).rejects.toBeInstanceOf(FeedNotWritten)
}, 30_000)

test("the key is handed to the child in its environment and is in nothing the hub wrote", async () => {
  const f = fixture()
  const launch = makeOpenCodeLaunch(f.input(), f.wrapper)
  expect(launch.env[OPENCODE_KEY_ENV]).toBe(f.key)
  const session = await begin(f, {}, { id: "hub-key", resume: false })
  await turn(session, "hello")
  await session.close()
  const all = [f.log, join(f.sessionDir, "opencode", "hub-session.json"), join(f.sessionDir, "instructions.md")].filter(existsSync).map(file => readFileSync(file, "utf8")).join("\n")
  expect(all).not.toContain(f.key)
}, 30_000)


test("ordinary close cleans a surviving tool after the engine leader dies", async () => {
  const f = fixture();
  const session = await begin(f, { survivingTool: true });
  const pid = f.entries().find(one => one.at === "tool-process")!.pid as number;
  expect(alive(pid)).toBe(true);
  session.processes?.();
  process.kill(session.pid!, "SIGKILL");
  await session.exited;
  expect(alive(pid)).toBe(true);
  await Promise.all([session.close(), session.close()]);
  expect(alive(pid)).toBe(false);
}, 15000);
