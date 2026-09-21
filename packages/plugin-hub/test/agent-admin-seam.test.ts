// The administration seam: two verbs wide, four answers, and a lookup that
// runs on the command a person typed and never on a tick.
//
// NO REQUEST LEAVES THIS CHECK. Each adapter is handed a transport the check
// owns, and the global `fetch` is replaced by one that throws for the length of
// every platform body, so an adapter that ignored its transport fails loudly
// here instead of reaching Discord or Telegram.
//
// What is deliberately NOT in the seam, and is asserted absent: create, rename
// and delete. Each one needs a management permission that widens what a stolen
// bot token can do to a household's whole server, and deleting a chat deletes
// history.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { seam, startCluster, startReadySubprocess, type Cluster, type ReadyProcess } from "./helpers/cluster.ts"
import { createFakePlatform, servePlatform } from "./helpers/fake-platform.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { writeRegistry } from "./helpers/registry.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { WORDS } from "../src/door/lines.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const CHAT = "1000000009"
const GUILD = "2000000000"
/** Fast bounds, so a permanent refusal is three attempts and not three seconds. */
const BOUNDS = { retrySeconds: 0.01, maxAttempts: 3 }

interface Seen { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | null }

/** A transport the check owns, recording what it was asked for. */
function transport(answer: (seen: Seen) => Response): { fetch: typeof fetch; seen(): Seen[] } {
  const log: Seen[] = []
  const own = (async (input: unknown, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = String(value)
    }
    let body: Record<string, unknown> | null = null
    if (typeof init?.body === "string") { try { body = JSON.parse(init.body) as Record<string, unknown> } catch { body = null } }
    const it: Seen = { url: String(input), method: String(init?.method ?? "GET"), headers, body }
    log.push(it)
    return answer(it)
  }) as unknown as typeof fetch
  return { fetch: own, seen: () => log.map(one => ({ ...one })) }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

async function withNoNetwork<T>(what: string, run: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch
  globalThis.fetch = ((input: unknown) => {
    throw new Error(`${what} used the global fetch for ${String(input)} instead of the transport it was given`)
  }) as unknown as typeof fetch
  try { return await run() } finally { globalThis.fetch = real }
}

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "agent-admin-")) })
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

/** A placeholder token under a scratch directory. Never a real one. */
function plantToken(name: string): { file: string; token: string } {
  const token = `placeholder-${crypto.randomUUID()}`
  const file = join(dir, name)
  writeFileSync(file, `${token}\n`, "utf8")
  return { file, token }
}

type Resolve = (platform: unknown, ref: string, bounds: { retrySeconds: number; maxAttempts: number })
  => Promise<{ kind: string; chat?: string; name?: string; cause?: string; detail?: string }>

async function resolver(): Promise<Resolve> {
  const module = await seam("src/door/agentctl.ts")
  expect(typeof module.resolveChatRef, "src/door/agentctl.ts exports resolveChatRef").toBe("function")
  return module.resolveChatRef as Resolve
}

test("D-220 the four answers a resolution can give, each by its shape and by its own cause", async () => {
  const resolveChatRef = await resolver()
  const fake = createFakePlatform({ name: "fake", admin: { chats: [
    { name: "research", chat: CHAT }, { name: "lair", chat: "1000000001" }] } })
  expect(await resolveChatRef(fake.platform, "research", BOUNDS)).toEqual({ kind: "chat", chat: CHAT, name: "research" })
  expect(await resolveChatRef(fake.platform, "nothing-here", BOUNDS)).toEqual({ kind: "absent", cause: "chat missing" })
  fake.setAmbiguous("twin")
  expect(await resolveChatRef(fake.platform, "twin", BOUNDS)).toEqual({ kind: "ambiguous", cause: "chat name ambiguous" })
  // A platform with no administration member at all, which is every platform a
  // shipped check builds.
  const plain = createFakePlatform({ name: "fake" })
  expect("admin" in plain.platform).toBe(false)
  expect(await resolveChatRef(plain.platform, "research", BOUNDS)).toEqual({ kind: "unsupported", cause: "unsupported on this platform" })
  // Every cause a person reads is one of the words the household decided on.
  for (const cause of ["chat missing", "chat name ambiguous", "unsupported on this platform", "one agent per bot"]) {
    expect(Object.hasOwn(WORDS, cause), `${cause} is in the closed list`).toBe(true)
  }
  // The control: a platform that carries the member and is asked nothing
  // records no call, so the log below means what it says.
  expect(plain.adminCalls()).toEqual([])
  const untouched = createFakePlatform({ name: "fake", admin: { chats: [{ name: "research", chat: CHAT }] } })
  expect(untouched.adminCalls()).toEqual([])
})

test("D-220 one injected refusal yields one retry, a permanent one stops at the household's bound, and the cause is sanitized", async () => {
  const resolveChatRef = await resolver()
  const fake = createFakePlatform({ name: "fake", admin: { chats: [{ name: "research", chat: CHAT }] } })
  fake.setRefuseOnce()
  expect(await resolveChatRef(fake.platform, "research", BOUNDS)).toEqual({ kind: "chat", chat: CHAT, name: "research" })
  expect(fake.adminCalls()).toHaveLength(2)
  fake.setRefusing(true)
  const failed = await resolveChatRef(fake.platform, "research", BOUNDS)
  expect(failed.kind).toBe("failed")
  // Three attempts, which is this household's `door.delivery_max_attempts`.
  expect(fake.adminCalls().filter(one => one.verb === "resolveChat")).toHaveLength(2 + BOUNDS.maxAttempts)
  // The fake's refusal carries an authorization header in its message, the way
  // a platform client's error does, and none of it reaches a person.
  expect(failed.cause).not.toContain("a-bot-token-shaped-string")
  expect(failed.cause).not.toContain("authorization")
})

test("D-220 a numeric ref is taken as the chat and confirmed, on both platforms", async () => {
  const { discord } = await seam("src/door/platforms/discord.ts")
  const { telegram } = await seam("src/door/platforms/telegram.ts")
  const resolveChatRef = await resolver()
  await withNoNetwork("discord", async () => {
    const wire = transport(() => json({ id: CHAT, name: "research", type: 0 }))
    const platform = (discord as Function)({ tokenFile: plantToken("discord.token").file, guild: GUILD, fetch: wire.fetch })
    expect(await resolveChatRef(platform, CHAT, BOUNDS)).toEqual({ kind: "chat", chat: CHAT, name: "research" })
    expect(wire.seen().map(one => [one.method, new URL(one.url).pathname])).toEqual([["GET", `/api/v10/channels/${CHAT}`]])
  })
  await withNoNetwork("telegram", async () => {
    const wire = transport(() => json({ ok: true, result: { id: Number(CHAT), title: "research", type: "group" } }))
    const platform = (telegram as Function)({ tokenFile: plantToken("telegram.token").file, fetch: wire.fetch })
    expect(await resolveChatRef(platform, CHAT, BOUNDS)).toEqual({ kind: "chat", chat: CHAT, name: "research" })
    expect(wire.seen().map(one => one.url.split("/").pop())).toEqual(["getChat"])
  })
})

test("D-220 describeChat answers for a live chat, for one that is gone, and names a refusal as its own failure", async () => {
  const { discord } = await seam("src/door/platforms/discord.ts")
  const { file, token } = plantToken("discord-describe.token")
  await withNoNetwork("discord", async () => {
    const live = transport(() => json({ id: CHAT, name: "research", type: 0 }))
    const platform = (discord as Function)({ tokenFile: file, guild: GUILD, fetch: live.fetch }) as
      { admin?: { describeChat(chat: string): Promise<Record<string, unknown>> } }
    expect(typeof platform.admin?.describeChat, "the discord adapter carries the administration member").toBe("function")
    expect(await platform.admin!.describeChat(CHAT)).toEqual({ exists: true, name: "research", kind: "text" })
    expect(live.seen()[0].headers.authorization).toBe(`Bot ${token}`)
    const gone = transport(() => json({ message: "Unknown Channel", code: 10003 }, 404))
    const removed = (discord as Function)({ tokenFile: file, fetch: gone.fetch }) as
      { admin: { describeChat(chat: string): Promise<Record<string, unknown>> } }
    expect(await removed.admin.describeChat(CHAT)).toEqual({ exists: false, name: null, kind: null })
    const broken = transport(() => json({ message: "Internal Server Error" }, 500))
    const refused = (discord as Function)({ tokenFile: file, fetch: broken.fetch }) as
      { admin: { describeChat(chat: string): Promise<{ exists: boolean; failure?: { code: string; cause: string } }> } }
    const answer = await refused.admin.describeChat(CHAT)
    expect(answer.exists).toBe(false)
    expect(answer.failure?.code).toBe("http-500")
    expect(answer.failure?.cause).not.toContain(token)
  })
})

test("D-220 a Discord name is resolved by ONE guild channel listing, and nothing else is asked for at all", async () => {
  const { discord } = await seam("src/door/platforms/discord.ts")
  const resolveChatRef = await resolver()
  const { file, token } = plantToken("discord-name.token")
  await withNoNetwork("discord", async () => {
    const wire = transport(() => json([
      { id: "1000000001", name: "lair", type: 0 },
      { id: CHAT, name: "research", type: 0 },
    ]))
    const platform = (discord as Function)({ tokenFile: file, guild: GUILD, fetch: wire.fetch })
    expect(await resolveChatRef(platform, "research", BOUNDS)).toEqual({ kind: "chat", chat: CHAT, name: "research" })
    const seen = wire.seen()
    expect(seen).toHaveLength(1)
    expect(seen[0].method).toBe("GET")
    expect(new URL(seen[0].url).pathname).toBe(`/api/v10/guilds/${GUILD}/channels`)
    expect(seen[0].headers.authorization).toBe(`Bot ${token}`)
    // NO PERMISSION IS WIDENED. Creating, renaming or deleting a channel is a
    // write on one of these paths, and this check never sees one.
    expect(seen.filter(one => one.method !== "GET")).toEqual([])
    // The same rule the offline registry conversion reads, and the same one
    // listing it asks for: exactly one channel of that name resolves, none is
    // absent, more than one is ambiguous. The conversion's own refusal of both
    // shapes is asserted in `test/convert-v2-registry.test.ts`, and its single
    // message does not tell the two apart because an offline conversion does
    // not have to. The seam does, so each answer carries its own cause.
    const absent = transport(() => json([{ id: "1000000001", name: "lair", type: 0 }]))
    const missing = await resolveChatRef((discord as Function)({ tokenFile: file, guild: GUILD, fetch: absent.fetch }), "research", BOUNDS)
    expect({ kind: missing.kind, cause: missing.cause }).toEqual({ kind: "absent", cause: "chat missing" })
    const twice = transport(() => json([
      { id: CHAT, name: "research", type: 0 }, { id: "1000000008", name: "research", type: 0 }]))
    const both = await resolveChatRef((discord as Function)({ tokenFile: file, guild: GUILD, fetch: twice.fetch }), "research", BOUNDS)
    expect({ kind: both.kind, cause: both.cause }).toEqual({ kind: "ambiguous", cause: "chat name ambiguous" })
  })
})

test("D-220 a Discord door with no guild answers unsupported for a name and still takes an id", async () => {
  const { discord } = await seam("src/door/platforms/discord.ts")
  const resolveChatRef = await resolver()
  const { file } = plantToken("discord-noguild.token")
  await withNoNetwork("discord", async () => {
    const byName = transport(() => json([]))
    const unsupported = await resolveChatRef((discord as Function)({ tokenFile: file, fetch: byName.fetch }), "research", BOUNDS)
    expect({ kind: unsupported.kind, cause: unsupported.cause })
      .toEqual({ kind: "unsupported", cause: "unsupported on this platform" })
    expect(String(unsupported.detail), "the refusal says the id still works").toContain("id still works")
    // Nothing was asked of the platform at all, so a door with no guild adds no request.
    expect(byName.seen()).toEqual([])
    const byId = transport(() => json({ id: CHAT, name: "research", type: 0 }))
    expect(await resolveChatRef((discord as Function)({ tokenFile: file, fetch: byId.fetch }), CHAT, BOUNDS))
      .toEqual({ kind: "chat", chat: CHAT, name: "research" })
  })
})

// One Telegram door serves one agent in one chat, by the loader's own rule,
// because Telegram confirms updates for the whole bot. So a second agent on one
// bot cannot exist at all and repair is the only verb that reaches Telegram.
test("D-220 the loader refuses a second agent on one Telegram door, and the door's own cause says why", async () => {
  const file = writeRegistry(dir, {
    hub: { store_url: "postgres://127.0.0.1:1/unused", state_dir: dir },
    people: [{ id: "p1" }],
    agents: [
      { id: "p1-lair", person: "p1", preset: "daily", chat: "1000000001", door: "door-tg", runner: "runner-pi" },
      { id: "p1-new", person: "p1", preset: "daily", chat: CHAT, door: "door-tg", runner: "runner-pi" },
    ],
    presets: { daily: { adapter: "a-scripted-adapter", model: "a-model-name", provider: "a-provider", effort: "medium", paid: "key" } },
    run: [
      { id: "door-tg", kind: "door", platform: "telegram", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
    ],
  })
  const refused = (() => { try { loadRegistry(file); return null } catch (error) { return error as Error } })()
  expect(refused).not.toBeNull()
  expect(String(refused!.message)).toContain("one Telegram door serves one agent in one chat")
  // The word the door says to a person about the same rule, in both languages.
  expect(WORDS["one agent per bot"]).toBe("один агент на бота")
})

test("D-220 Telegram resolves a name from the chats its bot-wide poll already dropped, with no extra call and no cursor change", async () => {
  const { telegram } = await seam("src/door/platforms/telegram.ts")
  const resolveChatRef = await resolver()
  await withNoNetwork("telegram", async () => {
    const wire = transport(() => json({ ok: true, result: [
      { update_id: 10, message: { message_id: 1, date: 1700000000, text: "for the lair",
        chat: { id: 1000000001, type: "group", title: "lair" }, from: { id: 7, username: "the-owner" } } },
      { update_id: 11, message: { message_id: 2, date: 1700000001, text: "hello from the new group",
        chat: { id: Number(CHAT), type: "group", title: "research" }, from: { id: 7, username: "the-owner" } } },
    ] }))
    const platform = (telegram as Function)({ tokenFile: plantToken("telegram-memo.token").file, fetch: wire.fetch }) as
      { pull(o: { chat: string; cursor: string | null; timeoutMs: number }): Promise<{ messages: unknown[]; cursor: string | null }> }
    const pulled = await platform.pull({ chat: "1000000001", cursor: null, timeoutMs: 0 })
    // Dropped exactly as it is dropped today, and the cursor is the bot's own.
    expect(pulled.messages).toHaveLength(1)
    expect(pulled.cursor).toBe("12")
    expect(wire.seen()).toHaveLength(1)
    expect(await resolveChatRef(platform, "research", BOUNDS)).toEqual({ kind: "chat", chat: CHAT, name: "research" })
    // NO EXTRA CALL: those updates were acknowledged today exactly as they will be.
    expect(wire.seen()).toHaveLength(1)
  })
})

test("D-220 a Telegram group nobody has written in since the door started is absent, and the refusal says why", async () => {
  const { telegram } = await seam("src/door/platforms/telegram.ts")
  const resolveChatRef = await resolver()
  await withNoNetwork("telegram", async () => {
    const wire = transport(() => json({ ok: true, result: [] }))
    const platform = (telegram as Function)({ tokenFile: plantToken("telegram-absent.token").file, fetch: wire.fetch })
    const answer = await resolveChatRef(platform, "a-group-nobody-wrote-in", BOUNDS)
    expect(answer.kind).toBe("absent")
    // The cause a person reads is the household's own word for it, and the
    // detail an operator reads says what to do about it.
    expect(answer.cause).toBe("chat missing")
    expect(String(answer.detail)).toContain("send a message in it")
    expect(wire.seen()).toEqual([])
  })
})

// Window 1's own bound, applied to the state this plan adds: the listing runs
// inside `acceptBatch` on a fetched command and there is no other caller, so an
// idle door issues none of them however long it sits there.
test("D-220 the chat lookup runs once per adopt and never on a tick", async () => {
  const it = await rolloutStage(cluster, "discord", {
    admin: { chats: [{ name: "research", chat: CHAT }, { name: "lair", chat: "1000000001" }] },
    registry: base => ({
      ...base,
      agents: base.agents!.map(one => ({ ...one, person: "p1" })),
      run: [
        { id: "door-fake", kind: "door", platform: "fake", person: "p1", token_file: "/dev/null",
          schedule: "always", memory_limit_mb: 192, guild: GUILD, default_preset: "daily" },
        { id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ],
    }),
  })
  const platform = await servePlatform({ ...it.fake, platform: it.edge.platform })
  const children: ReadyProcess[] = []
  try {
    const door = await startReadySubprocess("test/helpers/door-subprocess.ts", [it.registryFile, "door-fake", platform.url])
    children.push(door)
    it.edge.batch([message("20", "/agent adopt p1-new research")], "21")
    expect(await observe(() => it.edge.adminCalls().some(one => one.verb === "resolveChat"), 8000),
      "the adopt resolves the name it was given").toBe(true)
    const after = it.edge.adminCalls().length
    // A full typing interval of an idle door, which is the window this check's
    // own machinery could break.
    await Bun.sleep(it.edge.platform.typingSeconds * 1000)
    expect(it.edge.adminCalls().length, "an idle door asks the platform nothing about its chats").toBe(after)
  } finally { for (const child of children.reverse()) await child.stop(); await platform.stop(); await it.stop() }
})
