import { strict as assert } from "node:assert"
import { join } from "node:path"
import { loopFixture } from "../test/helpers/rollout-loop.ts"
import { observedCli, toolResults } from "../test/helpers/rollout-wire-observer.ts"
export async function proveWireObserver() {
  const f = loopFixture()
  try {
    const file = join(f.dir, "wire.jsonl")
    const events = [{ type: "assistant", message: { content: [{ type: "tool_use", id: "call-1", name: "Write", input: { file_path: "synthetic.txt" } }] } }, { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "call-1", is_error: true, content: "denied" }] } }]
    const bytes = events.map(e => JSON.stringify(e)).join("\n") + "\n"
    const child = Bun.spawn(observedCli(file, [process.execPath, "-e", `process.stdout.write(${JSON.stringify(bytes)})`]), { stdout: "pipe", stderr: "pipe" })
    assert.equal(await new Response(child.stdout).text(), bytes)
    assert.equal(await child.exited, 0)
    assert.equal(toolResults(file)[0].call.input.file_path, "synthetic.txt")
    assert.equal(toolResults(file)[0].result.is_error, true)
    console.log("HELPER PASS round-2 CLI wire relay preserves bytes and joins actual tool IDs")
  } finally { f.stop() }
}
if (import.meta.main) await proveWireObserver()
