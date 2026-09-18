import assert from "node:assert/strict"
import { rolloutFixture } from "../test/helpers/rollout-fixtures.ts"
import { attachment, discordMessage, mediaServer, message, payload, telegramUpdate, wirePlatform } from "../test/helpers/rollout-ingress.ts"
const f = rolloutFixture()
const server = mediaServer()
try {
  for (const name of ["telegram", "discord"] as const) {
    const raw = name === "telegram" ? telegramUpdate(1, { text: "fixture" }) : discordMessage("1", { content: "fixture" })
    const wire = wirePlatform(f.dir, name, () => name === "telegram" ? { ok: true, result: [raw] } : [raw])
    assert.equal((await wire.platform.pull({ chat: message().chat, cursor: null, timeoutMs: 0 })).messages[0].text, "fixture")
    assert.equal(wire.calls.length, 1)
  }
  assert.equal(attachment("1").size, 4)
  assert.equal(message().sender_id, "p1")
  assert.deepEqual(new Uint8Array(await (await fetch(server.url("/bytes"))).arrayBuffer()), payload)
  assert.equal((await fetch(server.url("/expired"))).status, 403)
  assert.equal((await fetch(server.url("/forbidden"), { redirect: "manual" })).headers.get("location"), "http://169.254.169.254/synthetic")
  assert.deepEqual(new Uint8Array(await (await fetch(server.url("/redirect"))).arrayBuffer()), payload)
  assert.equal((await (await fetch(server.url("/streamed"))).arrayBuffer()).byteLength, 8)
  const partial = await fetch(server.url("/partial"))
  // The advertised MediaRef size is four. This response supplies only two.
  assert.equal((await partial.arrayBuffer()).byteLength, 2)
  let completed = false
  const held = fetch(server.url("/held")).then(async response => { completed = true; return response.arrayBuffer() })
  await Bun.sleep(30)
  assert.equal(completed, false)
  server.release()
  assert.equal((await held).byteLength, 4)
  console.log("PASS ingress raw transport, shapes, bytes, redirects, expired URL, partial and streamed responses, held response")
} finally { await server.stop(); f.stop() }
