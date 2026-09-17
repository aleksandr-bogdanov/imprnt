// Loaded only by the existing isolated crash child. Reuses its SIGKILL barrier.
import { mock } from "bun:test"
import * as chatlog from "../../src/chatlog.ts"
import { rolloutPlatform } from "./rollout-platform.ts"
export async function deliveryChild(config: any, barrier: () => void) {
  const wrap = (append: Function) => async (context: any, line: any) => {
    await append(context, line)
    if (line.direction === "out" && line.text === config.text) barrier()
  }
  const append = wrap(chatlog.appendChatLine)
  const once = (chatlog as any).appendChatLineOnce
  mock.module("../../src/chatlog.ts", () => ({ ...chatlog, appendChatLine: append,
    ...(once ? { appendChatLineOnce: wrap(once) } : {}) }))
  if (config.proof) { await append(config.context, config.line); return }
  const { runDoor } = await import("../../src/door/run.ts")
  await runDoor({ door: "door-fake", registryFile: config.registryFile, platform: rolloutPlatform("telegram").platform })
}
