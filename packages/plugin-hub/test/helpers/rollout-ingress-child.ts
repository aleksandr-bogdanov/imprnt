// Runs only inside rollout-crash-child. Scoped faults never affect another test.
import * as fs from "node:fs"
import * as promises from "node:fs/promises"
import { mock } from "bun:test"
import { rolloutPlatform } from "./rollout-platform.ts"
import { openStore } from "../../src/store/connect.ts"
import * as inbound from "../../src/store/inbound.ts"
import * as cursor from "../../src/door/cursor.ts"
import * as chatlog from "../../src/chatlog.ts"

export async function ingressChild(config: any, barrier: () => void) {
  const log = (event: string, detail: unknown = null) => fs.appendFileSync(config.trace, JSON.stringify({ event, detail }) + "\n")
  const open = fs.openSync
  const sync = fs.fsyncSync
  const opened = new Map<number, string>()
  const openAsync = promises.open
  const rename = fs.renameSync
  const renameAsync = promises.rename
  mock.module("node:fs/promises", () => ({ ...promises,
    open: async (...args: any[]) => {
      const handle = await (openAsync as Function)(...args)
      log("open", { path: String(args[0]), flags: args[1] })
      const syncHandle = handle.sync.bind(handle)
      handle.sync = async () => { await syncHandle(); log((await handle.stat()).isDirectory() ? "directory-sync" : "file-sync", String(args[0])) }
      return handle
    },
    rename: async (from: string, to: string) => { await renameAsync(from, to); log("rename", { from, to }) },
  }))
  mock.module("node:fs", () => ({ ...fs,
    openSync: (...args: any[]) => { const fd = (open as Function)(...args); opened.set(fd, String(args[0])); log("open", { path: String(args[0]), flags: args[1] }); return fd },
    renameSync: (from: string, to: string) => { rename(from, to); log("rename", { from, to }) },
    fsyncSync: (fd: number) => {
      sync(fd)
      log(fs.fstatSync(fd).isDirectory() ? "directory-sync" : "file-sync", opened.get(fd) ?? null)
    },
  }))
  const enqueue = inbound.enqueueInbound
  const write = cursor.writeCursor
  const append = chatlog.appendChatLine
  const appendOnce = (chatlog as any).appendChatLineOnce
  const wrappedEnqueue = async (store: any, row: any) => {
    const fresh = await enqueue(store, row)
    if (row.id === config.id && config.point === "accepted-commit") { log("uncommitted", row.id); barrier() }
    return fresh
  }
  const wrappedCursor = async (store: any, door: string, chat: string, value: string) => {
    if (chat === config.message.chat && config.point === "demand-before-cursor") { log("before-cursor"); barrier() }
    await write(store, door, chat, value)
    if (chat === config.message.chat && config.point === "demand-after-cursor") { log("after-cursor"); barrier() }
  }
  const project = (fn: Function) => async (ctx: any, line: any) => {
    if (ctx.agent === "p1-lair" && line.direction === "in" && config.point === "projection") { log("before-projection"); barrier() }
    return fn(ctx, line)
  }
  mock.module("../../src/store/inbound.ts", () => ({ ...inbound, enqueueInbound: wrappedEnqueue }))
  mock.module("../../src/door/cursor.ts", () => ({ ...cursor, writeCursor: wrappedCursor }))
  mock.module("../../src/chatlog.ts", () => ({ ...chatlog, appendChatLine: project(append),
    ...(appendOnce ? { appendChatLineOnce: project(appendOnce) } : {}) }))
  const store = await openStore({ url: config.url })
  if (config.earlyCursor) await write(store, "door-fake", config.message.chat, "2")
  const edge = rolloutPlatform(config.platform ?? "telegram")
  edge.file("fixture", new Uint8Array([11, 22, 33, 44]))
  if (config.point === "media-save") edge.platform.fetchMedia = async () => { log("download-entered"); barrier(); throw new Error("unreachable") }
  if (config.proof) {
    const io = await import("node:fs")
    for (const path of [config.stateDir + "/proof-bytes", config.stateDir]) {
      const fd = io.openSync(path, path.endsWith("proof-bytes") ? "wx" : "r")
      if (path.endsWith("proof-bytes")) io.writeSync(fd, "proof")
      io.fsyncSync(fd)
      io.closeSync(fd)
    }
    const asyncIo = await import("node:fs/promises")
    const handle = await asyncIo.open(config.stateDir + "/proof-async", "wx")
    await handle.writeFile("proof")
    await handle.sync()
    await handle.close()
    io.renameSync(config.stateDir + "/proof-bytes", config.stateDir + "/proof-renamed")
    await asyncIo.rename(config.stateDir + "/proof-async", config.stateDir + "/proof-async-renamed")
    if (config.point === "media-save") await edge.platform.fetchMedia(config.message.media[0])
    else if (config.point === "accepted-commit") await store.sql.begin(async sql => wrappedEnqueue({ ...store, sql }, { id: config.id, person: "p1", agent: "p1-lair", body: "proof" }))
    else if (config.point === "projection") await project(append)({ stateDir: config.stateDir, person: "p1", agent: "p1-lair" }, { direction: "in", text: "proof" })
    else await wrappedCursor(store, "door-fake", config.message.chat, "2")
    return
  }
  const { runDoor } = await import("../../src/door/run.ts")
  await runDoor({ door: "door-fake", registryFile: config.registryFile, platform: edge.platform })
  edge.batch([config.message], "2")
}
