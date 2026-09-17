// Only launched by the bounded, shipped startReadySubprocess helper.
import * as fs from "node:fs"
import { mock } from "bun:test"
import { openStore } from "../../src/store/connect.ts"
import { enqueueInbound } from "../../src/store/inbound.ts"

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"))
function barrier() {
  console.log(JSON.stringify({ ready: true, pid: process.pid, point: config.point }))
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}
const sync = fs.fsyncSync
// Stop AFTER the bytes are appended but BEFORE their fsync acknowledgement.
if (config.point === "append-before-fsync") {
  mock.module("node:fs", () => ({ ...fs, fsyncSync: (fd: number) => {
    const stat = fs.fstatSync(fd)
    if (stat.isFile() && stat.size > 0 && fs.existsSync(config.file) && stat.ino === fs.statSync(config.file).ino) barrier()
    sync(fd)
  } }))
}
try {
  if (config.mode === "migration") {
    const module = await import("../../src/migrate/handoff.ts" as string)
    await module.applyHandoff(config.manifest, { registryFile: config.registryFile })
  } else if (config.mode === "delivery") {
    const { deliveryChild } = await import("./rollout-delivery-child.ts")
    await deliveryChild(config, barrier)
  } else if (config.mode === "ingress") {
    const { ingressChild } = await import("./rollout-ingress-child.ts")
    await ingressChild(config, barrier)
  } else if (config.point === "inbound-commit") {
    const store = await openStore({ url: config.url })
    await store.sql.begin(async sql => {
      await enqueueInbound({ sql, url: store.url }, config.message)
    })
    barrier()
  } else {
    if (config.proof) {
      const fd = fs.openSync(config.file, "a", 0o600)
      fs.writeSync(fd, JSON.stringify(config.line) + "\n")
      const io = await import("node:fs")
      io.fsyncSync(fd)
      fs.closeSync(fd)
    } else {
      const mod = await import("../../src/chatlog.ts") as Record<string, any>
      await mod.appendChatLineOnce(config.context, config.line)
    }
    barrier()
  }
} catch (error) {
  console.log(JSON.stringify({ ready: false, error: String(error) }))
  process.exit(1)
}
