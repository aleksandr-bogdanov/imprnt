// Transport faults and receipts only. No delivery or health policy lives here.
import { strict as assert } from "node:assert"
import { rolloutPlatform } from "./rollout-platform.ts"

export function deliveryEdge(name: "telegram" | "discord" = "telegram") {
  const edge = rolloutPlatform(name)
  const reads: { chat: string, at: number }[] = []
  const sends: { chat: string, text: string, at: number }[] = []
  const faults = new Map<string, Error>()
  const posts = new Map<string, { error: Error, accepted: boolean }>()
  const holds = new Map<string, { promise: Promise<void>, release(): void, text?: string }>()
  const held = new Set<string>()
  const active = new Map<string, number>()
  const peak = new Map<string, number>()
  const pull = edge.platform.pull
  const post = edge.platform.post
  edge.platform.pull = async where => {
    reads.push({ chat: where.chat, at: Date.now() })
    active.set(where.chat, (active.get(where.chat) ?? 0) + 1)
    peak.set(where.chat, Math.max(peak.get(where.chat) ?? 0, active.get(where.chat)!))
    try {
      // Capture a fetched batch before releasing its response to the door.
      const result = await pull(where)
      const hold = holds.get(where.chat)
      if (hold && (!hold.text || result.messages.some(row => row.text === hold.text))) {
        held.add(where.chat)
        try { await hold.promise } finally { held.delete(where.chat) }
      }
      if (faults.has(where.chat)) throw faults.get(where.chat)
      return result
    } finally { active.set(where.chat, active.get(where.chat)! - 1) }
  }
  edge.platform.post = async where => {
    sends.push({ ...where, at: Date.now() })
    const fault = posts.get(where.chat)
    if (fault?.accepted) await post(where)
    if (fault) throw fault.error
    return post(where)
  }
  return { ...edge, reads, sends, active, peak, held,
    readFault(chat: string, error: Error | null) { if (error) faults.set(chat, error); else faults.delete(chat) },
    postFault(chat: string, error: Error | null, accepted = false) { if (error) posts.set(chat, { error, accepted }); else posts.delete(chat) },
    hold(chat: string, text?: string) {
      if (holds.has(chat)) throw new Error("synthetic route already held")
      let release!: () => void
      const promise = new Promise<void>(resolve => { release = resolve })
      holds.set(chat, { promise, release, text })
      return () => { release(); holds.delete(chat) }
    },
    release() { for (const hold of holds.values()) hold.release(); holds.clear() },
  }
}

// Standalone proof uses no door, database, health or delivery implementation.
export async function proveDeliveryEdge() {
  const edge = deliveryEdge()
  const denied = Object.assign(new Error("synthetic forbidden"), { status: 403 })
  edge.readFault("0000000000", denied)
  await assert.rejects(edge.platform.pull({ chat: "0000000000", cursor: null, timeoutMs: 1 }), /forbidden/)
  edge.readFault("0000000000", null)
  const release = edge.hold("0000000000")
  let done = false
  const pending = edge.platform.pull({ chat: "0000000000", cursor: null, timeoutMs: 1 }).then(() => { done = true })
  await Bun.sleep(10)
  assert.equal(done, false)
  assert.equal(edge.active.get("0000000000"), 1)
  assert.equal(edge.held.has("0000000000"), true)
  release()
  await pending
  assert.equal(done, true)
  edge.postFault("0000000000", denied)
  await assert.rejects(edge.platform.post({ chat: "0000000000", text: "definitive refusal" }))
  assert.equal(edge.posts().length, 0)
  edge.postFault("0000000000", new Error("delivery outcome unknown"), true)
  await assert.rejects(edge.platform.post({ chat: "0000000000", text: "accepted but receipt lost" }))
  assert.equal(edge.posts().length, 1)
  edge.postFault("0000000000", null)
  await edge.platform.post({ chat: "0000000000", text: "repaired route" })
  assert.equal(edge.posts().length, 2)
  assert.equal(edge.sends.length, 3)
  assert.equal(edge.peak.get("0000000000"), 1)
  assert.equal(edge.active.get("0000000000"), 0)
  const targeted = deliveryEdge()
  const releaseTarget = targeted.hold("0000000000", "held text")
  await targeted.platform.pull({ chat: "0000000000", cursor: null, timeoutMs: 1 })
  assert.equal(targeted.held.size, 0)
  targeted.batch([{ platform_message_id: "1", chat: "0000000000", sender_id: "p1", from: "p1", text: "held text", at: new Date().toISOString(), media: [] }], "2")
  const response = targeted.platform.pull({ chat: "0000000000", cursor: null, timeoutMs: 1 })
  try { await Bun.sleep(10); assert.equal(targeted.held.has("0000000000"), true) } finally { releaseTarget() }
  assert.equal((await response).messages[0].text, "held text")
}
