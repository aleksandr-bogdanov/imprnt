// The real runner settles and the real door delivers to a synthetic edge.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { appendFileSync } from "node:fs"
import { startCluster, seam, until, statementWatch, untilIssued, type Cluster } from "./helpers/cluster.ts"
import { stageHub } from "./helpers/hub-fixture.ts"
import { rolloutPlatform } from "./helpers/rollout-platform.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster({ settings: { log_statement: "'all'", log_line_prefix: "'pid=%p '", log_min_duration_statement: "-1" } }) })
afterAll(async () => { if (cluster) await cluster.stop() })

test("ROLL-08 long and empty answers are visible ordered parts and permanent refusal stops retries", async () => {
  // This oracle control uses the same splitter acceptance predicate as the body.
  const long = "a".repeat(1999) + "😀" + "b".repeat(6400)
  for (const name of ["discord", "telegram"] as const) {
    const limit = name === "discord" ? 2000 : 4000
    expect(() => expect([long].every(part => part.length > 0 && part.length <= limit)).toBe(true)).toThrow()
    const it = await stageHub(cluster, {
      language: "en",
      adapter: { answer: () => long },
      hub: { tick_seconds: 1 },
      registry: base => ({ ...base, agents: base.agents!.map(one => ({ ...one, runner: "runner-pi" })) }),
    })
    appendFileSync(it.registryFile, '\n[people.allowed_senders]\ndoor-fake = ["p1"]\n')
    const edge = rolloutPlatform(name)
    let door: { stop(): Promise<void> } | undefined
    let runner: { stop(): Promise<void> } | undefined
    try {
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: edge.platform })
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
      edge.batch([{
        platform_message_id: "1", chat: "1000000001", sender_id: "p1", from: "p1",
        text: "synthetic long answer request", at: new Date().toISOString(), media: [],
      }], "2")
      await until("the long reply is settled", async () => (await it.read.outbox()).length > 0, 10_000)
      const parts = (await it.read.outbox()).map(row => row.body)
      expect(parts.every(part => part.length > 0 && part.length <= limit)).toBe(true)
      expect(parts.join("")).toBe(long)
      expect(parts.some(part => /[\uD800-\uDBFF]$/.test(part) || /^[\uDC00-\uDFFF]/.test(part))).toBe(false)
      await until("all long reply parts are delivered", async () => (await it.read.outbox()).every(row => row.delivered_at !== null), 10_000)
      expect(edge.posts().filter(post => parts.includes(post.text)).map(post => post.text)).toEqual(parts)
      it.scripted.setAnswer(() => " \n\t")
      edge.batch([{
        platform_message_id: "2", chat: "1000000001", sender_id: "p1", from: "p1",
        text: "synthetic empty answer request", at: new Date().toISOString(), media: [],
      }], "3")
      await until("an empty answer has a visible outcome", () => edge.posts().some(post => post.text === "[door] the agent returned an empty answer. Please try again."), 10_000)
      const { classifyPlatformError } = await seam("src/door/reply.ts")
      expect(typeof classifyPlatformError).toBe("function")
      it.scripted.setAnswer(() => "permanently refused synthetic reply")
      const denied = Object.assign(new Error("synthetic access denied"), { status: 403, code: "access-denied" })
      edge.postError(denied)
      edge.batch([{
        platform_message_id: "3", chat: "1000000001", sender_id: "p1", from: "p1",
        text: "synthetic refused delivery request", at: new Date().toISOString(), media: [],
      }], "4")
      await until("permanent refusal is recorded", async () => {
        const rows = await it.read.sql("select delivery_state from outbox where body = $1", ["permanently refused synthetic reply"])
        return rows[0]?.delivery_state === "failed"
      }, 10_000)
      const failed = await it.read.sql("select attempts, failure, delivered_at from outbox where body = $1", ["permanently refused synthetic reply"])
      expect(failed[0].delivered_at).toBeNull()
      expect(Number(failed[0].attempts)).toBe(1)
      expect(JSON.stringify(failed[0].failure)).toContain("access")
      const attempts = edge.attempts().filter(one => one.text === "permanently refused synthetic reply").length
      await Bun.sleep(1200)
      expect(edge.attempts().filter(one => one.text === "permanently refused synthetic reply").length).toBe(attempts)
      // Scoped faulty classification. The permanent classifier must reject retrying it.
      const classify = classifyPlatformError as (error: unknown) => { kind: string }
      expect(classify(denied).kind).toBe("permanent")
      edge.postError(null)
      expect((await edge.platform.post({ chat: "1000000001", text: "same route after repair" })).id).not.toBeNull()
    } finally {
      await runner?.stop()
      await door?.stop()
      await it.stop()
    }
  }
})

// Independent checks keep a missing splitter from masking the other contracts.
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { deliveryEdge, proveDeliveryEdge } from "./helpers/rollout-delivery.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { appendNotice } from "../src/store/outbox.ts"
beforeAll(async () => { await proveDeliveryEdge(); console.log("H05 delivery edge standalone proof passed") })

for (const platform of ["discord", "telegram"] as const) {
  for (const language of ["en", "ru"] as const) {
    test(`ROLL-08 prepareReply ${platform} ${language} UTF-16 bounds, content and empty outcome`, async () => {
      const mod = await seam("src/door/reply.ts")
      expect(typeof mod.prepareReply).toBe("function")
      const prepare = mod.prepareReply as (text: string, platform: string, language: string) => string[]
      const bound = platform === "discord" ? 2000 : 4000
      for (const text of ["a".repeat(bound), "a".repeat(bound - 1) + "😀" + "\n b".repeat(bound), "😀".repeat(bound * 2)]) {
        const parts = prepare(text, platform, language)
        const accept = (parts: string[]) => {
          expect(parts.length).toBeGreaterThan(0)
          expect(parts.every(part => part.length > 0 && part.length <= bound)).toBe(true)
          expect(parts.join("")).toBe(text)
          expect(parts.some(part => /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part))).toBe(false)
        }
        if (text.length > bound) expect(() => accept([text])).toThrow()
        accept(parts)
      }
      const visible = (parts: string[]) => expect(parts).toEqual([language === "en"
        ? "[door] the agent returned an empty answer. Please try again."
        : "[дверь] агент вернул пустой ответ. Попробуйте ещё раз."])
      expect(() => visible([])).toThrow()
      for (const empty of ["", " \n\t"]) visible(prepare(empty, platform, language))
    })
  }
}

test("ROLL-08 classifier distinguishes definitive refusal, transient failure and unknown receipt", async () => {
  const mod = await seam("src/door/reply.ts")
  expect(typeof mod.classifyPlatformError).toBe("function")
  const classify = mod.classifyPlatformError as (error: unknown) => { kind: string, code: string, cause: string }
  for (const status of [403, 404]) expect(classify(Object.assign(new Error("access denied"), { status })).kind).toBe("permanent")
  expect(classify(Object.assign(new Error("rate limited"), { status: 429 })).kind).toBe("transient")
  expect(classify(new Error("generic network failure")).kind).not.toBe("permanent")
  expect(classify(Object.assign(new Error("delivery outcome unknown"), { code: "ETIMEDOUT", sent: true })).kind).toBe("uncertain")
})

for (const platform of ["telegram", "discord"] as const) for (const kind of ["permanent", "transient", "uncertain"] as const) for (const samePerson of [true, false]) {
  test(`ROLL-08 ROLL-29 ${platform} ${kind} ${samePerson ? "same-person route" : "no private route"} first-part refusal survives restart with bounded attempts and no overtaking`, async () => {
    const it = await rolloutStage(cluster, platform, { registry: spec => ({ ...spec, agents: spec.agents!.map(agent => samePerson && agent.id === "p2-lair" ? { ...agent, person: "p1" } : agent) }) })
    const edge = deliveryEdge(platform)
    let stderr = ""
    const capture = spyOn(process.stderr, "write").mockImplementation(((chunk: any) => { stderr += String(chunk); return true }) as any)
    const token = "synthetic-secret-" + crypto.randomUUID()
    edge.postFault("1000000001", Object.assign(new Error(`${kind === "uncertain" ? "delivery outcome unknown" : "access denied"} Authorization: Bearer ${token} https://example.invalid/media?token=${token}`),
      kind === "permanent" ? { status: 403 } : kind === "transient" ? { status: 503 } : { code: "ETIMEDOUT", sent: true }), kind === "uncertain")
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      // A settled reply with two already prepared parts. No model or fixture
      // synthesizes delivery state, retry deadlines, causes, or stamps.
      await it.read.sql("insert into inbound (id, person, agent, body, state) values ('reply-case', 'p1', 'p1-lair', 'synthetic request', 'answered')")
      await it.read.sql("insert into outbox (inbound_id, seq_in_reply, body) values ('reply-case', 1, 'first part'), ('reply-case', 2, 'later part')")
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: edge.platform })
      expect(await observe(() => edge.sends.some(row => row.text === "first part")), "delivery attempts the settled first part").toBe(true)
      const columns = (await it.read.sql("select column_name from information_schema.columns where table_name = 'outbox'")).map(row => row.column_name)
      expect(columns, "D-174 durable delivery attempts missing").toContain("attempts")
      const rows = () => it.read.sql("select * from outbox where inbound_id = 'reply-case' order by seq_in_reply")
      expect(await observe(async () => Number((await rows())[0].attempts) >= 1), "first delivery attempt is durable").toBe(true)
      const before = (await rows())[0]
      if (kind !== "permanent") expect(before.retry_at).toBeTruthy()
      await door.stop()
      // Everything the restarted door says to the server, from before it
      // starts, so the quiet window below can open after the last of it.
      const settle = await statementWatch(cluster, [await it.read.pid()])
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: edge.platform })
      expect(await observe(async () => (await rows())[0].delivery_state === "failed", 6000), "D-174 refusal must terminate within configured attempt budget").toBe(true)
      const stopped = edge.sends.filter(row => row.text === "first part")
      const expected = kind === "permanent" ? 1 : 3
      const bounded = (attempts: number) => expect(attempts, "F08 unchanged refused reply cannot retry forever").toBeLessThanOrEqual(expected)
      expect(() => bounded(expected + 1)).toThrow()
      bounded(stopped.length)
      expect(stopped).toHaveLength(expected)
      for (let i = 1; i < stopped.length; i++) expect(stopped[i].at - stopped[i - 1].at).toBeGreaterThanOrEqual(900)
      // Prove the actual server log sees a foreign statement before opening the window.
      const observerPid = await it.read.pid()
      const fault = cluster.connectAs("hub_door", it.db)
      try {
        const probe = await statementWatch(cluster, [observerPid])
        await fault.unsafe("select 1 as synthetic_poll")
        expect(await observe(async () => (await probe.count()) > 0), "poll observer must detect an injected foreign query").toBe(true)
        const positiveCount = await probe.count()
        expect(() => expect(positiveCount, "polling control rejected by the zero-SQL oracle").toBe(0)).toThrow()
      } finally { await fault.close() }
      // The terminal failure is visible before the door has finished with it:
      // after that update it still records the failure in the diary, and on a
      // same-person route writes the notice, wakes both post loops of the
      // person to read, and posts and marks the notice. On a slow runner the
      // tail of that landed inside the window (CI, PR 31), so the window opens
      // only once all of it is observed.
      await until("the door finished what the terminal failure set off", async () => {
        const failures = await it.read.sql("select count(*)::int as n from ledger_event where stream = 'operation' and kind = 'failed' and subject = 'door-fake/1000000001'")
        if (Number(failures[0].n) !== expected) return false
        if (!samePerson) return true
        const notice = await it.read.sql("select delivered_at from outbox where kind = 'notice'")
        return notice.length === 1 && notice[0].delivered_at !== null
      }, 10_000)
      // Each post loop's first read after the restart, and, where this door
      // wrote the notice, each loop's read on the notification it caused.
      await untilIssued(settle, "both post loops read their pending replies after the restart", /from outbox o\b/, { after: /listen hub_outbox/, times: 2 })
      if ((await settle.lines()).some(line => line.includes("hub_door_notice"))) {
        await untilIssued(settle, "both post loops read again on the notice's notification", /from outbox o\b/, { after: /hub_door_notice/, times: 2 })
      }
      await Bun.sleep(100)
      const quiet = await statementWatch(cluster, [observerPid])
      await Bun.sleep(1200)
      expect(await quiet.count(), "D-174 terminal failures arm no database polling timer").toBe(0)
      expect(edge.sends.filter(row => row.text === "first part")).toHaveLength(expected)
      expect(edge.sends.filter(row => row.text === "later part")).toHaveLength(0)
      const failed = (await rows())[0]
      expect(Number(failed.attempts)).toBe(expected)
      expect(failed.delivered_at).toBeNull()
      expect(failed.retry_at).toBeNull()
      expect(failed.failure).toBeTruthy()
      const cause = (data: unknown) => expect(JSON.stringify(data), "F29 post cause must remain queryable").toContain(kind === "uncertain" ? "unknown" : "access")
      expect(() => cause(null)).toThrow()
      cause(failed.failure)
      cause(stderr)
      expect(stderr).toContain("door-fake")
      expect(stderr).toContain("1000000001")
      expect(stderr).not.toContain(token)
      expect(stderr).not.toContain("https://example.invalid/media")
      const notices = edge.posts().filter(row => row.text.includes("p1-lair") && row.text.includes("[door]"))
      if (samePerson) {
        expect(notices).toHaveLength(1)
        expect(notices[0].chat).toBe("0000000000")
      } else expect(notices).toHaveLength(0)
      expect(JSON.stringify(failed.failure)).not.toContain(token)
      expect(JSON.stringify(failed.failure)).not.toContain("https://example.invalid/media")
      expect(await it.read.sql("select * from ledger_event where subject = 'reply-case' and kind = 'delivered'")).toHaveLength(0)
      if (kind === "uncertain") expect(edge.posts().filter(row => row.text === "first part").length).toBeGreaterThan(0)
      // Repair control proves the same transport path can succeed. Ambiguous
      // receipt fixture intentionally permits duplicates and asserts no exactly-once claim.
      edge.postFault("1000000001", null)
      expect((await edge.platform.post({ chat: "1000000001", text: "repaired route" })).id).toBeTruthy()
    } finally { edge.release(); await door?.stop(); capture.mockRestore(); await it.stop() }
  })
}

for (const platform of ["discord", "telegram"] as const) {
  test(`ROLL-08 ${platform} machinery notice preparation stores ordered deterministic parts once`, async () => {
    const it = await rolloutStage(cluster, platform)
    const store = await superStore(cluster, it.db)
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      const mod = await seam("src/door/reply.ts")
      expect(typeof mod.prepareReply).toBe("function")
      const text = "[door] " + "😀 x".repeat(3000)
      const acceptNotice = (parts: string[]) => {
        expect(parts.length).toBeGreaterThan(1)
        expect(parts.every(p => p.length > 0 && p.length <= (platform === "discord" ? 2000 : 4000)), "L03 independent notice bound").toBe(true)
        expect(parts.join("")).toBe(text)
        expect(parts.some(p => /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(p))).toBe(false)
      }
      expect(() => acceptNotice([text])).toThrow()
      // appendNotice owns preparation and deterministic keys, rather than the test
      // inserting pre-split rows and pretending to test production preparation.
      for (let n = 0; n < 2; n++) await (appendNotice as Function)(store, { person: "p1", agent: "p1-lair", body: text, noticeKey: "synthetic-long-notice", platform, language: "en", route: { door: "door-fake", chat: "1000000001" } })
      const rows = await it.read.noticeRows()
      const parts = rows.map(row => row.body)
      acceptNotice(parts)
      expect(new Set(rows.map(row => row.notice_key)).size).toBe(parts.length)
      expect(rows.map(row => row.body).join("")).toBe(text)
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      expect(await observe(async () => (await it.read.noticeRows()).every(row => row.delivered_at !== null)), "D-174 every notice part delivers").toBe(true)
      expect(it.edge.posts().map(row => row.text)).toEqual(parts)
    } finally { await door?.stop(); await store.sql.close(); await it.stop() }
  })
}

for (const platform of ["discord", "telegram"] as const) for (const empty of [false, true]) {
  test(`ROLL-08 ${platform} runner settles ${empty ? "empty replacement" : "long Unicode answer"} and door delivers exact ordered parts`, async () => {
    const text = empty ? " \n\t" : "a".repeat(1999) + "😀" + " b\n".repeat(3000)
    const it = await rolloutStage(cluster, platform, { agents: [], adapter: { answer: () => text } })
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
      it.edge.batch([{ platform_message_id: "1", chat: "1000000001", sender_id: "p1", from: "p1", text: "synthetic answer request", at: new Date().toISOString(), media: [] }], "2")
      expect(await observe(async () => (await it.read.inbound()).some(row => row.state === "answered" || row.state === "delivered")), "runner completed answer settlement").toBe(true)
      const rows = (await it.read.outbox()).filter(row => row.inbound_id !== null)
      const parts = rows.map(row => row.body)
      const visible = (value: string[]) => {
        expect(value.length, "D-174 settled answer must have visible nonempty parts").toBeGreaterThan(0)
        expect(value.every(part => part.trim().length > 0 && part.length <= (platform === "discord" ? 2000 : 4000)), "D-174 settled parts obey platform bound").toBe(true)
        expect(value.join(""), "D-174 empty answer gets pinned replacement").toBe(empty ? "[door] the agent returned an empty answer. Please try again." : text)
      }
      expect(() => visible(empty ? [] : [text])).toThrow()
      visible(parts)
      expect(rows.map(row => row.seq_in_reply)).toEqual(parts.map((_, index) => index + 1))
      expect(parts.some(part => /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part))).toBe(false)
      expect(await observe(async () => (await it.read.outbox()).every(row => row.delivered_at !== null)), "D-174 prepared answer reaches platform").toBe(true)
      expect(it.edge.posts().filter(row => parts.includes(row.text)).map(row => row.text)).toEqual(parts)
    } finally { await runner?.stop(); await door?.stop(); await it.stop() }
  })
}

test("ROLL-08 Forbidden permanent refusal reclassified as transient must fail the attempt-count oracle", async () => {
  for (const defective of [true, false]) {
    const it = await rolloutStage(cluster, "telegram", { agents: [] })
    const edge = deliveryEdge()
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      // The transport wrapper deliberately lies about a definitive refusal.
      // Both branches run the same real delivery loop and the same bounded oracle.
      edge.postFault("1000000001", Object.assign(new Error("access denied"), { status: defective ? 503 : 403 }))
      await it.read.sql("insert into inbound (id, person, agent, body, state) values ('terminal-control', 'p1', 'p1-lair', 'synthetic request', 'answered')")
      await it.read.sql("insert into outbox (inbound_id, seq_in_reply, body) values ('terminal-control', 1, 'terminal reply')")
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: edge.platform })
      expect(await observe(() => edge.sends.some(row => row.text === "terminal reply"))).toBe(true)
      await Bun.sleep(2300)
      const bounded = () => expect(edge.sends.filter(row => row.text === "terminal reply"), "F08 permanent refusal must stop after one attempt").toHaveLength(1)
      if (defective) expect(bounded).toThrow()
      else bounded()
      edge.postFault("1000000001", null)
      expect((await edge.platform.post({ chat: "1000000001", text: "same path without refusal" })).id).toBeTruthy()
    } finally { await door?.stop(); await it.stop() }
  }
})
