// Synthetic wire data only. Normalization and ingestion remain production work.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { telegram } from "../../src/door/platforms/telegram.ts"
import { discord } from "../../src/door/platforms/discord.ts"
import type { RolloutMessage } from "./rollout-platform.ts"

export const chat = "1000000001"
export const payload = new Uint8Array([11, 22, 33, 44])
export function message(id = "1", text = "synthetic codeword"): RolloutMessage {
  return { platform_message_id: id, chat, sender_id: "p1", from: "p1", text,
    at: new Date().toISOString(), media: [] }
}
export function wirePlatform(dir: string, name: "telegram" | "discord", answer: (url: URL, body: any) => unknown) {
  const token = "synthetic-token-" + crypto.randomUUID()
  const tokenFile = join(dir, name + ".token")
  writeFileSync(tokenFile, token, { mode: 0o600 })
  const calls: { url: string, body: any }[] = []
  const transport = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
    calls.push({ url: url.href, body })
    const result = await answer(url, body)
    return result instanceof Response ? result : Response.json(result)
  }) as typeof fetch
  return { token, calls, platform: (name === "telegram" ? telegram : discord)({ tokenFile, fetch: transport }) }
}
export function telegramUpdate(id: number, extra: Record<string, unknown> = {}) {
  return { update_id: id, message: { message_id: id, date: Math.floor(Date.now() / 1000),
    chat: { id: chat }, from: { id: "p1", username: "display-only" }, ...extra } }
}
export function discordMessage(id: string, extra: Record<string, unknown> = {}) {
  return { id, timestamp: new Date().toISOString(), author: { id: "p1", username: "display-only" },
    content: "", attachments: [], ...extra }
}
export function attachment(id: string, mime?: string) {
  return { id, filename: "fixture.bin", size: payload.length,
    ...(mime ? { content_type: mime } : {}), url: `https://cdn.discordapp.com/attachments/${chat}/${id}/fixture.bin?signature=synthetic` }
}

export function mediaServer() {
  const requests: string[] = []
  let release = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    const path = new URL(req.url).pathname
    requests.push(path)
    if (path === "/held") await gate
    if (path === "/expired") return new Response("synthetic expired URL", { status: 403 })
    if (path === "/redirect") return new Response(null, { status: 302, headers: { location: "/bytes" } })
    if (path === "/forbidden") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/synthetic" } })
    if (path === "/partial") return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(payload.slice(0, 2))
      controller.close()
    } }), { headers: { "content-length": "4" } })
    if (path === "/streamed") return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(payload)
      controller.enqueue(payload)
      controller.close()
    } }))
    return new Response(payload, { headers: { "content-length": String(payload.length) } })
  } })
  return { url: (path: string) => `http://127.0.0.1:${server.port}${path}`, requests,
    release, async stop() { release(); await server.stop(true) } }
}
