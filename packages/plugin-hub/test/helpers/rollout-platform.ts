// A fetched-batch edge. Store and cursor work stays in src/.
import { createFakePlatform, type FakeAdminOptions } from "./fake-platform.ts"

export interface RolloutMedia {
  kind: "voice" | "photo" | "file" | "sticker" | "video"
  remote_id: string
  name: string
  mime: string | null
  bytes: number | null
  caption: string | null
}

export interface RolloutMessage {
  platform_message_id: string
  chat: string
  sender_id: string
  from: string
  text: string
  at: string
  media: RolloutMedia[]
}

/**
 * `admin` is passed straight through. UNSET BUILDS THE EDGE EVERY SHIPPED CHECK
 * ALREADY GETS: the platform then carries no administration member at all.
 */
export function rolloutPlatform(name: "telegram" | "discord", admin?: FakeAdminOptions) {
  const base = createFakePlatform({ name, ...(admin === undefined ? {} : { admin }) })
  const batches: { messages: RolloutMessage[], cursor: string }[] = []
  const pulls: { chat: string, cursor: string | null }[] = []
  const downloads: string[] = []
  const files = new Map<string, Uint8Array>()
  let readError: Error | null = null
  let postError: Error | null = null
  const postAttempts: { chat: string, text: string }[] = []
  const platform = {
    ...base.platform,
    async pull(where: { chat: string, cursor: string | null, timeoutMs: number }) {
      pulls.push({ chat: where.chat, cursor: where.cursor })
      if (readError) throw readError
      const after = BigInt(where.cursor ?? "0")
      const next = batches.find(batch => BigInt(batch.cursor) > after)
      // Even replayed HTTP responses yield to the event loop.
      // An ignored batch must not starve the test's bounded observation timer.
      await Bun.sleep(1)
      if (next) return {
        messages: next.messages.filter(message => message.chat === where.chat),
        cursor: next.cursor,
      }
      await Bun.sleep(Math.min(where.timeoutMs, 20))
      return { messages: [], cursor: where.cursor }
    },
    async highWater(_where: { chat: string }) {
      // One cursor across every chat, so where any chat stands is the newest batch.
      if (readError) throw readError
      await Bun.sleep(1)
      return batches.length === 0 ? null : batches.at(-1)!.cursor
    },
    async post(where: { chat: string, text: string }) {
      postAttempts.push({ ...where })
      if (postError) throw postError
      return base.platform.post(where)
    },
    async fetchMedia(media: RolloutMedia) {
      downloads.push(media.remote_id)
      const bytes = files.get(media.remote_id)
      if (!bytes) throw new Error("synthetic-media-unavailable")
      return new Response(bytes)
    },
  }
  return {
    platform,
    batch(messages: RolloutMessage[], cursor: string) {
      if (!/^\d+$/.test(cursor)) throw new Error("invalid synthetic cursor")
      if (batches.length && BigInt(cursor) <= BigInt(batches.at(-1)!.cursor)) {
        throw new Error("synthetic cursor must increase")
      }
      batches.push({ messages: structuredClone(messages), cursor })
    },
    file(id: string, bytes: Uint8Array) { files.set(id, bytes.slice()) },
    readError(error: Error | null) { readError = error },
    postError(error: Error | null) { postError = error },
    pulls: () => structuredClone(pulls),
    downloads: () => [...downloads],
    attempts: () => structuredClone(postAttempts),
    posts: base.posts,
    edits: base.edits,
    typings: base.typings,
    adminCalls: base.adminCalls,
    setResolveAnswer: base.setResolveAnswer,
    setRefuseOnce: base.setRefuseOnce,
    setRefusing: base.setRefusing,
    setAmbiguous: base.setAmbiguous,
    setAbsent: base.setAbsent,
    setDescribed: base.setDescribed,
    renameChat: base.renameChat,
    removeChat: base.removeChat,
  }
}
