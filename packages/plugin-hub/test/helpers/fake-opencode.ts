// Test infrastructure only: a stand-in for `opencode serve`, run as the engine's binary.
//
// It speaks the part of the server's HTTP and event API that the adapter uses, in the event and
// message shapes of the pinned v1.18.34 OpenAPI document (`message.part.updated` with no delta,
// `message.part.delta` as its own event, `permission.asked` naming `permission`, a user message's
// `model.variant`), and it behaves as `FAKE_OPENCODE` (a JSON scenario) says. It is NOT a model of
// the real engine: the ORDER it publishes events in, and what the real server does with a prompt
// that has a caller's `messageID` or a `variant`, are exactly what the spec does not say and this
// script only chooses.
//
// What it records goes to `FAKE_LOG`, one JSON object per line, so a test can read back what
// the adapter really sent (a prompt, how many times, with which auth) and when the server ran.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const args = process.argv.slice(2)
if (args[0] === "--version") { console.log("opencode 9.9.9"); process.exit(0) }

const scenario = JSON.parse(process.env.FAKE_OPENCODE ?? "{}") as Record<string, any>
const logFile = process.env.FAKE_LOG!
const log = (entry: Record<string, unknown>) => appendFileSync(logFile, JSON.stringify(entry) + "\n")
if (scenario.survivingTool) {
  const tool = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  log({ at: "tool-process", pid: tool.pid });
}
const port = Number(args[args.indexOf("--port") + 1])
const config = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? "{}") as Record<string, any>
const [provider, ...rest] = String(config.model ?? "").split("/")
const model = rest.join("/")
const password = process.env.OPENCODE_SERVER_PASSWORD ?? ""
const expectedAuth = "Basic " + Buffer.from(`opencode:${password}`).toString("base64")

// Sessions outlive the process, in the data directory it was given, as a real engine's do.
const store = join(process.env.XDG_DATA_HOME ?? ".", "fake-sessions.json")
const sessions: string[] = existsSync(store) ? JSON.parse(readFileSync(store, "utf8")) : []
const save = () => { mkdirSync(dirname(store), { recursive: true }); writeFileSync(store, JSON.stringify(sessions)) }

const messages = new Map<string, { info: Record<string, unknown>; parts: Record<string, unknown>[] }>()
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>()
const encoder = new TextEncoder()
const emit = (event: Record<string, unknown>) => {
  for (const client of clients) { try { client.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) } catch { clients.delete(client) } }
}
let turns = 0
let hanging: string | null = null

const info = (id: string, session: string, role: string, extra: Record<string, unknown> = {}) => ({ id, sessionID: session, role, ...extra })
const infoEvent = (value: Record<string, unknown>) => emit({ type: "message.updated", properties: { sessionID: value.sessionID, info: value } })
const partEvent = (value: Record<string, unknown>) => emit({ type: "message.part.updated", properties: { sessionID: value.sessionID, part: value, time: Date.now() } })
const deltaEvent = (part: Record<string, unknown>, delta: string, field = "text") =>
  emit({ type: "message.part.delta", properties: { sessionID: part.sessionID, messageID: part.messageID, partID: part.id, field, delta } })
const idle = (session: string) => emit({ type: "session.idle", properties: { sessionID: session } })

async function turn(session: string, text: string, id: string | undefined, variant: string | undefined) {
  const n = ++turns
  // `idNotKept` is an engine that records the prompt under an id of its own, whatever the caller chose.
  const user = scenario.idNotKept || id === undefined ? `msg_u${n}` : id, assistant = `msg_a${n}`
  const recorded = scenario.wrongVariant ? scenario.wrongVariant : variant
  infoEvent(info(user, session, "user", { agent: "build", time: { created: Date.now() }, model: { providerID: provider, modelID: model, ...(recorded === undefined ? {} : { variant: recorded }) } }))
  partEvent({ id: `prt_u${n}`, sessionID: session, messageID: user, type: "text", text })
  if (scenario.hang) { hanging = session; return }
  if (scenario.permission) { emit({ type: "permission.asked", properties: { id: "per_1", sessionID: session, permission: "bash", patterns: ["ls"] } }); return }
  if (scenario.question) { emit({ type: "question.asked", properties: { id: "que_1", sessionID: session, questions: [] } }); return }
  if (scenario.foreign) {
    emit({ type: "session.created", properties: { sessionID: "ses_child", info: { id: "ses_child", parentID: session } } })
    infoEvent(info("child_a", "ses_child", "assistant"))
  }
  const tokens = { input: 100, output: 20, reasoning: 0, cache: { read: 10, write: 0 } }
  const answered = info(assistant, session, "assistant", { parentID: user, providerID: provider, modelID: scenario.model ?? model, tokens, ...(recorded === undefined ? {} : { variant: recorded }) })
  infoEvent(answered)
  if (scenario.error) {
    emit({ type: "session.error", properties: { sessionID: session, error: scenario.error } })
    idle(session)
    return
  }
  if (scenario.tool) {
    const tool = { id: `prt_t${n}`, sessionID: session, messageID: assistant, type: "tool", tool: "bash", callID: `call${n}` }
    partEvent({ ...tool, state: { status: "running", input: {}, time: { start: 1 } } })
    partEvent({ ...tool, state: { status: "completed", input: {}, output: "TOOL-OUTPUT-SENTINEL", title: "t", metadata: {}, time: { start: 1, end: 2 } } })
  }
  const said = scenario.answer ?? "Hello world"
  const half = Math.ceil(said.length / 2)
  const part = { id: `prt_a${n}`, sessionID: session, messageID: assistant, type: "text" }
  const thought = { id: `prt_r${n}`, sessionID: session, messageID: assistant, type: "reasoning", text: "hidden" }
  // The reasoning streams too, under the same field name: only the part's own kind says it is not the answer.
  partEvent({ ...thought, text: "" })
  deltaEvent(thought, "hidden")
  partEvent({ ...part, text: "" })
  deltaEvent(part, said.slice(0, half))
  deltaEvent(part, said.slice(half))
  partEvent({ ...part, text: said })
  messages.set(assistant, { info: answered, parts: [{ ...part, text: said }, thought] })
  infoEvent(answered)
  idle(session)
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } })

const server = Bun.serve({
  port, hostname: "127.0.0.1", idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (!scenario.noauth && request.headers.get("authorization") !== expectedAuth) return new Response("unauthorized", { status: 401 })
    const path = url.pathname
    if (path === "/global/health") return json({ healthy: true, version: "9.9.9" })
    if (path === "/config") return json(scenario.weak ? { ...config, permission: { ...config.permission, task: "allow" } } : config)
    if (path === "/provider") {
      // The catalogue lists the bound model with the variants the scenario names (none by default), unless it is "unknown".
      const models = scenario.unknownModel ? {} : { [model]: { id: model, providerID: provider, variants: scenario.variants ?? {} } }
      return json({ all: [{ id: provider, name: provider, source: "config", env: [], options: {}, models }], default: {}, connected: scenario.disconnected ? [] : [provider] })
    }
    if (path === "/event") {
      let mine!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          mine = controller
          clients.add(controller)
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`))
          if (scenario.cutEvents) setTimeout(() => { try { controller.close() } catch { /* gone */ } clients.delete(mine) }, 300)
        },
        cancel() { clients.delete(mine) },
      })
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } })
    }
    if (path === "/session" && request.method === "POST") {
      const id = `ses_${sessions.length + 1}`
      sessions.push(id)
      save()
      log({ at: "session.create", body: await request.json() })
      return json({ id, title: "x" })
    }
    const found = /^\/session\/([^/]+)(?:\/(.+))?$/.exec(path)
    if (found) {
      const [, id, rest] = found
      if (!sessions.includes(id)) return new Response("not found", { status: 404 })
      if (rest === undefined) return json({ id })
      if (rest === "prompt_async" && request.method === "POST") {
        const body = await request.json() as { parts: { text: string }[]; messageID?: string; variant?: string }
        log({ at: "prompt", session: id, body, authenticated: true })
        if (scenario.crashOnPrompt) process.exit(1)
        setTimeout(() => void turn(id, body.parts[0].text, body.messageID, body.variant), 20)
        return new Response(null, { status: 204 })
      }
      if (rest === "abort" && request.method === "POST") {
        log({ at: "abort", session: id })
        if (hanging === id) {
          hanging = null
          emit({ type: "session.error", properties: { sessionID: id, error: { name: "MessageAbortedError", data: { message: "aborted" } } } })
          idle(id)
        }
        return json(true)
      }
      const one = /^message\/(.+)$/.exec(rest)
      if (one) {
        const held = messages.get(one[1])
        return held ? json(held) : new Response("not found", { status: 404 })
      }
    }
    return new Response("not found", { status: 404 })
  },
})
log({ at: "start", pid: process.pid, port: server.port, cwd: process.cwd() })
