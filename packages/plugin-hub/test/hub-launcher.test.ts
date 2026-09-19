// IMP-161. D-186 step 4 dispatches the Node shim to prove the core can start
// the hub, so the one failure it exists to catch has to say what it is.
import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hubPath } from "./helpers/cluster.ts"

test("ROLL-04 Node shim says bun is missing and how to get it, then exits non-zero", async () => {
  const node = Bun.which("node")
  expect(node, "the shim runs under Node").toBeTruthy()
  // A PATH holding Node and nothing else, so no bun on this machine leaks in.
  const bin = mkdtempSync(join(tmpdir(), "hub-launcher-"))
  try {
    symlinkSync(node!, join(bin, "node"))
    const run = async () => {
      const child = Bun.spawn([node!, hubPath("hub.mjs"), "metrics"], { env: { PATH: bin, HOME: bin }, stdout: "pipe", stderr: "pipe" })
      const timer = setTimeout(() => child.kill(9), 10000)
      try {
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        return { out, err, code }
      } finally { clearTimeout(timer) }
    }
    // Control: the same launcher with a bun on the path forwards that child's own words and status.
    writeFileSync(join(bin, "bun"), `#!${node}\nprocess.stderr.write("synthetic bun refusal\\n")\nprocess.exit(7)\n`, { mode: 0o755 })
    expect(await run()).toEqual({ out: "", err: "synthetic bun refusal\n", code: 7 })
    rmSync(join(bin, "bun"))
    const missing = await run()
    expect(missing.code).not.toBe(0)
    expect(missing.out).toBe("")
    expect(missing.err).toMatch(/\bbun\b.*not found/i)
    expect(missing.err).toContain("https://bun.sh")
    expect(missing.err).toContain("PATH")
  } finally { rmSync(bin, { recursive: true, force: true }) }
})
