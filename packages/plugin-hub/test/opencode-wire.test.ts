// How what OpenCode publishes is read: the event stream, a turn's state machine, the
// refusal a failure is typed as, the counts of a turn, the message id and the effort's variant.
//
// The event and message shapes below are those of the pinned v1.18.34 OpenAPI document
// (`message.part.updated` carries a part and no delta, `message.part.delta` is its own event,
// `permission.asked` names `permission`, a user message names its `model.variant`). The ORDER the
// events arrive in is not in that document: each order is tested, and a pass is not evidence of
// the real server's.

import { expect, test } from "bun:test"
import {
  TurnTracker, busEvents, effortRefusal, engineError, messageInfo, newMessageId, refusalOf, textOf, usageOf, variantsOf,
  type BusEvent, type TurnOutcome,
} from "../src/adapters/opencode-wire.ts"
import type { AdapterProgress } from "../src/adapters/types.ts"

const S = "ses_conversation"
const U = "msg_sent"

function harness() {
  const log: string[] = []
  const progress: AdapterProgress[] = []
  const outcomes: TurnOutcome[] = []
  const tracker = new TurnTracker(S, {
    receipt: () => log.push("receipt"),
    progress: event => { progress.push(event); log.push(`${event.kind}:${event.text}`) },
    ended: outcome => { outcomes.push(outcome); log.push("ended") },
  })
  const feed = (...events: BusEvent[]) => { for (const event of events) tracker.handle(event) }
  return { tracker, feed, log, progress, outcomes }
}

const message = (id: string, role: string, extra: Record<string, unknown> = {}, session = S): BusEvent =>
  ({ type: "message.updated", properties: { sessionID: session, info: { id, sessionID: session, role, ...extra } } })
const part = (messageID: string, extra: Record<string, unknown>, session = S): BusEvent =>
  ({ type: "message.part.updated", properties: { sessionID: session, part: { sessionID: session, messageID, ...extra }, time: 1 } })
const delta = (messageID: string, partID: string, text: string, field = "text", session = S): BusEvent =>
  ({ type: "message.part.delta", properties: { sessionID: session, messageID, partID, field, delta: text } })
const idle: BusEvent = { type: "session.idle", properties: { sessionID: S } }

test("a turn: the echo of the hub's id is the receipt, deltas and tools are progress, idle ends it", () => {
  const h = harness()
  h.tracker.begin("hello there", U)
  h.feed(
    message(U, "user", { model: { providerID: "provider-1", modelID: "model-1", variant: "high" } }),
    part(U, { id: "p0", type: "text", text: "hello there" }),
    message("m2", "assistant", { parentID: U, modelID: "model-1", providerID: "provider-1", tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } } }),
    part("m2", { id: "p1", type: "text", text: "" }),
    delta("m2", "p1", "Hi"),
    delta("m2", "p1", " there"),
    // The part's own text, after its deltas, adds nothing: the words were already said once.
    part("m2", { id: "p1", type: "text", text: "Hi there" }),
    // The reasoning streams under the same field name, and is not the answer.
    part("m2", { id: "p3", type: "reasoning", text: "" }),
    delta("m2", "p3", "hidden thoughts"),
    part("m2", { id: "p2", type: "tool", tool: "bash", callID: "c1", state: { status: "pending", input: {}, raw: "" } }),
    part("m2", { id: "p2", type: "tool", tool: "bash", callID: "c1", state: { status: "running", input: {}, time: { start: 1 } } }),
    part("m2", { id: "p2", type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: {}, output: "SECRET OUTPUT", title: "t", metadata: {}, time: { start: 1, end: 2 } } }),
    part("m2", { id: "p2", type: "tool", tool: "bash", callID: "c1", state: { status: "completed", input: {}, output: "SECRET OUTPUT", title: "t", metadata: {}, time: { start: 1, end: 2 } } }),
    idle,
    idle,
  )
  // One receipt, the tool announced once and reported back once, and the end said once.
  expect(h.log).toEqual(["receipt", "text:Hi", "text: there", "action:bash", "action_result:", "ended"])
  // A tool's output never leaves the adapter.
  expect(JSON.stringify(h.progress)).not.toContain("SECRET OUTPUT")
  expect(JSON.stringify(h.progress)).not.toContain("hidden thoughts")
  expect(h.outcomes).toHaveLength(1)
  expect(h.outcomes[0].messages.map(one => one.id)).toEqual(["m2"])
  expect(h.outcomes[0].streamed).toBe("Hi there")
  expect(h.outcomes[0].error).toBeNull()
  // What the engine recorded for the user message, including the variant it applied.
  expect(h.outcomes[0].echoed).toMatchObject({ id: U, providerID: "provider-1", modelID: "model-1", variant: "high" })
  expect(h.tracker.open).toBe(false)
})

test("a delta that comes before its part is named is kept and said once; a reasoning delta is never said", () => {
  const h = harness()
  h.tracker.begin("q", U)
  h.feed(message(U, "user"), message("a1", "assistant", { parentID: U }),
    delta("a1", "pt", "Hel"), delta("a1", "pr", "secret"),
    part("a1", { id: "pt", type: "text", text: "Hello" }),
    part("a1", { id: "pr", type: "reasoning", text: "secret" }),
    delta("a1", "pr", "more"), delta("a1", "pt", "!"),
    // A delta of a field that is not text (a tool's input) is not words.
    delta("a1", "pt", "NOT WORDS", "input"),
    part("a1", { id: "pt", type: "text", text: "Hello!" }))
  expect(h.progress).toEqual([{ kind: "text", text: "Hel" }, { kind: "text", text: "lo" }, { kind: "text", text: "!" }])
  h.feed(idle)
  expect(h.outcomes[0].streamed).toBe("Hello!")
})

test("a delta of the user's message, of another session or before any turn is never progress", () => {
  const h = harness()
  h.feed(delta("m0", "p", "old"))
  h.tracker.begin("q", U)
  h.feed(message(U, "user"), delta(U, "pu", "q"), delta("c1", "pc", "child", "text", "ses_child"))
  expect(h.progress).toEqual([])
  expect(h.outcomes).toEqual([])
})

test("an idle before the receipt is the last turn's and ends nothing", () => {
  const h = harness()
  h.tracker.begin("question", U)
  h.feed(idle, { type: "session.status", properties: { sessionID: S, status: { type: "idle" } } })
  expect(h.log).toEqual([])
  expect(h.tracker.open).toBe(true)
  // A retry or a busy status is not an end.
  h.feed({ type: "session.status", properties: { sessionID: S, status: { type: "retry", attempt: 1, message: "x", next: 1 } } })
  expect(h.tracker.open).toBe(true)
  h.feed(message(U, "user"), message("m2", "assistant", { parentID: U }), idle)
  expect(h.log).toEqual(["receipt", "ended"])
})

test("with the hub's id the receipt is that message and nothing else: another user message, or an answer to another, is not it", () => {
  const h = harness()
  h.tracker.begin("padded input", U)
  // The echo's text is not exactly what was sent, and it is still the receipt because it is the id the hub chose.
  h.feed(message("msg_other", "user"), message("m0", "assistant", { parentID: "msg_other" }))
  expect(h.log).toEqual([])
  h.feed(message(U, "user"), part(U, { id: "p0", type: "text", text: "padded input\n" }))
  expect(h.log).toEqual(["receipt"])
  // An answer to another user message is not this turn's.
  h.feed(part("m0", { id: "px", type: "text", text: "not ours" }), delta("m0", "px", "not ours"))
  h.feed(message("m1", "assistant", { parentID: U }), idle)
  expect(h.log).toEqual(["receipt", "ended"])
  expect(h.outcomes[0].messages.map(one => one.id)).toEqual(["m1"])
})

test("an assistant message that names the hub's id is a receipt even when the echo was missed", () => {
  const h = harness()
  h.tracker.begin("hello", U)
  h.feed(message("m1", "assistant", { parentID: "msg_older" }))
  expect(h.log).toEqual([])
  h.feed(message("m2", "assistant", { parentID: U }))
  expect(h.log).toEqual(["receipt"])
  h.feed(idle)
  expect(h.log).toEqual(["receipt", "ended"])
})

test("the prompt echoed under an id the hub did not choose is an error, never a receipt", () => {
  const h = harness()
  h.tracker.begin("hello", U)
  h.feed(message("msg_theirs", "user"), part("msg_theirs", { id: "p0", type: "text", text: "hello" }), idle)
  expect(h.log).toEqual(["ended"])
  expect(h.outcomes[0].error).toEqual({ name: "MessageIdNotKept", message: "the engine recorded the prompt under another message id than the one the hub chose", status: null })
  // The same words from an earlier turn (the very same user message updated late) are not that.
  const g = harness()
  g.tracker.begin("ok", "msg_1")
  g.feed(message("msg_1", "user"), message("a1", "assistant", { parentID: "msg_1" }), idle)
  g.tracker.begin("ok", "msg_2")
  g.feed(part("msg_1", { id: "p0", type: "text", text: "ok" }))
  expect(g.tracker.open).toBe(true)
  expect(g.log).toEqual(["receipt", "ended"])
})

test("without an id the receipt is the user message whose text is what was sent, or an assistant that begins", () => {
  const h = harness()
  h.tracker.begin("padded input")
  h.feed(message("m1", "user"), part("m1", { id: "p0", type: "text", text: "padded input\n" }))
  expect(h.log).toEqual([])
  h.feed(message("m2", "assistant"))
  expect(h.log).toEqual(["receipt"])
  h.feed(idle)
  expect(h.log).toEqual(["receipt", "ended"])

  const g = harness()
  g.tracker.begin("exact")
  g.feed(message("m1", "user"), part("m1", { id: "p0", type: "text", text: "exact" }))
  expect(g.log).toEqual(["receipt"])
})

test("a message the stream showed before the turn is never taken for this turn's", () => {
  const h = harness()
  h.tracker.begin("first", "msg_1")
  h.feed(message("msg_1", "user"), message("m2", "assistant", { parentID: "msg_1" }), idle)
  expect(h.log).toEqual(["receipt", "ended"])
  h.tracker.begin("second", "msg_3")
  // The previous user message is updated late (a summary landing), and an old assistant message too.
  h.feed(message("msg_1", "user", { summary: { diffs: [] } }), message("m2", "assistant", { parentID: "msg_1", time: { created: 1, completed: 2 } }),
    part("m2", { id: "p9", type: "text", text: "old" }), delta("m2", "p9", "old"))
  expect(h.log).toEqual(["receipt", "ended"])
  h.feed(message("msg_3", "user"), message("m4", "assistant", { parentID: "msg_3" }), idle)
  expect(h.log).toEqual(["receipt", "ended", "receipt", "ended"])
  expect(h.outcomes[1].messages.map(one => one.id)).toEqual(["m4"])
})

test("a session error ends the turn at once, with the engine's own words", () => {
  const h = harness()
  h.tracker.begin("question", U)
  h.feed({ type: "session.error", properties: { sessionID: S, error: { name: "APIError", data: { message: "bad key", statusCode: 401, isRetryable: false } } } }, idle)
  expect(h.log).toEqual(["ended"])
  expect(h.outcomes[0].error).toEqual({ name: "APIError", message: "bad key", status: 401 })
  // An error outside a turn, and one for another session, end nothing.
  h.feed({ type: "session.error", properties: { sessionID: S, error: { name: "UnknownError" } } })
  h.tracker.begin("again", "msg_again")
  h.feed({ type: "session.error", properties: { sessionID: "ses_other", error: { name: "UnknownError" } } })
  expect(h.tracker.open).toBe(true)
  // The spec leaves `sessionID` optional on this event: one without it is the turn's.
  h.feed({ type: "session.error", properties: { error: { name: "ContentFilterError", data: { message: "filtered" } } } })
  expect(h.tracker.open).toBe(false)
  expect(h.outcomes[1].error).toEqual({ name: "ContentFilterError", message: "filtered", status: null })
})

test("a permission request or a question ends the turn as one, and a child session is remembered as delegation", () => {
  const asked = harness()
  asked.tracker.begin("question", U)
  asked.feed({ type: "permission.asked", properties: { id: "per_1", sessionID: S, permission: "bash", patterns: ["ls"] } })
  expect(asked.outcomes[0].permission).toBe("bash")

  const v2 = harness()
  v2.tracker.begin("question", U)
  v2.feed({ type: "permission.v2.asked", properties: { id: "per_2", sessionID: S, action: "edit" } })
  expect(v2.outcomes[0].permission).toBe("edit")

  for (const type of ["question.asked", "question.v2.asked"]) {
    const questioned = harness()
    questioned.tracker.begin("question", U)
    // Another session's question is not this turn's.
    questioned.feed({ type, properties: { id: "que_1", sessionID: "ses_other", questions: [] } })
    expect(questioned.tracker.open).toBe(true)
    questioned.feed({ type, properties: { id: "que_1", sessionID: S, questions: [] } })
    expect(questioned.outcomes[0].permission).toBe("question")
  }

  const child = harness()
  child.tracker.begin("question", U)
  child.feed(message(U, "user"), message("m2", "assistant", { parentID: U }),
    { type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: S } } },
    message("c1", "assistant", {}, "ses_child"), part("c1", { id: "cp", type: "text", text: "hi" }, "ses_child"), delta("c1", "cp", "hi", "text", "ses_child"), idle)
  expect(child.outcomes[0].foreign).toEqual(["ses_child"])
  // What the other session said is nobody's text here.
  expect(child.log.filter(one => one.startsWith("text:"))).toEqual([])
})

test("text with no delta event is read as the part of it that is new, and a user's part is never progress", () => {
  const h = harness()
  h.tracker.begin("q", U)
  h.feed(message(U, "user"), part(U, { id: "u", type: "text", text: "q" }), message("m2", "assistant", { parentID: U }),
    part("m2", { id: "p1", type: "text", text: "abc" }), part("m2", { id: "p1", type: "text", text: "abcdef" }), part("m2", { id: "p1", type: "reasoning", text: "hidden" }))
  expect(h.progress).toEqual([{ kind: "text", text: "abc" }, { kind: "text", text: "def" }])
  // A snapshot that is behind the deltas adds nothing, and one that disagrees with them replaces them without being said again.
  const g = harness()
  g.tracker.begin("q", U)
  g.feed(message(U, "user"), message("m2", "assistant", { parentID: U }), part("m2", { id: "p1", type: "text", text: "" }),
    delta("m2", "p1", "abc"), part("m2", { id: "p1", type: "text", text: "ab" }), part("m2", { id: "p1", type: "text", text: "xyz" }))
  expect(g.progress).toEqual([{ kind: "text", text: "abc" }])
  g.feed(idle)
  expect(g.outcomes[0].streamed).toBe("xyz")
})

test("events of a session with no turn open, or of a kind nobody knows, change nothing", () => {
  const h = harness()
  h.feed(message("m1", "user"), part("m1", { id: "p", type: "text", text: "x" }), delta("m1", "p", "x"), idle,
    { type: "something.else", properties: {} }, { type: "server.connected" }, { type: "session.next.text.delta", properties: { sessionID: S, assistantMessageID: "msg_a", textID: "t", delta: "x" } })
  expect(h.log).toEqual([])
  expect(h.outcomes).toEqual([])
  // The newer `session.next.*` family is not read even inside a turn: it would say every word twice if both were.
  h.tracker.begin("q", U)
  h.feed({ type: "session.next.text.delta", properties: { sessionID: S, assistantMessageID: "msg_a", textID: "t", delta: "x" } },
    { type: "session.next.prompted", properties: { sessionID: S, messageID: U, prompt: {}, delivery: "queue" } })
  expect(h.log).toEqual([])
  expect(h.tracker.open).toBe(true)
})

test("the stream is read in pieces, across chunk edges, comments, CRLF and a block that is not JSON", async () => {
  const text = ": hello\r\n\r\ndata: {\"type\":\"server.connected\",\"properties\":{}}\r\n\r\n" +
    "data: not json\n\n" +
    "event: x\ndata: {\"type\":\"session.idle\",\ndata: \"properties\":{\"sessionID\":\"a\"}}\n\n" +
    "data:{\"type\":\"last\"}\n\n"
  const bytes = new TextEncoder().encode(text)
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7))
    controller.close()
  } })
  const seen: string[] = []
  for await (const event of busEvents(new Response(body))) seen.push(event.type)
  expect(seen).toEqual(["server.connected", "session.idle", "last"])
})

test("a failure is typed so the runner branches on no engine's name", () => {
  expect(refusalOf({ name: "ProviderAuthError", message: "no key", status: null })).toEqual({ cause: "login", said: "no key" })
  expect(refusalOf({ name: "APIError", message: "unauthorized", status: 401 }).cause).toBe("login")
  expect(refusalOf({ name: "APIError", message: "slow down", status: 429 }).cause).toBe("window")
  expect(refusalOf({ name: "APIError", message: "You exceeded your current quota", status: 400 }).cause).toBe("window")
  expect(refusalOf({ name: "APIError", message: "insufficient balance", status: 402 }).cause).toBe("window")
  expect(refusalOf({ name: "APIError", message: "bad gateway", status: 502 }).cause).toBe("other")
  expect(refusalOf({ name: "MessageOutputLengthError", message: "too long", status: null }).cause).toBe("other")
  expect(refusalOf({ name: "ContextOverflowError", message: "too many tokens", status: null }).cause).toBe("other")
  expect(engineError({ name: "APIError", data: { message: "m", statusCode: 503 } })).toEqual({ name: "APIError", message: "m", status: 503 })
  expect(engineError({ name: "X" })).toEqual({ name: "X", message: "X", status: null })
  expect(engineError("nope")).toBeNull()
})

test("the counts of a turn are summed, and one that was not reported stays unknown", () => {
  const info = (tokens: unknown) => messageInfo({ id: "m", role: "assistant", modelID: "x", providerID: "p", tokens })!
  const a = info({ input: 10, output: 5, reasoning: 0, cache: { read: 2, write: 0 } })
  const b = info({ input: 20, output: 7, reasoning: 0, cache: { read: 4, write: 0 } })
  expect(usageOf([a, b])).toEqual({ input: 30, cached: 6, output: 12 })
  // One message without a cache count makes the cache total unknown and leaves the others.
  expect(usageOf([a, info({ input: 1, output: 1 })])).toEqual({ input: 11, cached: null, output: 6 })
  // Zero in and zero out is a provider that reported nothing, never a free turn.
  expect(usageOf([info({ input: 0, output: 0, cache: { read: 0 } })])).toEqual({ input: null, cached: null, output: null })
  expect(usageOf([])).toEqual({ input: null, cached: null, output: null })
  expect(usageOf([info(undefined)])).toEqual({ input: null, cached: null, output: null })
  expect(messageInfo({ role: "assistant" })).toBeNull()
})

test("a message's info is read the way the spec's two message kinds spell it", () => {
  expect(messageInfo({ id: "msg_a", sessionID: S, role: "assistant", parentID: "msg_u", providerID: "p", modelID: "m", variant: "high", mode: "build", agent: "build" }))
    .toMatchObject({ id: "msg_a", role: "assistant", parentID: "msg_u", providerID: "p", modelID: "m", variant: "high", error: null })
  // A user message names its model, and its variant, under `model`; it has no parent.
  expect(messageInfo({ id: "msg_u", sessionID: S, role: "user", agent: "build", model: { providerID: "p", modelID: "m", variant: "low" } }))
    .toMatchObject({ id: "msg_u", role: "user", parentID: null, providerID: "p", modelID: "m", variant: "low" })
  expect(messageInfo({ id: "msg_u", role: "user", model: { providerID: "p", modelID: "m" } })?.variant).toBeNull()
  expect(messageInfo({ id: "msg_a", role: "assistant", error: { name: "ContentFilterError", data: { message: "no" } } })?.error).toEqual({ name: "ContentFilterError", message: "no", status: null })
})

test("the text of a message is its text parts, without the engine's own insertions", () => {
  expect(textOf([
    { type: "text", text: "one " }, { type: "reasoning", text: "hidden" }, { type: "tool", text: "x" },
    { type: "text", text: "synthetic", synthetic: true }, { type: "text", text: "ignored", ignored: true }, { type: "text", text: "two" },
  ])).toBe("one two")
  expect(textOf(undefined)).toBe("")
  expect(textOf([null, 3])).toBe("")
})

test("a message id is the engine's own shape and rises with the clock and within a millisecond", () => {
  const shape = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
  const ids = [newMessageId(1_700_000_000_000), newMessageId(1_700_000_000_000), newMessageId(1_700_000_000_000), newMessageId(1_700_000_000_001), newMessageId(1_700_000_005_000)]
  for (const id of ids) expect(id).toMatch(shape)
  // Compared by the hex clock only: the random tail is not an order.
  const clocks = ids.map(id => id.slice(4, 16))
  expect([...clocks].sort()).toEqual(clocks)
  expect(new Set(clocks).size).toBe(clocks.length)
  expect(newMessageId()).not.toBe(newMessageId())
})

test("an effort is a variant of the same name that the engine lists for the model, and otherwise it is refused by name", () => {
  const providers = { connected: ["p"], default: {}, all: [
    { id: "other", models: { m: { id: "m", variants: { zzz: {} } } } },
    { id: "p", models: { m: { id: "m", variants: { low: {}, high: { reasoningEffort: "high" } } }, plain: { id: "plain" }, empty: { id: "empty", variants: {} } } },
  ] }
  expect(variantsOf(providers, "p", "m")).toEqual(["high", "low"])
  // A model that lists none is not a model the engine does not know.
  expect(variantsOf(providers, "p", "plain")).toEqual([])
  expect(variantsOf(providers, "p", "empty")).toEqual([])
  expect(variantsOf(providers, "p", "missing")).toBeNull()
  expect(variantsOf(providers, "missing", "m")).toBeNull()
  expect(variantsOf({ all: "nope" }, "p", "m")).toBeNull()
  expect(variantsOf(null, "p", "m")).toBeNull()

  expect(effortRefusal("default", [])).toBeNull()
  expect(effortRefusal("default", null)).toBeNull()
  expect(effortRefusal("high", ["high", "low"])).toBeNull()
  expect(effortRefusal("medium", ["high", "low"])).toBe("opencode-effort-unsupported: medium (this model's variants: high, low)")
  expect(effortRefusal("high", [])).toBe("opencode-effort-unsupported: high (this model's variants: none)")
  expect(effortRefusal("high", null)).toContain("not in the engine's catalogue")
})

// Pinned source: compaction.ts create/process, prompt.ts runLoop (v1.18.34).
// The engine creates a compaction user, a summary assistant, then either a marked
// synthetic user or an overflow replay with new ids and the original text parts.
function compactTurn(h: ReturnType<typeof harness>, overflow = false, suffix = "") {
  const c = `compact${suffix}`, a = `summary${suffix}`
  h.feed(message(c, "user"), part(c, { id: `pc${suffix}`, type: "compaction", auto: true, overflow }),
    message(a, "assistant", { parentID: c, summary: true, mode: "compaction" }),
    part(a, { id: `ps${suffix}`, type: "text", text: "PRIVATE SUMMARY" }),
    message(a, "assistant", { parentID: c, summary: true, finish: "stop" }))
}

for (const overflow of [false, true]) test(`compaction follows ${overflow ? "overflow replay" : "marked continuation"} without a second receipt`, () => {
  const h = harness()
  h.tracker.begin("question", U)
  h.feed(message(U, "user"), part(U, { type: "text", text: "question" }),
    message("fragment", "assistant", { parentID: U }), part("fragment", { id: "pf", type: "text", text: "unfinished" }))
  compactTurn(h, overflow)
  const followup = { id: "pc", type: "text", text: overflow ? "question" : "Continue if you have next steps, or stop and ask for clarification if you are unsure how to proceed.",
    ...(overflow ? {} : { synthetic: true, metadata: { compaction_continue: true } }) }
  h.feed(message("continue", "user"), part("continue", followup), part("continue", followup),
    message("unrelated", "assistant", { parentID: "foreign-user" }), part("unrelated", { id: "px", type: "text", text: "foreign answer" }),
    message("answer", "assistant", { parentID: "continue" }), part("answer", { id: "pa", type: "text", text: "complete answer" }), idle)
  expect(h.log.filter(x => x === "receipt")).toHaveLength(1)
  expect(h.outcomes[0].error).toBeNull()
  expect(h.outcomes[0].answerIds).toEqual(["answer"])
  expect(h.outcomes[0].messages.map(x => x.id)).toEqual(["fragment", "summary", "answer"])
  expect(h.outcomes[0].streamed).toBe("complete answer")
  expect(JSON.stringify(h.progress)).not.toContain("PRIVATE SUMMARY")
  expect(JSON.stringify(h.progress)).not.toContain("foreign answer")
})

test("summary-only idle refuses instead of settling the fragment or summary", () => {
  const h = harness()
  h.tracker.begin("q", U)
  h.feed(message(U, "user"), message("fragment", "assistant", { parentID: U }), part("fragment", { id: "pf", type: "text", text: "unfinished" }))
  compactTurn(h)
  h.feed(idle)
  expect(h.outcomes[0].error?.name).toBe("CompactionIncomplete")
  expect(h.outcomes[0].streamed).toBe("")
  expect(h.outcomes[0].answerIds).toEqual([])
})

test("an intervening unrelated user breaks the compaction lineage", () => {
  const h = harness()
  h.tracker.begin("q", U)
  h.feed(message(U, "user"), message("foreign", "user"))
  compactTurn(h)
  h.feed(message("continue", "user"), part("continue", { type: "text", synthetic: true, metadata: { compaction_continue: true }, text: "continue" }),
    message("answer", "assistant", { parentID: "continue" }), idle)
  expect(h.outcomes[0].messages).toEqual([])
})

test("a failed compaction summary carries its error and never its text", () => {
  const h = harness()
  h.tracker.begin("q", U)
  h.feed(message(U, "user"))
  compactTurn(h)
  h.feed(message("summary", "assistant", { parentID: "compact", summary: true, finish: "error", error: { name: "ContextOverflowError", data: { message: "too large" } } }), idle)
  expect(h.outcomes[0].error?.name).toBe("ContextOverflowError")
  expect(h.outcomes[0].streamed).toBe("")
})

test("repeated compactions keep accounting and only the latest continuation is an answer", () => {
  const h = harness()
  h.tracker.begin("q", U)
  h.feed(message(U, "user"), part(U, { type: "text", text: "q" }))
  for (const suffix of ["1", "2"]) {
    compactTurn(h, false, suffix)
    h.feed(message(`continue${suffix}`, "user"), part(`continue${suffix}`, { type: "text", text: "continue", synthetic: true, metadata: { compaction_continue: true } }),
      message(`answer${suffix}`, "assistant", { parentID: `continue${suffix}` }), part(`answer${suffix}`, { id: `pa${suffix}`, type: "text", text: `answer ${suffix}` }))
  }
  h.feed(idle)
  expect(h.outcomes[0].error).toBeNull()
  expect(h.outcomes[0].answerIds).toEqual(["answer2"])
  expect(h.outcomes[0].streamed).toBe("answer 2")
  expect(h.outcomes[0].messages).toHaveLength(4)
})

test("unmarked repeated prompt after ordinary compaction still refuses an id change", () => {
  const h = harness()
  h.tracker.begin("q", U)
  h.feed(message(U, "user"), part(U, { type: "text", text: "q" }))
  compactTurn(h)
  h.feed(message("unmarked", "user"), part("unmarked", { type: "text", text: "q" }))
  expect(h.outcomes[0].error?.name).toBe("MessageIdNotKept")
})

test("context overflow without a verified continuation remains a refusal at idle", () => {
  const h = harness()
  h.tracker.begin("q", U)
  h.feed(message(U, "user"), { type: "session.error", properties: { sessionID: S, error: { name: "ContextOverflowError", data: { message: "overflow" } } } })
  expect(h.tracker.open).toBe(true)
  h.feed(idle)
  expect(h.outcomes[0].error?.name).toBe("ContextOverflowError")
})
