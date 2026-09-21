// Making, repairing and retiring an agent from a phone.
//
// The person makes the chat in the app and types one command in a chat the door
// already reads. The hub edits the one line of the one file that has to change,
// and every door and runner picks it up on the tick it already takes, so NO
// PROCESS IS RESTARTED for any of it. The door's process id is recorded at the
// start and asserted unchanged after every scene, which is one assertion
// repeated on purpose.
//
// The in-app rename is satisfied BY CONSTRUCTION: the registry holds the chat's
// id, so renaming it changes nothing here at all, and the scene below is the
// observation that says so rather than a verb.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, startReadySubprocess, type Cluster, type ReadyProcess } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { serviceOs } from "./helpers/rollout-service.ts"
import { insertInbound, superStore } from "./helpers/hub-fixture.ts"
import { servePlatform } from "./helpers/fake-platform.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { lineDiff } from "./helpers/registry-fixture.ts"
import { runHub } from "../src/hub/run.ts"
import { runRunner } from "../src/runner/run.ts"
import { appendChatLine, readTail } from "../src/chatlog.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR = "1000000001"
const DESK = "1000000003"
const RESEARCH = "1000000009"
const AGAIN = "1000000005"
const GUILD = "2000000000"

/** The household every scene below runs in: one machine, one door, two of this person's agents. */
function household(options: { preset?: boolean } = {}) {
  const os = process.platform === "darwin" ? "macos" : "linux"
  return {
    admin: { chats: [
      { name: "lair", chat: LAIR }, { name: "desk", chat: DESK },
      { name: "research", chat: RESEARCH }, { name: "lair-again", chat: AGAIN },
    ] },
    machines: [{ id: "mac", os }],
    registry: (base: any) => ({
      ...base,
      agents: [
        ...base.agents!.map((one: any) => ({ ...one, person: "p1" })),
        { id: "p1-desk", person: "p1", preset: "daily", chat: DESK, door: "door-fake", runner: "runner-pi" },
      ],
      run: [
        { id: "door-fake", kind: "door", platform: "fake", person: "p1", token_file: "/dev/null",
          schedule: "always", memory_limit_mb: 192, guild: GUILD,
          ...(options.preset === false ? {} : { default_preset: "daily" }) },
        { id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ],
    }),
  }
}

const inertOs = (stateDir: string) => {
  const os = serviceOs(stateDir, "launchd", ["door-fake", "runner-pi"])
  // An inert control harness creates no unsuffixed service files.
  os.os.render = () => []
  return os
}

test("D-220 adopt binds a new agent to a chat the person made, says so in both chats, and restarts nothing", async () => {
  const it = await rolloutStage(cluster, "discord", household())
  const platform = await servePlatform({ ...it.fake, platform: it.edge.platform })
  const children: ReadyProcess[] = []
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    const door = await startReadySubprocess("test/helpers/door-subprocess.ts", [it.registryFile, "door-fake", platform.url])
    children.push(door)
    const pid = door.pid
    const manager = inertOs(it.stateDir)
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: manager.os })
    const before = readFileSync(it.registryFile, "utf8")
    // The agent nothing touches, whose block, history and watermark must come
    // out of all four scenes byte for byte.
    const untouched = /\[\[agents\]\]\nid = "p1-desk"[\s\S]*?\n\n/.exec(before)![0]
    await appendChatLine({ stateDir: it.stateDir, person: "p1", agent: "p1-desk" }, {
      id: "desk-line", at: new Date().toISOString(), direction: "in", from: "p1", text: "a line nobody touches",
    })
    const deskStore = await superStore(cluster, it.db)
    await deskStore.sql`insert into state_row (sheet, id, data) values ('harvest', ${"p1/p1-desk"},
      ${{ at: "2026-09-18T00:00:00.000Z", row: "planted", harvested_at: "2026-09-18T00:00:01.000Z", notes: 3 }})`
    await deskStore.close()
    it.edge.batch([message("20", "/agent adopt p1-new research")], "21")

    expect(await observe(async () => (await it.read.sheet("control")).some(row => row.data.status === "applied"), 10000),
      "the hub applies the lifecycle row").toBe(true)
    // EXACTLY ONE BLOCK IS ADDED and nothing at all is removed.
    const after = readFileSync(it.registryFile, "utf8")
    const diff = lineDiff(before, after)
    expect(diff.removed).toEqual([])
    expect(diff.added.filter(line => line !== "")).toEqual([
      "[[agents]]", 'id = "p1-new"', 'person = "p1"', 'preset = "daily"',
      `chat = "${RESEARCH}"`, 'door = "door-fake"', 'runner = "runner-pi"',
    ])
    expect(door.pid, "no process is restarted for an adopt").toBe(pid)

    // The proof the binding took is the sentence that lands in the ADOPTED
    // chat, on the route the resolution produced. A notice that only went back
    // where the command came from would prove the command was read and nothing
    // more.
    expect(await observe(() => it.edge.posts().some(post => post.chat === RESEARCH), 10000),
      "the door serves the chat it was just given").toBe(true)
    const said = it.edge.posts().map(post => [post.chat, post.text])
    expect(said).toContainEqual([RESEARCH, "[door] p1-new now answers in this chat."])
    expect(said).toContainEqual([LAIR, "[door] adopt requested for p1-new."])
    expect(said).toContainEqual([LAIR, "[door] p1-new now answers in research."])
    expect(door.pid).toBe(pid)

    // The in-app rename: the person renames the chat in the app and NOTHING
    // happens here, because the registry holds the id.
    const bytes = readFileSync(it.registryFile, "utf8")
    it.edge.renameChat(RESEARCH, "research-again")
    it.edge.batch([{ ...message("30", "after the rename"), chat: RESEARCH }], "31")
    expect(await observe(async () => (await it.read.inbound()).some(row => row.agent === "p1-new")), "the door keeps reading a renamed chat").toBe(true)
    expect(readFileSync(it.registryFile, "utf8"), "an in-app rename changes zero registry bytes").toBe(bytes)
    expect(door.pid).toBe(pid)

    // Retire: the entry goes, the chat and the history stay, the door's own
    // sheets for it go, and the harvest watermark stays so the same id adopted
    // again resumes where it stopped.
    const history = join(it.stateDir, "p1", "chatlog", "p1-new")
    expect(existsSync(history)).toBe(true)
    const store = await superStore(cluster, it.db)
    await store.sql`insert into state_row (sheet, id, data) values ('harvest', ${"p1/p1-new"},
      ${{ at: "2026-09-20T00:00:00.000Z", row: "planted", harvested_at: "2026-09-20T00:00:01.000Z", notes: 1 }})
      on conflict (sheet, id) do update set data = excluded.data`
    // A progress line the door would be editing for this agent, which is its
    // own sheet and goes with it.
    await store.sql`insert into state_row (sheet, id, data) values ('door_progress', 'planted-progress',
      ${{ post_id: "70999", chat: RESEARCH, agent: "p1-new", started_at: new Date().toISOString() }})`
    it.edge.batch([message("40", "/agent retire p1-new")], "41")
    expect(await observe(async () => (await it.read.sheet("control")).filter(row => row.data.status === "applied").length === 2, 10000),
      "the hub applies the retire").toBe(true)
    const retired = readFileSync(it.registryFile, "utf8")
    expect(lineDiff(bytes, retired).added).toEqual([])
    expect(lineDiff(bytes, retired).removed.filter(line => line !== "")).toEqual([
      "[[agents]]", 'id = "p1-new"', 'person = "p1"', 'preset = "daily"',
      `chat = "${RESEARCH}"`, 'door = "door-fake"', 'runner = "runner-pi"',
    ])
    // The platform chat is still there, because the hub never deletes one.
    expect(await it.edge.platform.admin!.describeChat(RESEARCH)).toEqual({ exists: true, name: "research-again", kind: "channel" })
    // THE HISTORY IS INTACT, which is the whole of what a retire must not do.
    expect(readdirSync(history).length).toBeGreaterThan(0)
    expect(await readTail({ stateDir: it.stateDir, person: "p1", agent: "p1-new", now: new Date(), hours: 24, tokens: 8000 }))
      .toContain("after the rename")
    expect(await observe(async () => !(await it.read.sheet("door_cursor")).some(row => row.id === `door-fake/${RESEARCH}`), 8000),
      "the door's own sheet for a chat it no longer serves is gone").toBe(true)
    expect((await it.read.sheet("door_progress")).some(row => row.id === "planted-progress"),
      "the door's progress sheet for a retired agent is gone").toBe(false)
    // The watermark STAYS, because the same id adopted again resumes there.
    expect((await it.read.sheet("harvest")).find(row => row.id === "p1/p1-new")?.data)
      .toMatchObject({ at: "2026-09-20T00:00:00.000Z" })
    expect(door.pid).toBe(pid)

    // Adopting the retired id again resumes from that watermark, which is what
    // makes the clause above mean something.
    it.edge.batch([message("50", `/agent adopt p1-new ${RESEARCH}`)], "51")
    expect(await observe(async () => (await it.read.sheet("control")).filter(row => row.data.status === "applied").length === 3, 10000),
      "the retired id is adopted again").toBe(true)
    expect((await it.read.sheet("harvest")).find(row => row.id === "p1/p1-new")?.data)
      .toMatchObject({ at: "2026-09-20T00:00:00.000Z" })
    await store.close()

    // The control: the agent nothing touched kept its block byte for byte, its
    // history and its watermark, and its cursor is still there. The cursor is
    // asserted present rather than equal, because it moves forward every time
    // the door reads that chat, which is the door doing its job.
    expect(readFileSync(it.registryFile, "utf8")).toContain(untouched)
    expect(await readTail({ stateDir: it.stateDir, person: "p1", agent: "p1-desk", now: new Date(), hours: 24, tokens: 8000 }))
      .toContain("a line nobody touches")
    expect((await it.read.sheet("harvest")).find(row => row.id === "p1/p1-desk")?.data)
      .toEqual({ at: "2026-09-18T00:00:00.000Z", row: "planted", harvested_at: "2026-09-18T00:00:01.000Z", notes: 3 })
    expect((await it.read.sheet("door_cursor")).some(row => row.id === `door-fake/${DESK}`)).toBe(true)
    // No process was restarted and the manager was asked to restart nothing.
    expect(manager.calls.filter(call => call.operation === "restart")).toEqual([])
    expect(door.pid).toBe(pid)
  } finally {
    await hub?.stop(); for (const child of children.reverse()) await child.stop()
    await platform.stop(); await it.stop()
  }
}, 120_000)

test("D-220 a door whose entry names no preset refuses an adopt and leaves the file identical", async () => {
  const it = await rolloutStage(cluster, "discord", household({ preset: false }))
  const platform = await servePlatform({ ...it.fake, platform: it.edge.platform })
  const children: ReadyProcess[] = []
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    const door = await startReadySubprocess("test/helpers/door-subprocess.ts", [it.registryFile, "door-fake", platform.url])
    children.push(door)
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    const before = readFileSync(it.registryFile, "utf8")
    it.edge.batch([message("20", "/agent adopt p1-new research")], "21")
    expect(await observe(() => it.edge.posts().some(post => post.text.includes("refused")), 10000),
      "a door that cannot say what a new agent would run as refuses the adopt").toBe(true)
    expect(it.edge.posts().map(post => post.text)).toContain("[door] adopt for p1-new refused: invalid configuration.")
    expect(readFileSync(it.registryFile, "utf8")).toBe(before)
    expect(await it.read.sheet("control")).toEqual([])
  } finally {
    await hub?.stop(); for (const child of children.reverse()) await child.stop()
    await platform.stop(); await it.stop()
  }
}, 120_000)

test("D-220 a repair after a deleted channel keeps the id, the history, the watermark and the pending work", async () => {
  const it = await rolloutStage(cluster, "discord", household())
  const platform = await servePlatform({ ...it.fake, platform: it.edge.platform })
  const children: ReadyProcess[] = []
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  const store = await superStore(cluster, it.db)
  try {
    // Planted BEFORE anything runs: a line of history and a harvest watermark.
    await appendChatLine({ stateDir: it.stateDir, person: "p1", agent: "p1-lair" }, {
      id: "planted-line", at: new Date().toISOString(), direction: "in", from: "p1", text: "a line from before the repair",
    })
    await store.sql`insert into state_row (sheet, id, data) values ('harvest', ${"p1/p1-lair"},
      ${{ at: "2026-09-19T00:00:00.000Z", row: "planted", harvested_at: "2026-09-19T00:00:01.000Z", notes: 2 }})`

    const door = await startReadySubprocess("test/helpers/door-subprocess.ts", [it.registryFile, "door-fake", platform.url])
    children.push(door)
    const pid = door.pid
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    // NOBODY IS RUNNING A RUNNER YET, so this really is work owed across the
    // repair rather than work answered before it.
    await insertInbound(cluster, it.db, { id: "pending-before-repair", person: "p1", agent: "p1-lair", body: "answer me after the repair" })

    // The channel is deleted in the app, and the person types the repair in a
    // chat the door still reads.
    it.edge.removeChat(LAIR)
    // An answer owed on the channel that has just been deleted, pinned to that
    // route the way the trigger pins every route before delivery.
    await store.sql`insert into outbox (kind, inbound_id, seq_in_reply, body, person, agent, notice_key, route)
      values ('notice', null, 1, 'an answer owed on the old channel', 'p1', 'p1-lair', 'planted-owed',
              ${{ door: "door-fake", chat: LAIR }}::jsonb)`
    // Something was said in the new chat before it was bound, and it is history.
    it.edge.batch([{ ...message("25", "said before the binding"), chat: AGAIN }], "26")
    it.edge.batch([{ ...message("30", `/agent adopt p1-lair ${AGAIN}`), chat: DESK }], "31")

    const before = readFileSync(it.registryFile, "utf8")
    expect(await observe(async () => (await it.read.sheet("control")).some(row => row.data.status === "applied"), 10000),
      "the hub applies the repair").toBe(true)
    const after = readFileSync(it.registryFile, "utf8")
    // EXACTLY ONE `chat` LINE, and nothing else in the file.
    expect(lineDiff(before, after)).toEqual({ removed: [`chat = "${LAIR}"`], added: [`chat = "${AGAIN}"`] })
    expect(door.pid, "a repair restarts nothing").toBe(pid)

    // The four things that must survive, each read back where it lives.
    expect(await readTail({ stateDir: it.stateDir, person: "p1", agent: "p1-lair", now: new Date(), hours: 24, tokens: 8000 }))
      .toContain("a line from before the repair")
    expect((await it.read.sheet("harvest")).find(row => row.id === "p1/p1-lair")?.data)
      .toMatchObject({ at: "2026-09-19T00:00:00.000Z", notes: 2 })
    const pending = (await it.read.inbound()).find(row => row.id === "pending-before-repair")!
    expect(pending.agent, "the agent id is the same in the work it still owes").toBe("p1-lair")
    expect(pending.state, "the work is still owed at the moment of the repair").not.toBe("answered")
    // The new chat starts at its own high-water mark, asked for once when the
    // reader activates, and the row that saves it is also how a check knows the
    // door is serving the new chat rather than the one that is gone.
    expect(await observe(async () => (await it.read.sheet("door_cursor")).some(row => row.id === `door-fake/${AGAIN}`), 10000),
      "the door activates the new chat").toBe(true)
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
    expect(await observe(() => it.edge.posts().some(post => post.chat === AGAIN && post.text.includes("answer me after the repair")), 20000),
      "work owed before the repair is answered on the new chat").toBe(true)

    // THE OWED REPLY IS NOT RE-ROUTED. Its route is pinned by the trigger, and
    // the honest state of a reply owed on a deleted channel is the delivery
    // finding, after which the person asks again.
    const owed = (await store.sql`select route, delivery_state from outbox where notice_key = 'planted-owed'`)[0]
    expect(owed.route).toEqual({ door: "door-fake", chat: LAIR })
    expect(it.edge.posts().some(post => post.chat === AGAIN && post.text.includes("an answer owed on the old channel"))).toBe(false)
    expect(await observe(async () =>
      (await store.sql`select delivery_state from outbox where notice_key = 'planted-owed'`)[0].delivery_state === "failed", 15000),
      "an answer owed on a deleted channel becomes a delivery finding").toBe(true)

    // What was said in the new chat before the binding is history, and it is
    // never read as new work.
    expect((await it.read.inbound()).some(row => String(row.body).includes("said before the binding"))).toBe(false)
    expect(door.pid).toBe(pid)
  } finally {
    await hub?.stop(); await runner?.stop(); for (const child of children.reverse()) await child.stop()
    await store.close(); await platform.stop(); await it.stop()
  }
}, 180_000)
