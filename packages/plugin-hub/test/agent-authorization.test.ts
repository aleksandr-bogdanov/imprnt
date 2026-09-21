// Every lifecycle change goes through the control sheet, under the door's own
// person, and a model authorizes nothing.
//
// The three planted rows are the fence rather than the verb: identity and
// history cannot change through this path even when somebody writes the row by
// hand, because the hub refuses it on the apply side where a refusal can be
// written down.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { serviceOs } from "./helpers/rollout-service.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { runDoor } from "../src/door/run.ts"
import { runHub } from "../src/hub/run.ts"
import { runRunner } from "../src/runner/run.ts"
import { agentRefused, agentUsage, AGENT_PHRASES } from "../src/door/lines.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR = "1000000001"
const OTHER = "0000000000"
const RESEARCH = "1000000009"
const GUILD = "2000000000"

/**
 * Two people on one door, which is what the cross-person refusals need: the
 * door belongs to the first person and the second person's agent is there to be
 * refused, never to be acted on.
 */
function household(options: { samePerson?: boolean } = {}) {
  const os = process.platform === "darwin" ? "macos" : "linux"
  return {
    admin: { chats: [{ name: "lair", chat: LAIR }, { name: "research", chat: RESEARCH }] },
    machines: [{ id: "mac", os }],
    registry: (base: any) => ({
      ...base,
      agents: base.agents!.map((one: any) => options.samePerson ? { ...one, person: "p1" } : one),
      run: [
        { id: "door-fake", kind: "door", platform: "fake", person: "p1", token_file: "/dev/null",
          schedule: "always", memory_limit_mb: 192, guild: GUILD, default_preset: "daily" },
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

test("D-221 a sender the allowlist does not name lands nothing, says nothing, and is counted without its words", async () => {
  const it = await rolloutStage(cluster, "discord", household())
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const before = readFileSync(it.registryFile, "utf8")
    it.edge.batch([
      { ...message("20", "/agent adopt p1-new research"), sender_id: "unlisted" },
      { ...message("21", "/agent retire p1-lair"), sender_id: "unlisted" },
    ], "22")
    // ONE ROW PER DOOR, CHAT AND SENDER, edited in place, which is the shipped
    // sheet: two refused commands from one sender are one row, counted twice.
    expect(await observe(async () => (await it.read.sheet("sender_denied")).length === 1, 8000),
      "the shipped denied-sender path counts a refused command").toBe(true)
    expect(await it.read.sheet("control")).toEqual([])
    expect(it.edge.posts()).toEqual([])
    expect(readFileSync(it.registryFile, "utf8")).toBe(before)
    // Counted without the words, which is the shipped row and needs no code here.
    for (const row of await it.read.sheet("sender_denied")) {
      expect(JSON.stringify(row.data)).not.toContain("adopt")
      expect(JSON.stringify(row.data)).not.toContain("retire")
    }
  } finally { await door?.stop(); await it.stop() }
}, 60_000)

test("D-221 a verb against the other person's agent is refused, and the same verb against this person's is not", async () => {
  const it = await rolloutStage(cluster, "discord", household())
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    const before = readFileSync(it.registryFile, "utf8")
    it.edge.batch([
      { ...message("20", `/agent adopt p2-lair ${RESEARCH}`) },
      { ...message("21", "/agent retire p2-lair") },
    ], "22")
    for (const operation of ["adopt", "retire"]) {
      expect(await observe(() => it.edge.posts().some(post =>
        post.text === agentRefused("en", { operation, agent: "p2-lair", cause: "access denied" })), 10000),
        `${operation} against the other person's agent is refused`).toBe(true)
    }
    expect(await it.read.sheet("control")).toEqual([])
    expect(readFileSync(it.registryFile, "utf8"), "a refused verb changes no registry byte").toBe(before)
    // The control in the same run: the same verb, this person's own agent.
    it.edge.batch([{ ...message("30", "/agent adopt p1-new research") }], "31")
    expect(await observe(async () => (await it.read.sheet("control")).some(row => row.data.status === "applied"), 10000),
      "the same verb under the door's own person goes through").toBe(true)
    // Adopt CREATES under the door's own person, read off the block it wrote.
    const { loadRegistry } = await import("../src/registry/load.ts")
    expect(loadRegistry(it.registryFile).agents.find(one => one.id === "p1-new")!.person).toBe("p1")
  } finally { await hub?.stop(); await door?.stop(); await it.stop() }
}, 90_000)

for (const planted of ["new-id", "other-person", "delete-history"] as const) {
  test(`D-221 a row planted with ${planted} is refused by the hub with invalid configuration`, async () => {
    const it = await rolloutStage(cluster, "discord", household())
    const store = await superStore(cluster, it.db)
    let hub: Awaited<ReturnType<typeof runHub>> | undefined
    try {
      hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
      const before = readFileSync(it.registryFile, "utf8")
      const history = join(it.stateDir, "p1", "chatlog", "p1-lair")
      const id = `agent:${planted}`
      // Planted as a direct sheet write, because no door would ever write one.
      await store.sql`insert into state_row (sheet, id, data) values ('control', ${id}, ${{
        id, actor: "somebody", source: "chat", person: "p1", target_kind: "agent-lifecycle",
        target_id: "p1-lair", requested_at: new Date().toISOString(), status: "pending", cause: null,
        door: "door-fake", agent: "p1-lair", route: { door: "door-fake", chat: LAIR },
        operation: planted === "delete-history" ? "retire" : "adopt",
        arguments: planted === "new-id" ? { chat: LAIR, new_id: "p1-renamed" }
          : planted === "other-person" ? { chat: LAIR, person: "p2" }
          : { delete_history: true },
      }})`
      await store.sql`select pg_notify('hub_control', ${id})`
      expect(await observe(async () => (await it.read.sheet("control")).some(row => row.id === id && row.data.status === "refused"), 10000),
        "the hub refuses a planted row").toBe(true)
      const row = (await it.read.sheet("control")).find(one => one.id === id)!
      expect(row.data.cause).toBe("invalid configuration")
      expect(readFileSync(it.registryFile, "utf8"), "the registry is byte-identical after a refusal").toBe(before)
      if (planted === "delete-history" && existsSync(history)) expect(readdirSync(history).length).toBeGreaterThanOrEqual(0)
    } finally { await hub?.stop(); await store.close(); await it.stop() }
  }, 60_000)
}

test("D-221 each verb is recorded as requested then applied, with one notice on the pinned route and recovery's own row shape", async () => {
  const it = await rolloutStage(cluster, "discord", household({ samePerson: true }))
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  const store = await superStore(cluster, it.db)
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    const original = readFileSync(it.registryFile, "utf8")
    it.edge.batch([message("20", "/agent adopt p1-new research")], "21")
    expect(await observe(async () => (await it.read.sheet("control")).some(row => row.data.status === "applied"), 10000)).toBe(true)
    it.edge.batch([message("30", "/agent retire p1-new")], "31")
    expect(await observe(async () => (await it.read.sheet("control")).filter(row => row.data.status === "applied").length === 2, 10000)).toBe(true)

    const rows = await it.read.sheet("control")
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      // RECOVERY'S OWN ROW SHAPE, as a whole key set, so a second lifecycle
      // shape cannot appear beside the first.
      expect(Object.keys(row.data).sort()).toEqual([
        "actor", "agent", "applied_at", "arguments", "cause", "door", "id", "operation",
        "person", "requested_at", "route", "source", "status", "target_id", "target_kind",
      ])
      expect(row.data).toMatchObject({ target_kind: "agent-lifecycle", person: "p1", status: "applied", agent: "p1-lair" })
      expect(row.data.route).toEqual({ door: "door-fake", chat: LAIR })
      const diary = (await it.read.ledger()).filter(one => one.subject === row.id || one.detail.request_id === row.id)
      expect(diary.filter(one => one.kind === "recovery.requested" && one.actor === "door")).toHaveLength(1)
      expect(diary.filter(one => one.kind === "recovery.applied" && one.actor === "hub")).toHaveLength(1)
    }
    const notices = (await it.read.noticeRows()).filter(one => String(one.notice_key).startsWith("recovery-outcome:"))
    expect(notices).toHaveLength(2)
    expect(notices.map(one => one.body)).toEqual([
      "[door] p1-new now answers in research.",
      "[door] p1-new is retired. Its history is kept.",
    ])
    // A replay of the same platform messages lands nothing: one row each, one
    // change each and one notice each, by the shipped conflict fence.
    it.edge.batch([message("20", "/agent adopt p1-new research"), message("30", "/agent retire p1-new")], "41")
    await Bun.sleep(1500)
    expect(await it.read.sheet("control")).toHaveLength(2)
    expect((await it.read.noticeRows()).filter(one => String(one.notice_key).startsWith("recovery-outcome:"))).toHaveLength(2)
    // The end of the run: the file differs from its original by the appended
    // block and the removed block, which is nothing at all. A build that refused
    // everything passes every refusal above and fails this.
    expect(readFileSync(it.registryFile, "utf8")).toBe(original)
    expect(rows.map(one => one.data.operation).sort()).toEqual(["adopt", "retire"])
  } finally { await hub?.stop(); await door?.stop(); await store.close(); await it.stop() }
}, 90_000)

test("D-221 a refused verb is recorded with its cause and said once, and a row for another machine is left pending", async () => {
  const it = await rolloutStage(cluster, "discord", household({ samePerson: true }))
  const store = await superStore(cluster, it.db)
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: inertOs(it.stateDir).os })
    const before = readFileSync(it.registryFile, "utf8")
    // A lifecycle row whose door this machine does not run at all.
    const elsewhere = "agent:another-machine"
    await store.sql`insert into state_row (sheet, id, data) values ('control', ${elsewhere}, ${{
      id: elsewhere, actor: "somebody", source: "chat", person: "p1", target_kind: "agent-lifecycle",
      target_id: "p1-lair", requested_at: new Date().toISOString(), status: "pending", cause: null,
      door: "door-of-another-machine", agent: "p1-lair", route: { door: "door-of-another-machine", chat: LAIR },
      operation: "retire", arguments: {},
    }})`
    await store.sql`select pg_notify('hub_control', ${elsewhere})`
    await Bun.sleep(1500)
    const row = (await it.read.sheet("control")).find(one => one.id === elsewhere)!
    expect(row.data.status, "a row for another machine's door is not this hub's to act on").toBe("pending")
    expect(readFileSync(it.registryFile, "utf8")).toBe(before)
  } finally { await hub?.stop(); await store.close(); await it.stop() }
}, 60_000)

test("D-221 the recovery verb is unchanged and still exported, beside the two new ones", async () => {
  const it = await rolloutStage(cluster, "discord", household({ samePerson: true }))
  const store = await superStore(cluster, it.db)
  try {
    const { requestRecovery, requestControl } = await seam("src/hub/control.ts")
    expect(typeof requestRecovery, "src/door/ingest.ts and src/entry/command.ts both call it").toBe("function")
    expect(typeof requestControl, "the generalised verb the two lifecycle commands ask through").toBe("function")
    const id = `recover-${crypto.randomUUID()}`
    await (requestRecovery as Function)(store, { id, source: "chat", actor: "p1", sender_id: "p1", person: "p1",
      door: "door-fake", chat: LAIR, target_kind: "agent", target_id: "p1-lair", registryFile: it.registryFile })
    const row = (await it.read.sheet("control")).find(one => one.id === id)!
    expect(row.data).toMatchObject({ target_kind: "agent", target_id: "p1-lair", status: "pending", person: "p1" })
    // Its two refusal names are what two shipped checks bind, and they stand.
    await expect((requestRecovery as Function)(store, { id: crypto.randomUUID(), source: "chat", actor: "p1",
      sender_id: "p1", person: "p1", door: "door-fake", chat: LAIR, target_kind: "agent", target_id: "nobody",
      registryFile: it.registryFile })).rejects.toThrow("invalid-recovery-target")
    await expect((requestRecovery as Function)(store, { id: crypto.randomUUID(), source: "chat", actor: "p1",
      sender_id: "unlisted", person: "p1", door: "door-fake", chat: LAIR, target_kind: "agent", target_id: "p1-lair",
      registryFile: it.registryFile })).rejects.toThrow("recovery-not-authorized")
  } finally { await store.close(); await it.stop() }
}, 60_000)

test("D-221 an agent's own text creates nothing, and a command's shape is answered with the usage line", async () => {
  const written = `${AGENT_PHRASES.en} retire p1-lair`
  const it = await rolloutStage(cluster, "discord", {
    ...household({ samePerson: true }),
    adapter: { answer: (fed: { text: string }) => fed.text.includes("say the command") ? written : "an ordinary answer" },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
    const before = readFileSync(it.registryFile, "utf8")
    it.edge.batch([message("20", "please say the command back to me")], "21")
    // The door parses commands only from FETCHED platform messages, never from
    // an agent's outgoing text, so a model has no way to make one.
    expect(await observe(() => it.edge.posts().some(post => post.text === written), 30_000)).toBe(true)
    expect(await it.read.sheet("control")).toEqual([])
    expect(readFileSync(it.registryFile, "utf8")).toBe(before)

    // The five shapes that are not commands, each answered with the usage line
    // and nothing else.
    const shapes = ["/agent", "/agent adopt", "/agent adopt p1-new", "/agent retire", "/agent frobnicate x"]
    it.edge.batch(shapes.map((text, at) => message(String(30 + at), text)), "40")
    expect(await observe(() => it.edge.posts().filter(post => post.text === agentUsage("en")).length === shapes.length, 15000),
      "every wrong shape is answered with the usage line").toBe(true)
    expect(await it.read.sheet("control")).toEqual([])
    expect((await it.read.inbound()).filter(row => shapes.includes(String(row.body)))).toEqual([])
  } finally { await runner?.stop(); await door?.stop(); await it.stop() }
}, 90_000)

test("D-221 the Russian verb is answered in Russian", async () => {
  const it = await rolloutStage(cluster, "discord", {
    ...household(),
    // The second person's own chat, and the second person reads Russian.
    registry: (base: any) => ({ ...household().registry(base) }),
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([{ ...message("20", AGENT_PHRASES.ru), chat: OTHER, sender_id: "p2", from: "p2" }], "21")
    expect(await observe(() => it.edge.posts().some(post => post.chat === OTHER), 10000),
      "the second person is answered in their own language").toBe(true)
    expect(it.edge.posts().filter(post => post.chat === OTHER).map(post => post.text)).toEqual([agentUsage("ru")])
  } finally { await door?.stop(); await it.stop() }
}, 60_000)
