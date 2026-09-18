// D-173, D-183, ROLL-15. A refused sender leaves a trace, and `check` reads it.
//
// The door refuses a message from a sender the allowlist does not name before
// anything is saved (D-173), which is right, and until now the refusal left
// nothing at all: no inbound row, no chat log line, no finding. `check` notices
// silence only through inbound rows, and the shipped example registry starts
// with an empty allowlist, so a misconfigured allowlist looked exactly like a
// quiet chat. D-183: "Unauthorized senders receive no reply. Their rejection can
// be counted without storing their message content."
//
// So the DOOR writes one content-free row per refused sender on a door and chat,
// and `check` reports it while that sender is still off the list, and it reports
// an agent whose allowlist is empty or absent in its own right, because that
// agent can never answer anyone. `check` stays a pure read of the ledger: the
// row is written by the door, never by `check`.
//
// The controls: an allowed sender leaves no row and gets no finding, an agent
// with a listed sender gets no allowlist finding, and a sender who is added to
// the list stops being reported.
//
// Red reasons: behaviour absent. `acceptBatch` skips a refused sender with a
// bare `continue`, and `runCheck` has neither finding.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { seam, startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { chat, message } from "./helpers/rollout-ingress.ts"
import { fakeProber } from "./helpers/prober.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import type { Finding } from "./helpers/finding.ts"
import { runDoor } from "../src/door/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const SHEET = "sender_denied"
const STRANGER = "p9"
const CODEWORD = "codeword-that-must-never-be-stored"

async function findings(it: { registryFile: string, db: string }, kind: string, now = new Date()): Promise<Finding[]> {
  const { runCheck } = await seam("src/check/run.ts")
  const store = await superStore(cluster, it.db)
  try {
    return ((await (runCheck as Function)({ machine: "pi", registryFile: it.registryFile, store,
      os: null, kernel: null, credentials: fakeProber({}), now })) as Finding[]).filter(one => one.kind === kind)
  } finally { await store.close().catch(() => {}) }
}

for (const name of ["telegram", "discord"] as const) {
  test(`D-173 ${name} a refused sender leaves a content-free row at the door, check reports it until the sender is listed, and an allowed sender leaves neither`, async () => {
    const it = await rolloutStage(cluster, name)
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      // THE CONTROL SENDER. p1 is on p1's allowlist for this door.
      it.edge.batch([message("1", "listed sender control")], "2")
      expect(await observe(async () => (await it.read.inbound()).length === 1), "listed sender accepted").toBe(true)
      const refused = { ...message("2", CODEWORD), sender_id: STRANGER, from: "a-display-name" }
      it.edge.batch([refused], "3")
      expect(await observe(() => it.edge.pulls().some(p => p.chat === chat && p.cursor === "3"), 15000), "refused batch fetched").toBe(true)
      expect(await observe(async () => (await it.read.sheet(SHEET)).length > 0, 5000), "D-183 the refusal leaves a durable row").toBe(true)
      await door.stop()
      door = undefined

      // Still refused: no work, no reply (ROLL-15 is unchanged by the trace).
      expect((await it.read.inbound()).filter(row => row.id.endsWith(":2"))).toEqual([])

      // ONE row, for the refused sender and nobody else, carrying who and where
      // and when, and never the text or the display name.
      const rows = await it.read.sheet(SHEET)
      expect(rows.map(row => row.id)).toEqual([`door-fake/${chat}/${STRANGER}`])
      const data = rows[0].data
      expect(data.door).toBe("door-fake")
      expect(data.chat).toBe(chat)
      expect(data.sender_id).toBe(STRANGER)
      expect(data.person).toBe("p1")
      expect(data.agent).toBe("p1-lair")
      expect(data.last_at).toBe(refused.at)
      expect(JSON.stringify(rows)).not.toContain(CODEWORD)
      expect(JSON.stringify(rows)).not.toContain("a-display-name")
      expect(JSON.stringify(await it.read.ledger())).not.toContain(CODEWORD)

      // `check` reports it, and reading it changes nothing in the ledger.
      const ledgerBefore = (await it.read.ledger()).length
      const denied = await findings(it, "sender-denied")
      expect((await it.read.ledger()).length, "check is a pure read of the ledger").toBe(ledgerBefore)
      expect(denied.map(one => one.subject), "only the refused sender, never the allowed one").toEqual([`door-fake/${chat}/${STRANGER}`])
      expect(denied[0].id).toBe(`pi/sender-denied:door-fake/${chat}/${STRANGER}`)
      expect(denied[0].says).toContain(STRANGER)
      expect(denied[0].says).toContain("door-fake")
      expect(denied[0].fix).toContain("allowed_senders")
      expect(denied[0].fix).toContain(it.registryFile)
      expect(denied[0].says + denied[0].fix).not.toContain(CODEWORD)

      // A refusal nobody has repeated for longer than the report window is
      // not reported for ever: a stranger who wrote once is not a standing
      // problem. The same row inside the window still is.
      const later = new Date(Date.parse(refused.at) + 8 * 86_400_000)
      expect(await findings(it, "sender-denied", later), "an old refusal ages out").toEqual([])

      // Listing the sender is the fix, and the finding clears.
      const original = readFileSync(it.registryFile, "utf8")
      writeFileSync(it.registryFile, original.replace('door-fake = ["p1"]', `door-fake = ["p1", "${STRANGER}"]`))
      expect(await findings(it, "sender-denied"), "a sender now listed is not reported").toEqual([])
    } finally { await door?.stop(); await it.stop() }
  }, 90_000)
}

test("D-171 an agent whose allowlist is empty or absent can answer nobody and is a finding, and an agent with a listed sender is not", async () => {
  const it = await rolloutStage(cluster, "telegram")
  try {
    // THE CONTROL. Both people list a sender on the one door.
    expect(await findings(it, "allowlist-empty")).toEqual([])

    const original = readFileSync(it.registryFile, "utf8")
    // p2's allowlist absent.
    writeFileSync(it.registryFile, original.replace('allowed_senders = { door-fake = ["p2"] }\n', ""))
    const absent = await findings(it, "allowlist-empty")
    expect(absent.map(one => one.subject)).toEqual(["p2-lair"])
    expect(absent[0].id).toBe("pi/allowlist-empty:p2-lair")
    expect(absent[0].says).toContain("p2-lair")
    expect(absent[0].fix).toContain("allowed_senders")
    expect(absent[0].fix).toContain("door-fake")
    expect(absent[0].fix).toContain(it.registryFile)

    // p1's allowlist present and empty is the same finding.
    writeFileSync(it.registryFile, original
      .replace('allowed_senders = { door-fake = ["p2"] }\n', "")
      .replace('door-fake = ["p1"]', "door-fake = []"))
    expect((await findings(it, "allowlist-empty")).map(one => one.subject).sort()).toEqual(["p1-lair", "p2-lair"])
  } finally { await it.stop() }
}, 90_000)
