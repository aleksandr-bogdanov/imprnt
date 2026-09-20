// Wire normalization, saved files and full door/runner effects.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs"
import { join } from "node:path"
import { startCluster, seam, type Cluster } from "./helpers/cluster.ts"
import { rolloutFixture } from "./helpers/rollout-fixtures.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { attachment, chat, discordMessage, mediaServer, message, payload, telegramUpdate, wirePlatform } from "./helpers/rollout-ingress.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"
let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const file = { file_id: "large", file_unique_id: "unique", file_size: 4, file_name: "fixture.bin", mime_type: "application/octet-stream" }
const telegramCases: [string, Record<string, unknown>, string][] = [
  ["voice", { voice: file }, "voice"], ["audio", { audio: file }, "voice"],
  ["photo ladder", { photo: [{ ...file, file_id: "small", width: 10, height: 10, file_size: 1 }, { ...file, width: 100, height: 100 }] }, "photo"],
  ["document", { document: file }, "file"], ["image", { document: { ...file, mime_type: "image/png" } }, "photo"],
  ["sticker", { sticker: file }, "sticker"], ["video", { video: file }, "video"], ["video note", { video_note: file }, "voice"],
]
for (const [label, extra, kind] of telegramCases) test(`ROLL-01 Telegram ${label} retains media, stable sender and caption`, async () => {
  const f = rolloutFixture()
  try {
    const wire = wirePlatform(f.dir, "telegram", () => ({ ok: true, result: [telegramUpdate(1, { ...extra, caption: "synthetic caption" })] }))
    const pulled = await wire.platform.pull({ chat, cursor: null, timeoutMs: 0 })
    expect(pulled.messages).toHaveLength(1)
    const actual = pulled.messages[0] as any
    expect(actual.media, `D-166 Telegram ${label} must normalize media`).toHaveLength(1)
    expect(actual.media[0]).toMatchObject({ kind, remote_id: "large", caption: "synthetic caption" })
    expect(actual.sender_id).toBe("p1")
  } finally { f.stop() }
})
for (const [label, content, mimes] of [
  ["attachment-only", "", ["image/png"]], ["mixed ordered attachments", "synthetic caption", ["image/png", "audio/ogg", "video/mp4", "application/pdf"]],
  ["audio", "", ["audio/mpeg"]], ["unknown MIME", "", [undefined]],
] as [string, string, (string | undefined)[]][]) test(`ROLL-01 Discord ${label} retains every attachment in wire order`, async () => {
  const f = rolloutFixture()
  try {
    const attachments = mimes.map((mime, index) => attachment(String(index + 1), mime))
    const wire = wirePlatform(f.dir, "discord", () => [discordMessage("1", { content, attachments })])
    const pulled = await wire.platform.pull({ chat, cursor: null, timeoutMs: 0 })
    expect(pulled.messages, "D-166 attachment-only Discord input must survive").toHaveLength(1)
    const actual = pulled.messages[0] as any
    expect(actual.media?.map((m: any) => m.kind), "D-166 Discord normalized media order").toEqual(mimes.map(mime => mime?.startsWith("image/") ? "photo" : mime?.startsWith("audio/") ? "voice" : mime?.startsWith("video/") ? "video" : "file"))
    expect(actual.media.map((m: any) => m.remote_id)).toEqual(attachments.map(a => a.id))
    expect(actual.text).toBe(content)
    expect(actual.sender_id).toBe("p1")
  } finally { f.stop() }
})

test("ROLL-01 Discord native sticker_items survive wire normalization", async () => {
  const f = rolloutFixture()
  try {
    const wire = wirePlatform(f.dir, "discord", () => [discordMessage("1", {
      content: "", attachments: [], sticker_items: [{ id: "42", name: "synthetic-sticker", format_type: 1 }],
    })])
    const rows = (await wire.platform.pull({ chat, cursor: null, timeoutMs: 0 })).messages as any[]
    const accepts = (rows: any[]) => {
      expect(rows).toHaveLength(1)
      expect(rows[0].media).toMatchObject([{ kind: "sticker", remote_id: "42", name: "synthetic-sticker" }])
    }
    expect(() => accepts([])).toThrow()
    accepts(rows)
  } finally { f.stop() }
})

for (const hazard of ["declared oversize", "streamed oversize", "traversal", "symlink", "truncated", "expired"] as const) test(`ROLL-01 saveMedia ${hazard} yields an honest descriptor and repaired input saves bytes`, async () => {
  const f = rolloutFixture()
  const server = mediaServer()
  try {
    const { saveMedia } = await seam("src/door/media.ts")
    expect(typeof saveMedia, "D-166 saveMedia export").toBe("function")
    const save = saveMedia as (options: any) => Promise<{ path: string, failed: boolean }>
    const id = "telegram:1000000001:1"
    const media = { kind: "file", remote_id: "fixture", name: hazard === "traversal" ? "../../escape.txt" : "fixture.bin", mime: "application/octet-stream", bytes: hazard === "declared oversize" ? 99 : hazard === "streamed oversize" ? null : 4, caption: null }
    const outside = join(f.dir, "outside")
    mkdirSync(outside)
    const inbox = join(f.stateDir, "p1", "inbox")
    mkdirSync(join(f.stateDir, "p1"), { recursive: true })
    if (hazard === "symlink") symlinkSync(outside, inbox)
    const endpoint = hazard === "streamed oversize" ? "/streamed" : hazard === "truncated" ? "/partial" : hazard === "expired" ? "/expired" : "/bytes"
    const input = { stateDir: f.stateDir, person: "p1", inboundId: id, index: 0, media, maxBytes: 6,
      platform: { fetchMedia: () => fetch(server.url(endpoint)) } }
    if (hazard === "symlink") {
      await expect(save(input)).rejects.toThrow()
      expect(readdirSync(outside)).toEqual([])
      // Same writable destination without the symlink must succeed.
      const { unlinkSync } = await import("node:fs")
      unlinkSync(inbox)
    } else {
      const failed = await save(input)
      expect(failed.failed, "D-166 unsafe or incomplete media is not a fetched file").toBe(true)
      const descriptor = readFileSync(failed.path, "utf8")
      expect(descriptor).toContain(media.name)
      expect(descriptor).not.toContain(server.url(endpoint))
    }
    const good = await save({ ...input, inboundId: id + "-repaired", media: { ...media, name: "fixture.bin", bytes: 4 }, platform: { fetchMedia: () => fetch(server.url("/bytes")) } })
    expect(good.failed).toBe(false)
    expect(new Uint8Array(readFileSync(good.path))).toEqual(payload)
    expect(good.path).toStartWith(join(f.stateDir, "p1", "inbox") + "/")
    expect(existsSync(join(f.stateDir, "escape.txt"))).toBe(false)
  } finally { await server.stop(); f.stop() }
})

for (const name of ["telegram", "discord"] as const) for (const language of ["en", "ru"] as const) for (const kind of ["voice", "photo", "file", "sticker", "video"] as const) for (const failed of (kind === "voice" ? [false, true] : [false])) test(`ROLL-01 ${name} ${language} ${failed ? "failed download" : kind} answers once with five stamps and localized notice after replay`, async () => {
  const it = await rolloutStage(cluster, name, { people: [{ id: "p1", language }, { id: "p2", language: "ru" }] })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    // Failure and success share the identical message and model path.
    const input = { ...message("1", ""), media: [{ kind, remote_id: "voice", name: "fixture.ogg", mime: "audio/ogg", bytes: 4, caption: "synthetic caption" }] }
    if (!failed) it.edge.file("voice", payload)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
    it.edge.batch([input], "2")
    expect(await observe(async () => (await it.read.inbound()).length === 1)).toBe(true)
    const row = (await it.read.inbound())[0]
    const content = (body: string, count: number) => {
      expect(count, "D-166 one accepted media row").toBe(1)
      expect(body, "D-166 media body must name a saved path").toMatch(/\((voice|photo|file|sticker|video|голосовое сообщение|фото|файл|стикер|видео) \/[^)]+\)/)
      expect(body).toContain("synthetic caption")
    }
    // The two forbidden substitutes both fail the real content predicate.
    expect(() => content("", 1)).toThrow()
    expect(() => content("", 0)).toThrow()
    content(row.body, (await it.read.inbound()).length)
    const path = row.body.match(/\((?:voice|photo|file|sticker|video|голосовое сообщение|фото|файл|стикер|видео) ([^)]+)\)/)![1]
    expect(existsSync(path)).toBe(true)
    if (!failed) expect(new Uint8Array(readFileSync(path))).toEqual(payload)
    else expect(readFileSync(path, "utf8")).toContain("fixture.ogg")
    expect(await observe(async () => (await it.read.ledger({ subject: row.id })).some(e => e.kind === "delivered")), "D-166 answered and delivered media").toBe(true)
    expect((await it.read.ledger({ subject: row.id })).filter(e => ["received", "acked", "started", "answered", "delivered"].includes(e.kind)).map(e => e.kind)).toEqual(["received", "acked", "started", "answered", "delivered"])
    const answers = (await it.read.outbox()).filter(r => r.inbound_id === row.id).map(r => r.body)
    expect(answers.length).toBeGreaterThan(0)
    const posted = (posts: { chat: string, text: string }[]) => expect(posts.filter(p => answers.includes(p.text)).map(p => [p.chat, p.text]), "L02 actual media answer posts").toEqual(answers.map(text => [chat, text]))
    expect(() => posted([])).toThrow()
    posted(it.edge.posts())
    await door.stop()
    // Deliberate HTTP redelivery despite the saved cursor.
    const base = it.edge.platform.pull
    let replay = true
    it.edge.platform.pull = async where => replay && where.chat === chat ? (replay = false, { messages: [input], cursor: "2" }) : base(where)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    await Bun.sleep(200)
    posted(it.edge.posts())
    expect(await it.read.inbound()).toHaveLength(1)
    expect(chatLogLines(it.stateDir, "p1", "p1-lair").filter(l => l.direction === "in")).toHaveLength(1)
    const notices = await it.read.noticeRows()
    const expected = language === "en"
      ? failed ? "[door] I could not save voice. Please send it again." : "[door] voice notes are not transcribed yet, please type it."
      : failed ? "[дверь] не удалось сохранить голосовое сообщение. Отправьте ещё раз." : "[дверь] голосовые сообщения пока не расшифровываются, напишите текстом."
    expect(notices.filter(n => n.body === expected)).toHaveLength(kind === "voice" ? 1 : 0)
    expect(notices.every(n => !!n.notice_key)).toBe(true)
    expect(it.scripted.fed().some(f => f.text.includes(path))).toBe(true)
    const allText = row.body + JSON.stringify(chatLogLines(it.stateDir, "p1", "p1-lair"))
    expect(allText).not.toContain("https://")
    expect(allText).not.toContain("Authorization:")
  } finally { await runner?.stop(); await door?.stop(); await it.stop() }
})

for (const destination of ["http://169.254.169.254/synthetic", "http://127.0.0.1/synthetic", "https://unapproved.invalid/synthetic"]) test(`ROLL-01 Discord refuses redirect destination ${new URL(destination).hostname} and permits the original CDN`, async () => {
  const f = rolloutFixture()
  const server = mediaServer()
  try {
    let redirect = true
    const seen: string[] = []
    const wire = wirePlatform(f.dir, "discord", async url => {
      seen.push(url.href)
      if (url.pathname.includes("/messages")) return [discordMessage("1", { attachments: [attachment("1", "image/png")] })]
      if (url.hostname !== "cdn.discordapp.com") throw new Error("synthetic forbidden destination reached")
      return redirect ? new Response(null, { status: 302, headers: { location: destination } }) : fetch(server.url("/bytes"))
    })
    const platform = wire.platform as any
    expect(typeof platform.fetchMedia, "D-166 platform media fetch seam").toBe("function")
    const media = (await platform.pull({ chat, cursor: null, timeoutMs: 0 })).messages[0].media[0]
    await expect(platform.fetchMedia(media)).rejects.toThrow()
    expect(seen).not.toContain(destination)
    redirect = false
    expect(new Uint8Array(await (await platform.fetchMedia(media)).arrayBuffer())).toEqual(payload)
  } finally { await server.stop(); f.stop() }
})

for (const os of ["linux", "darwin"]) if (process.platform !== os) console.log(`SKIP: requires ${os === "linux" ? "Linux" : "macOS"} (ROLL-01 ${os} saved inbox native box)` )
for (const os of ["linux", "darwin"]) test.skipIf(process.platform !== os)(`ROLL-01 ${os} saved media is readable through the person box${process.platform !== os ? ` SKIP: requires ${os === "linux" ? "Linux" : "macOS"}` : ""}`, async () => {
  const { loopFixture, nativeWrap, fileProbe } = await import("./helpers/rollout-loop.ts")
  const { boxContextFor } = await import("../src/box/index.ts")
  const f = loopFixture()
  let box: ReturnType<typeof nativeWrap> | undefined
  try {
    const { saveMedia } = await seam("src/door/media.ts")
    expect(typeof saveMedia).toBe("function")
    const media = { kind: "photo", remote_id: "fixture", name: "fixture.png", mime: "image/png", bytes: 4, caption: "synthetic caption" }
    const result = await (saveMedia as Function)({ stateDir: f.stateDir, person: "p1", inboundId: `telegram:${chat}:1`, index: 0, media, maxBytes: 20,
      platform: { fetchMedia: async () => new Response(payload) } })
    expect(new Uint8Array(readFileSync(result.path))).toEqual(payload)
    box = nativeWrap(boxContextFor(f.registry(), "p1-lair"))
    expect(fileProbe([], result.path, "read").code).toBe(0)
    const command = box.wrap(["/bin/sh", "-c", 'cat "$1"', "sh", result.path])
    const probe = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe", timeout: 5000 })
    expect(probe.exitCode, "D-166 saved inbox readable inside person box").toBe(0)
    expect(new Uint8Array(probe.stdout)).toEqual(payload)
    expect(result.path).not.toContain("synthetic-token")
    expect(result.path).not.toContain("https:")
  } finally { box?.stop(); f.stop() }
})

test("ROLL-01 media failure descriptor and chat body redact the token and expiring URL", async () => {
  const f = rolloutFixture()
  try {
    const { saveMedia } = await seam("src/door/media.ts")
    expect(typeof saveMedia).toBe("function")
    const secret = "synthetic-token-" + crypto.randomUUID()
    const url = `https://cdn.discordapp.com/attachments/${chat}/1/fixture.bin?signature=${secret}`
    const input = { stateDir: f.stateDir, person: "p1", inboundId: `discord:${chat}:1`, index: 0, maxBytes: 20,
      media: { kind: "file", remote_id: "fixture", name: "fixture.bin", mime: null, bytes: 4, caption: null },
      platform: { fetchMedia: async () => { throw new Error(`Authorization: Bot ${secret} fetch ${url} expired`) } } }
    const failed = await (saveMedia as Function)(input)
    expect(failed.failed).toBe(true)
    const safe = (text: string) => { expect(text).not.toContain(secret); expect(text).not.toContain(url); expect(text).not.toContain("Authorization:") }
    expect(() => safe(`Authorization: Bot ${secret} ${url}`)).toThrow()
    safe(readFileSync(failed.path, "utf8"))
    safe(JSON.stringify(failed))
    const good = await (saveMedia as Function)({ ...input, inboundId: `discord:${chat}:2`, platform: { fetchMedia: async () => new Response(payload) } })
    expect(good.failed).toBe(false)
    expect(new Uint8Array(readFileSync(good.path))).toEqual(payload)
  } finally { f.stop() }
})

test("ROLL-01 durable media retry verifies existing bytes and refetches a corrupted file", async () => {
  const f = rolloutFixture()
  try {
    const { saveMedia } = await seam("src/door/media.ts")
    expect(typeof saveMedia).toBe("function")
    let downloads = 0
    const options = { stateDir: f.stateDir, person: "p1", inboundId: `telegram:${chat}:1`, index: 0, maxBytes: 20,
      media: { kind: "file", remote_id: "fixture", name: "fixture.bin", mime: "application/octet-stream", bytes: 4, caption: null },
      platform: { fetchMedia: async () => { downloads++; return new Response(payload) } } }
    const first = await (saveMedia as Function)(options)
    expect(first.failed).toBe(false)
    const count = downloads
    expect(count).toBe(1)
    const repeated = await (saveMedia as Function)(options)
    expect(repeated.path).toBe(first.path)
    expect(downloads).toBe(count)
    expect(new Uint8Array(readFileSync(repeated.path))).toEqual(payload)
    const { writeFileSync } = await import("node:fs")
    writeFileSync(first.path, new Uint8Array([0, 0, 0, 0]))
    const verified = (path: string) => expect(new Uint8Array(readFileSync(path)), "D-166 cached media must be verified").toEqual(payload)
    expect(() => verified(first.path)).toThrow()
    const repaired = await (saveMedia as Function)(options)
    expect(downloads).toBe(count + 1)
    verified(repaired.path)
  } finally { f.stop() }
})
