// An agent whose door is on another machine is served its chat from the store,
// and an agent whose own state root on THIS machine cannot be read is refused
// before any model starts.
//
// WHY ONE IS SERVED AND THE OTHER REFUSED. A cross-machine agent reads no local
// path at all: its lines come out of the store, so there is nothing about the
// placement to refuse and refusing it would be refusing the transport. The
// other case is this machine's own directory, which the runner does read, and a
// root that exists and cannot be read would leave a session fed an empty chat
// in silence.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { CHAT, stageHub, insertInbound } from "./helpers/hub-fixture.ts"
import { controlledAdapter, observe } from "./helpers/rollout-runner.ts"
import { proveRolloutRunner } from "../live/prove-rollout-runner.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { await proveRolloutRunner(); cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

for (const problem of ["cross-machine", "inaccessible-root"] as const) test(`ROLL-09 ROLL-14 D-182 ${problem} ${problem === "cross-machine" ? "is served from the store" : "refuses before model start"} while local absent log works`, async () => {
  for (const refused of [false, true]) {
    const it = await stageHub(cluster, {
      machines: [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
      run: [
        { id: "runner-pi", machine: "pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 150 },
        { id: "door-fake", machine: refused && problem === "cross-machine" ? "mac" : "pi", kind: "door", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      ],
      registry: base => ({ ...base, agents: base.agents!.map(a => ({ ...a, runner: "runner-pi" })) }),
    })
    // A regular file where a directory is required is inaccessible even when
    // the test account can bypass chmod. It is owned scratch data, not a mock.
    if (refused && problem === "inaccessible-root") writeFileSync(join(it.stateDir, "p1"), "not a state directory")
    else mkdirSync(join(it.stateDir, "p1"), { recursive: true })
    // The message the cross-machine agent is served: a store row with the
    // platform's own record on it, and no file anywhere near this runner.
    if (refused && problem === "cross-machine") {
      const at = new Date().toISOString()
      await insertInbound(cluster, it.db, { id: "from-the-store", body: "linden-honey", receivedAt: at,
        source: { log_id: "from-the-store", at, door: "door-fake", chat: CHAT, sender_id: "fixture-sender", text: "linden-honey" } })
    }
    const edge = controlledAdapter(it.adapterName)
    let runner: Awaited<ReturnType<typeof runRunner>> | undefined
    try {
      let error = ""
      try { runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: edge.adapter } }) }
      catch (caught) { error = String(caught) }
      if (!refused) {
        expect(error).toBe("")
        await insertInbound(cluster, it.db, { id: "local", body: "absent log is valid" })
        expect(await observe(async () => (await it.read.outbox()).some(r => r.inbound_id === "local"))).toBe(true)
        expect(edge.sessions.length).toBe(1)
      } else if (problem === "cross-machine") {
        // Served, not refused: the door is on the other machine and the lines
        // it wrote are in the store, so the tail is fed from there.
        expect(error).toBe("")
        expect(await observe(() => edge.sessions.length === 1 && edge.sessions[0].fed.length > 0)).toBe(true)
        expect(edge.sessions[0].fed[0].text).toContain("linden-honey")
        const detail = JSON.stringify(await it.read.sheet("agent_health")) + JSON.stringify(await it.read.ledger()) + error
        expect(detail).not.toContain("agent-state-unavailable")
        expect(edge.sessions.length).toBe(1)
      } else {
        const detail = JSON.stringify(await it.read.sheet("agent_health")) + JSON.stringify(await it.read.ledger()) + error
        expect(detail, "D-182 named agent-state-unavailable before model start").toContain("agent-state-unavailable")
        expect(edge.sessions.length).toBe(0)
      }
    } finally {
      await runner?.stop(); await edge.stop()
      if (refused && problem === "inaccessible-root") rmSync(join(it.stateDir, "p1"), { force: true })
      await it.stop()
    }
  }
})
