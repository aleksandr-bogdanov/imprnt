import assert from "node:assert/strict"
import { rolloutPlatform, type RolloutMessage } from "../test/helpers/rollout-platform.ts"

for (const name of ["telegram", "discord"] as const) {
  const edge = rolloutPlatform(name)
  const message: RolloutMessage = {
    platform_message_id: "1", chat: "1000000001", sender_id: "p1",
    from: "p1", text: "synthetic message", at: "2026-09-17T00:00:00.000Z",
    media: [{ kind: "file", remote_id: "file-1", name: "fixture.txt", mime: "text/plain", bytes: 3, caption: null }],
  }
  const where = { chat: message.chat, cursor: null, timeoutMs: 0 }
  assert.deepEqual(await edge.platform.pull(where), { messages: [], cursor: null })
  edge.batch([], "9007199254740992")
  edge.batch([message], "9007199254740993")
  assert.deepEqual(await edge.platform.pull(where), { messages: [], cursor: "9007199254740992" })
  const accepted = await edge.platform.pull({ ...where, cursor: "9007199254740992" })
  assert.deepEqual(accepted, { messages: [message], cursor: "9007199254740993" })
  assert.deepEqual(await edge.platform.pull({ ...where, cursor: "9007199254740992" }), accepted)
  assert.deepEqual(await edge.platform.pull({ ...where, cursor: accepted.cursor }), { messages: [], cursor: accepted.cursor })
  assert.throws(() => edge.batch([], "2"), /must increase/)
  assert.throws(() => edge.batch([], "invalid"), /invalid synthetic cursor/)
  edge.file("file-1", new Uint8Array([1, 2, 3]))
  assert.deepEqual(new Uint8Array(await (await edge.platform.fetchMedia(message.media[0])).arrayBuffer()), new Uint8Array([1, 2, 3]))
  await assert.rejects(edge.platform.fetchMedia({ ...message.media[0], remote_id: "missing" }), /unavailable/)
  assert.deepEqual(edge.downloads(), ["file-1", "missing"])
  edge.readError(new Error("synthetic read refusal"))
  await assert.rejects(edge.platform.pull(where), /synthetic read refusal/)
  edge.readError(null)
  assert.equal((await edge.platform.pull(where)).cursor, "9007199254740992")
  edge.postError(new Error("synthetic post refusal"))
  await assert.rejects(edge.platform.post({ chat: message.chat, text: "reply" }), /synthetic post refusal/)
  edge.postError(null)
  assert.ok((await edge.platform.post({ chat: message.chat, text: "reply" })).id)
  assert.equal(edge.attempts().length, 2)
  assert.equal(edge.posts().length, 1)
  const snapshot = edge.pulls()
  snapshot.length = 0
  assert.ok(edge.pulls().length > 0)
  console.log(`PASS ${name} fetched batches, integer cursors, replay, media, read and post refusals, observations`)
}
