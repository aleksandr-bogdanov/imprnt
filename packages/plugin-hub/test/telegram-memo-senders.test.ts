// A Telegram door learns a group's name only from people the household allows.
//
// Telegram's poll is bot-wide, so the door sees messages from every group the
// bot is in and remembers each group's name, which is how an adopt typed by
// name finds a group without another call. Anybody can add the bot to a group
// and write in it, and a stranger's group remembered under a name a person
// later types would be the chat that name resolves to. So a message teaches
// the door a name only when its sender is on the door's allowlist, and the door
// hands its pull that allowlist.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { runDoor } from "../src/door/run.ts"
import { resolveChatRef } from "../src/door/agentctl.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "telegram-memo-")) })
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

const SERVED = "1000000001"
const STRANGERS = "3000000001"
const OWNERS = "3000000002"
const BOUNDS = { retrySeconds: 0.01, maxAttempts: 3 }

test("a group a stranger wrote in is not learnt by name, and a group an allowed sender wrote in is", async () => {
  const { telegram } = await seam("src/door/platforms/telegram.ts")
  const token = join(dir, "telegram.token")
  writeFileSync(token, `placeholder-${crypto.randomUUID()}\n`)
  const updates = [
    { update_id: 10, message: { message_id: 1, date: 1700000000, text: "anyone can add a bot to a group",
      chat: { id: Number(STRANGERS), type: "group", title: "research" }, from: { id: 99, username: "a-stranger" } } },
    { update_id: 11, message: { message_id: 2, date: 1700000001, text: "the owner's new group",
      chat: { id: Number(OWNERS), type: "group", title: "reading" }, from: { id: 7, username: "the-owner" } } },
  ]
  const real = globalThis.fetch
  const own = (async () => new Response(JSON.stringify({ ok: true, result: updates }),
    { headers: { "content-type": "application/json" } })) as unknown as typeof fetch
  globalThis.fetch = (() => { throw new Error("the adapter used the global fetch") }) as unknown as typeof fetch
  try {
    const platform = (telegram as Function)({ tokenFile: token, fetch: own }) as {
      pull(o: { chat: string; cursor: string | null; timeoutMs: number; allowed?: (sender: string) => boolean }): Promise<unknown>
    }
    await platform.pull({ chat: SERVED, cursor: null, timeoutMs: 0, allowed: sender => sender === "7" })
    expect(await resolveChatRef(platform as never, "research", BOUNDS)).toMatchObject({ kind: "absent", cause: "chat missing" })
    expect(await resolveChatRef(platform as never, "reading", BOUNDS)).toEqual({ kind: "chat", chat: OWNERS, name: "reading" })
  } finally { globalThis.fetch = real }
})

test("the door hands every pull the allowlist of the person it serves, for this door", async () => {
  const it = await rolloutStage(cluster, "telegram")
  const asked: ((sender: string) => boolean)[] = []
  const pull = it.edge.platform.pull.bind(it.edge.platform)
  const platform = {
    ...it.edge.platform,
    async pull(where: { chat: string; cursor: string | null; timeoutMs: number; allowed?: (sender: string) => boolean }) {
      if (where.chat === SERVED && typeof where.allowed === "function") asked.push(where.allowed)
      return await pull(where)
    },
  }
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform })
    expect(await observe(() => asked.length > 0, 10000), "a pull of the served chat carried an allowlist").toBe(true)
    const allowed = asked.at(-1)!
    expect(allowed("p1")).toBe(true)
    expect(allowed("a-stranger")).toBe(false)
    // The second person is allowed on this door for their own chat, and the
    // served chat here is the owner's, whose allowlist is the one that counts.
    expect(allowed("p2")).toBe(false)
  } finally { await door?.stop(); await it.stop() }
}, 60_000)
