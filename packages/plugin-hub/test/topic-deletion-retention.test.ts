// What a deletion says about its earlier backup copies, against a real store: nothing without the owner's number, "cannot verify" for a
// destination that cannot list and expire, the copies that are this deletion's history for one that can, and "expired" only from receipts of
// copies the destination no longer lists. The store refuses the word on its own, whoever asks.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { deleted } from "./helpers/deletion-fixture.ts"
import { closeStages, removeEffectDirs } from "./helpers/effects-fixture.ts"
import { DOOR, stageTopics } from "./helpers/topics-fixture.ts"
import { deletionFindings } from "../src/check/deletions.ts"
import { trackRetention, type Outcome } from "../src/erasure/retention.ts"
import { readDeletion, receiptsOf, recordRetention } from "../src/store/deletions.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterEach(closeStages)
afterAll(async () => {
  removeEffectDirs()
  await cluster?.stop()
})

const GENERATED = {
  id: "backup-copy", destination: "/dest",
  upload_argv: ["/fake/up", "{staging}/", "{destination}/{generation}"], readback_argv: ["/fake/read", "{destination}", "{generation}", "{path}", "{out}"],
  list_argv: ["/fake/list", "{destination}"], expire_argv: ["/fake/expire", "{destination}", "{generation}"],
}

test("a deletion's account of its earlier copies follows the owner's number and what the destination can do, and says expired only for copies shown gone", async () => {
  const s = await stageTopics(cluster)
  const topic = await deleted(s)
  const store = s.as("hub_hub")
  const [row] = await s.admin`select id, deletion_generation from topic_deletion where topic_id = ${topic.id}`
  const op = String(row.id)
  const confirmedAt = Number(row.deletion_generation)
  const state = async () => (await readDeletion(store, op))!

  const said = async (): Promise<string[]> =>
    (await deletionFindings({ store, machine: "pi", now: new Date(), doors: new Set([DOOR]) })).map(one => one.kind).filter(kind => kind.startsWith("backup-retention"))

  // The owner configured nothing when this was asked for, and nothing has been configured since: nothing is counted, nothing is recorded,
  // and `check` says the earlier copies have no expiry date.
  expect((await state()).retention_state).toBe("not_configured")
  expect(await trackRetention(store, GENERATED, { days: null, outcomes: null })).toBe(0)
  expect((await state()).retention_state).toBe("not_configured")
  expect(await said()).toEqual(["backup-retention-not-configured"])

  // A number, and a destination that can neither list nor expire: the earlier copies are said to remain, with the reason.
  expect(await trackRetention(store, { id: "backup-copy" }, { days: 30, outcomes: null })).toBe(1)
  const unverified = await state()
  expect(unverified.retention_state).toBe("retention_unverified")
  expect(String(unverified.retention_detail.reason)).toContain("none of them can list the copies it holds or remove one")
  expect(await said()).toEqual(["backup-retention-unverified"])
  // The same verdict again is not written again.
  expect(await trackRetention(store, { id: "backup-copy" }, { days: 30, outcomes: null })).toBe(0)

  // A destination that can: the copies made BEFORE this deletion are its history, one receipt each; the one made after is not.
  const copy = (id: string, state: Outcome["state"], generation: number, expires: string): Outcome => ({ id, state, expires_at: expires, erasure_generation: generation })
  let outcomes = [
    copy("20260901T000000Z", "pending", confirmedAt - 1, "2026-10-01T00:00:00.000Z"),
    copy("20260905T000000Z", "pending", confirmedAt, "2026-10-05T00:00:00.000Z"),
  ]
  expect(await trackRetention(store, GENERATED, { days: 30, outcomes })).toBe(1)
  const tracking = await state()
  expect(tracking.retention_state).toBe("tracking")
  expect(tracking.backup_retention_until?.toISOString()).toBe("2026-10-01T00:00:00.000Z")
  expect((await receiptsOf(store, op, { historical: true })).map(one => `${one.class}:${one.location}:${one.state}`)).toEqual(["backup_generation:20260901T000000Z:pending"])
  // The word is refused by the store while a copy of that history is not shown gone, whoever asks for it.
  expect(await recordRetention(store, op, { state: "historical_copies_expired" })).toBe("unverified")
  expect((await state()).retention_state).toBe("tracking")
  // A copy the destination cannot be made to remove is a blocked retention, with its date, and not an expired one.
  outcomes = [{ ...outcomes[0], state: "retention_blocked" }, outcomes[1]]
  expect(await trackRetention(store, GENERATED, { days: 30, outcomes })).toBe(1)
  expect((await state()).retention_state).toBe("retention_blocked")
  expect(await said()).toEqual(["backup-retention-blocked"])

  // Shown gone by the destination's own listing: now, and only now, it is expired.
  outcomes = [{ ...outcomes[0], state: "expired" }, outcomes[1]]
  expect(await trackRetention(store, GENERATED, { days: 30, outcomes })).toBe(1)
  const expired = await state()
  expect(expired.retention_state).toBe("historical_copies_expired")
  expect(await said(), "nothing is left to say once every earlier copy is shown gone").toEqual([])
  expect((await receiptsOf(store, op, { historical: true })).map(one => one.state)).toEqual(["expired"])
  // And it stays so: a later run that finds nothing of that history left does not take it back, or write it again.
  expect(await trackRetention(store, GENERATED, { days: 30, outcomes: [] })).toBe(0)
  expect((await state()).retention_state).toBe("historical_copies_expired")
  // The active deletion was complete the whole time: the retention is its own account, and never held it up.
  expect(expired.stage).toBe("active_deleted")
}, 120_000)
