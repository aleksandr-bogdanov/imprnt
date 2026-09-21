// The platform-read half of a chat's health.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { deliveryEdge, proveDeliveryEdge } from "./helpers/rollout-delivery.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { runDoor } from "../src/door/run.ts"
import { runCheck } from "../src/check/run.ts"

let cluster: Cluster
beforeAll(async () => { await proveDeliveryEdge(); console.log("H05 delivery edge standalone proof passed"); cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

for (const platform of ["telegram", "discord"] as const) for (const [status, cause] of [[403, "access denied"], [404, "chat missing"]] as const) {
  for (const samePerson of [true, false]) {
    test(`ROLL-21 ROLL-29 ${platform} ${status} read failure, ${samePerson ? "same-person route" : "no private route"}, retry and successful-read recovery`, async () => {
      const it = await rolloutStage(cluster, platform, {
        machines: [{ id: "pi", os: "linux" }],
        run: [{ id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null" }, { id: "runner-pi", kind: "runner", machine: "pi", child_memory_limit_mb: 256 }],
        registry: spec => ({ ...spec, agents: spec.agents!.map(agent => agent.id === "p2-lair" && samePerson ? { ...agent, person: "p1" } : agent) }),
      })
      const edge = deliveryEdge(platform)
      const secret = "synthetic-secret-" + crypto.randomUUID()
      edge.readFault("1000000001", Object.assign(new Error(`${cause} Authorization: Bearer ${secret} https://example.invalid/media?token=${secret}`), { status }))
      let stderr = ""
      const capture = spyOn(process.stderr, "write").mockImplementation(((chunk: any) => { stderr += String(chunk); return true }) as any)
      const store = await superStore(cluster, it.db)
      let door: Awaited<ReturnType<typeof runDoor>> | undefined
      try {
        door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: edge.platform })
        expect(await observe(async () => (await it.read.sheet("door_health")).some(row => JSON.stringify(row).includes(cause))), "D-174 failed read must persist chat cause").toBe(true)
        const failed = (await it.read.sheet("door_health")).find(row => JSON.stringify(row).includes(cause))!
        expect(JSON.stringify(failed)).toContain("1000000001")
        expect(JSON.stringify(failed)).toContain("door-fake")
        expect(failed.data.retry_at).toBeTruthy()
        expect(failed.data.since).toBeTruthy()
        expect(JSON.stringify(failed)).not.toContain(secret)
        expect(JSON.stringify(failed)).not.toContain("https://example.invalid/media")
        const check = () => runCheck({ machine: "pi", registryFile: it.registryFile, store, os: null, kernel: null,
          credentials: { open: async () => ({ ok: true }), secrets: async () => [secret] } })
        const actionable = (rows: unknown[]) => {
          const found = rows.filter(row => JSON.stringify(row).includes(cause) && JSON.stringify(row).includes("1000000001"))
          expect(found, "F21 healthy process or token cannot hide a failed chat read").not.toHaveLength(0)
          expect(JSON.stringify(found)).toContain("door-fake")
          expect(JSON.stringify(found)).not.toContain(secret)
        }
        // F21 control: a token/process-only checker drops exactly the chat finding.
        const findings = await check()
        expect(() => actionable(findings.filter(row => !JSON.stringify(row).includes(cause)))).toThrow()
        actionable(findings)
        await Bun.sleep(2300)
        const reads = edge.reads.filter(row => row.chat === "1000000001")
        expect(reads.length).toBeGreaterThan(1)
        for (let n = 1; n < reads.length; n++) expect(reads[n].at - reads[n - 1].at).toBeGreaterThanOrEqual(900)
        const notices = edge.posts().filter(post => post.text.includes("p1-lair") && post.text.includes("[door]"))
        if (samePerson) {
          expect(notices).toHaveLength(1)
          expect(notices[0].chat).toBe("0000000000")
        } else {
          expect(notices).toHaveLength(0)
          expect(stderr).toContain(cause)
          expect(stderr).toContain("door-fake")
          expect(stderr).toContain("1000000001")
        }
        expect(stderr).not.toContain(secret)
        expect(stderr).not.toContain("https://example.invalid/media")
        // Credentials are already healthy. Only an actual successful read clears.
        const release = edge.hold("1000000001")
        edge.readFault("1000000001", null)
        try { await Bun.sleep(1200); actionable(await check()) } finally { release() }
        expect(await observe(async () => !(await check()).some(row => JSON.stringify(row).includes(cause) && JSON.stringify(row).includes("1000000001"))), "D-174 repaired chat successful read clears finding").toBe(true)
        const healthy = JSON.stringify(await it.read.sheet("door_health"))
        await Bun.sleep(100)
        expect(JSON.stringify(await it.read.sheet("door_health"))).toBe(healthy)
      } finally { edge.release(); await door?.stop(); capture.mockRestore(); await store.sql.close(); await it.stop() }
    })
  }
}

test("ROLL-21 Forbidden healthy token and process cannot conceal a stored failed chat read", async () => {
  const it = await rolloutStage(cluster, "telegram", { machines: [{ id: "pi", os: "linux" }],
    run: [{ id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null" }, { id: "runner-pi", kind: "runner", machine: "pi", child_memory_limit_mb: 256 }] })
  const store = await superStore(cluster, it.db)
  try {
    const { putRow, removeRow } = await import("../src/records/statesheet.ts")
    await putRow(store, "door_health", "door-fake/1000000001", { door: "door-fake", chat: "1000000001", code: "access-denied", cause: "access denied", since: new Date().toISOString(), retry_at: new Date(Date.now() + 30000).toISOString() })
    const check = () => runCheck({ machine: "pi", registryFile: it.registryFile, store, os: null, kernel: null, credentials: { open: async () => ({ ok: true }), secrets: async () => [] } })
    const predicate = (rows: unknown[]) => expect(JSON.stringify(rows), "F21 runCheck must reject token-only health").toContain("access denied")
    expect(() => predicate([])).toThrow()
    predicate(await check())
    await removeRow(store, "door_health", "door-fake/1000000001")
    expect(JSON.stringify(await check())).not.toContain("access denied")
  } finally { await store.sql.close(); await it.stop() }
})

// A platform blip that heals on the next retry is written down at once and said
// to nobody. A transient failure that outlasts the grace is said once, the same
// way a refused chat is said at once.
for (const platform of ["telegram", "discord"] as const) {
  test(`ROLL-21 ${platform} a transient read failure is announced only after the grace, once`, async () => {
    const it = await rolloutStage(cluster, platform, {
      machines: [{ id: "pi", os: "linux" }],
      run: [{ id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null" }, { id: "runner-pi", kind: "runner", machine: "pi", child_memory_limit_mb: 256 }],
      registry: spec => ({ ...spec, agents: spec.agents!.map(agent => agent.id === "p2-lair" ? { ...agent, person: "p1" } : agent) }),
    })
    writeFileSync(it.registryFile, readFileSync(it.registryFile, "utf8").replace("read_notice_after_seconds = 1", "read_notice_after_seconds = 3"))
    const edge = deliveryEdge(platform)
    const blip = () => Object.assign(new Error("upstream connect error or disconnect/reset before headers"), { status: 503 })
    const capture = spyOn(process.stderr, "write").mockImplementation((() => true) as any)
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    const health = async () => (await it.read.sheet("door_health")).find(row => row.id === "door-fake/1000000001")
    const notices = () => edge.posts().filter(post => post.text.includes("p1-lair") && post.text.includes("[door]"))
    try {
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: edge.platform })
      expect(await observe(async () => (await health())?.data.status === "healthy"), "the chat is read before the blip").toBe(true)
      edge.readFault("1000000001", blip())
      expect(await observe(async () => (await health())?.data.status === "failed"), "the blip is written down at once").toBe(true)
      expect((await health())!.data.kind).toBe("transient")
      edge.readFault("1000000001", null)
      expect(await observe(async () => (await health())?.data.status === "healthy", 6000), "the next read heals it").toBe(true)
      await Bun.sleep(3500)
      expect(notices(), "a blip that healed inside the grace says nothing").toHaveLength(0)

      edge.readFault("1000000001", blip())
      expect(await observe(async () => (await health())?.data.status === "failed"), "the second failure is written down at once").toBe(true)
      await Bun.sleep(1000)
      expect(notices(), "still inside the grace").toHaveLength(0)
      expect(await observe(async () => notices().length > 0, 8000), "a failure that outlasts the grace is said").toBe(true)
      await Bun.sleep(2500)
      expect(notices(), "one notice per episode").toHaveLength(1)
      expect(notices()[0].chat).toBe("0000000000")
      expect(notices()[0].text, "the notice names the agent, not a platform id").not.toContain("1000000001")
    } finally { edge.readFault("1000000001", null); edge.release(); await door?.stop(); capture.mockRestore(); await it.stop() }
  })
}
