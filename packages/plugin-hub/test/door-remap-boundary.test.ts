// IMP-163, D-178. An agent remapped to a chat this door has never read starts
// at that chat's high-water mark AS THE PLATFORM REPORTS IT AT ACTIVATION.
// Everything in the chat before that mark is history and is never answered.
// A message a person sends once the door has started on the new chat is
// answered, including one sent while the door is still finding where the chat
// stands.
//
// Both platforms can be remapped. Discord's cursor is per channel, so a door
// that has served another channel finds the new one's whole history waiting.
// Telegram's offset is per bot and a Telegram door serves one agent (PR 35),
// but that agent's chat can still be edited, and an update the bot has not
// confirmed (here: the old chat's reads were failing) is waiting there too.
//
// The catch-up is held at a known step: the first read of the new chat, whose
// answer is computed BEFORE the hold, the way a platform answers from the state
// it had when it was asked. The live message is sent during the hold.
//
// Red reason: behaviour absent. The door found the mark by paging through the
// chat and skipping every page until one came back empty, so the boundary was
// wherever the walk ended, and the live message sent during the walk rode in a
// skipped page as history. The "after" variant is the control: the same stage,
// the same fixture and the same answer path, with the message sent once the
// walk is over, which the door answered before the fix too.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { rolloutFixture } from "./helpers/rollout-fixtures.ts"
import { editAgent, observe } from "./helpers/rollout-runner.ts"
import { discordMessage, telegramUpdate, wirePlatform } from "./helpers/rollout-ingress.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

/** The chat the agent starts on, and the one it is remapped to. */
const OLD = "1000000001"
const NEW = "0000000000"
const LIVE = "sent once the door is on the new chat"

interface Stage {
  platform: ReturnType<typeof wirePlatform>["platform"]
  posts: { chat: string, text: string }[]
  /** True once the first read of the new chat is being held. */
  held(): boolean
  release(): void
  /** A person sends one message to the new chat. */
  send(text: string): void
  /** The door is reading the new chat from its last history message. */
  caughtUp(): boolean
  /** Whatever the old chat's reader needs before the door starts. */
  prime?(read: { sql(text: string, params?: unknown[]): Promise<unknown[]> }): Promise<void>
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>(resolve => { open = resolve })
  return { opened, open }
}

/**
 * Discord over a synthetic transport: one list of messages per channel and
 * Discord's own `after` semantics, newest first on the wire. The new channel's
 * history spans three pages of fifty, so a walk takes several steps.
 */
function discordStage(dir: string): Stage {
  const base = 9007199254740992n
  const channels = new Map<string, ReturnType<typeof discordMessage>[]>([
    [OLD, []],
    [NEW, Array.from({ length: 120 }, (_, i) => discordMessage(String(base + BigInt(i + 1)), { content: `history ${i + 1}` }))],
  ])
  const posts: { chat: string, text: string }[] = []
  const hold = gate()
  let holding = false
  let first = true
  let posted = 0
  const wire = wirePlatform(dir, "discord", async (url, body) => {
    const [, , , , channel, , id] = url.pathname.split("/")
    if (url.pathname.endsWith("/typing")) return new Response(null, { status: 204 })
    if (id !== undefined) return {}
    if (body !== null) {
      posts.push({ chat: channel, text: String(body.content) })
      return { id: String(80000 + ++posted) }
    }
    const all = channels.get(channel) ?? []
    const after = url.searchParams.get("after")
    const answer = after === null
      ? all.slice(-1)
      : all.filter(m => BigInt(m.id) > BigInt(after)).slice(0, Number(url.searchParams.get("limit"))).reverse()
    if (channel === NEW && first) {
      first = false
      holding = true
      await hold.opened
    }
    return answer
  })
  return {
    platform: wire.platform,
    posts,
    held: () => holding,
    release: hold.open,
    send(text) { channels.get(NEW)!.push(discordMessage(String(base + 1000n), { content: text })) },
    caughtUp: () => wire.calls.filter(call => {
      const url = new URL(call.url)
      return url.pathname.includes(`/channels/${NEW}/messages`) && url.searchParams.get("after") === String(base + 120n)
    }).length >= 2,
  }
}

/**
 * Telegram over a synthetic transport with the Bot API's offset rules: an
 * update is confirmed, and gone, once a call carries an offset above it, and a
 * negative offset returns the newest updates and forgets every one before them.
 * The old chat's reads fail, so the new chat's history is still unconfirmed when
 * the agent is remapped, which is the one way Telegram keeps a history a new
 * reader can find. It spans two pages of a hundred.
 */
function telegramStage(dir: string): Stage {
  const OLD_OFFSET = 1
  const updates = Array.from({ length: 150 }, (_, i) => telegramUpdate(1000 + i, {
    chat: { id: NEW }, text: `history ${i + 1}` }))
  let confirmed = 0
  const posts: { chat: string, text: string }[] = []
  const hold = gate()
  let holding = false
  let first = true
  let posted = 0
  const offsets: (number | undefined)[] = []
  const wire = wirePlatform(dir, "telegram", async (url, body) => {
    const method = url.pathname.split("/").pop()
    if (method === "sendMessage") {
      posts.push({ chat: String(body.chat_id), text: String(body.text) })
      return { ok: true, result: { message_id: 80000 + ++posted } }
    }
    if (method === "sendChatAction") return { ok: true, result: true }
    if (method === "editMessageText") return { ok: true, result: {} }
    if (method !== "getUpdates") return { ok: false, error_code: 404, description: "synthetic unknown method" }
    const offset = body.offset as number | undefined
    offsets.push(offset)
    // The old chat's reader, whose reads fail for the whole of this stage.
    if (offset === OLD_OFFSET) return { ok: false, error_code: 502, description: "synthetic outage" }
    let result: typeof updates
    if (offset !== undefined && offset < 0) {
      result = updates.filter(u => u.update_id >= confirmed).slice(offset)
      if (result.length > 0) confirmed = result[0].update_id
    } else {
      if (offset !== undefined) confirmed = Math.max(confirmed, offset)
      result = updates.filter(u => u.update_id >= confirmed).slice(0, Number(body.limit ?? 100))
    }
    if (first) {
      first = false
      holding = true
      await hold.opened
    } else if (result.length === 0 && Number(body.timeout ?? 0) > 0) await Bun.sleep(50)
    return { ok: true, result }
  })
  return {
    platform: wire.platform,
    posts,
    held: () => holding,
    release: hold.open,
    send(text) { updates.push(telegramUpdate(2000, { chat: { id: NEW }, text })) },
    caughtUp: () => offsets.filter(offset => offset === 1150).length >= 2,
    async prime(read) {
      await read.sql(`insert into state_row (sheet, id, data) values ('door_cursor', 'door-fake/${OLD}', '{"cursor":"${OLD_OFFSET}"}')`)
    },
  }
}

for (const name of ["discord", "telegram"] as const) {
  for (const when of ["during", "after"] as const) {
    test(`IMP-163 D-178 ${name}: a message sent ${when === "during" ? "while the door is still finding where a remapped chat stands" : "after the door has caught up on a remapped chat"} is answered, and the chat's history is not`, async () => {
      const it = await rolloutStage(cluster, name, { agents: [] })
      const f = rolloutFixture()
      const stage = name === "discord" ? discordStage(f.dir) : telegramStage(f.dir)
      let door: Awaited<ReturnType<typeof runDoor>> | undefined
      let runner: Awaited<ReturnType<typeof runRunner>> | undefined
      try {
        await stage.prime?.(it.read)
        door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: stage.platform })
        runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
        editAgent(it.registryFile, "p1-lair", { chat: NEW })
        // The bounds below were measured in 52 runs on the Linux box while other suites ran there, at a
        // load average of 8 to 13. One stalled fsync holds the door, the runner and this check alike,
        // because they share a process. The same waits measured at most 2398, 392 and 1304 ms in 58
        // runs at a load average near 4.
        // The tick that notices the edit, then the old reader's last read. Measured max 6198 ms. Three
        // times that is 18594, rounded up.
        expect(await observe(() => stage.held(), 20000), "the door starts on the remapped chat").toBe(true)
        if (when === "during") stage.send(LIVE)
        stage.release()
        if (when === "after") {
          // Measured max 14963 ms. Three times that is 44889, rounded up.
          expect(await observe(() => stage.caughtUp(), 45000), "the door reads the new chat from its newest history").toBe(true)
          stage.send(LIVE)
        }
        // Measured max 32688 ms. Three times that is 98064, rounded up.
        expect(await observe(() => stage.posts.some(post => post.chat === NEW && post.text === `reply to ${LIVE}`), 100000),
          "a message sent once the door is on the new chat is answered there").toBe(true)
        // The control: a message older than the boundary is history. It gets no
        // row, so no turn and no answer, and nothing is said about it.
        const bodies = (await it.read.inbound()).map(row => row.body)
        expect(bodies).toEqual([LIVE])
        expect(stage.posts.filter(post => post.text.includes("history"))).toEqual([])
      } finally { stage.release(); await runner?.stop(); await door?.stop(); await it.stop(); f.stop() }
    // The three bounds above and the stage around them.
    }, 200000)
  }
}

test("IMP-163 D-178 each platform says where a chat stands in one request that reads no page of it", async () => {
  const f = rolloutFixture()
  try {
    const newest = discordMessage("9007199254740993", { content: "newest" })
    let channel = [newest]
    const discord = wirePlatform(f.dir, "discord", () => channel)
    expect(await discord.platform.highWater({ chat: NEW })).toBe(newest.id)
    const asked = new URL(discord.calls[0].url)
    expect(asked.pathname).toBe(`/api/v10/channels/${NEW}/messages`)
    expect([...asked.searchParams.entries()], "newest first, one message, from no cursor").toEqual([["limit", "1"]])
    channel = []
    expect(await discord.platform.highWater({ chat: NEW }), "an empty channel has nothing to skip").toBeNull()

    let result = [telegramUpdate(41, { chat: { id: NEW } })]
    const telegram = wirePlatform(f.dir, "telegram", () => ({ ok: true, result }))
    expect(await telegram.platform.highWater({ chat: NEW }), "the offset after the bot's newest update").toBe("42")
    expect(telegram.calls[0].url.endsWith("/getUpdates")).toBe(true)
    expect(telegram.calls[0].body).toEqual({ offset: -1, limit: 1, timeout: 0, allowed_updates: ["message"] })
    result = []
    expect(await telegram.platform.highWater({ chat: NEW }), "an empty queue has nothing to skip").toBeNull()
  } finally { f.stop() }
})
