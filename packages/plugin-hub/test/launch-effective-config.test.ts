// The effective launch configuration (`effectiveLaunchConfig`) is what a launch really passes: the same functions make the argv. A move compares
// two machines by it, so it must never describe a launch that `makeLoopLaunch` would not make.

import { expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { effectiveLaunchConfig } from "../src/adapters/launch.ts"
import { launchInput, launchSeam, loopFixture } from "./helpers/rollout-loop.ts"

const argOf = (argv: string[], flag: string): string | null => { const at = argv.indexOf(flag); return at < 0 ? null : argv[at + 1] }

for (const purpose of ["ordinary", "harvest", "triage"] as const) test(`${purpose}: the settings, the MCP configuration and the appended prompt of the effective config are the ones the launch passes`, async () => {
  const f = loopFixture()
  try {
    const make = await launchSeam()
    const input = launchInput(f, purpose)
    const launch = await make(input)
    const expected = effectiveLaunchConfig({ registry: input.registry, agent: input.agent, purpose, box: input.box as never, credentialFile: input.credential.file, hubMcp: false })

    expect(JSON.parse(argOf(launch.argv, "--settings")!)).toEqual(expected.settings)
    const mcp = argOf(launch.argv, "--mcp-config")!
    if (purpose === "ordinary") {
      expect(mcp, "the agent's own file is passed by name").toBe(expected.mcpFile!)
      expect(JSON.parse(readFileSync(mcp, "utf8"))).toEqual(expected.mcp)
      const prompt = argOf(launch.argv, "--append-system-prompt-file")!
      expect(readFileSync(prompt, "utf8")).toBe(expected.prompt!.text)
      expect(expected.prompt!.reads.length, "every file the prompt was made from is named").toBeGreaterThan(0)
    } else {
      expect(JSON.parse(mcp)).toEqual(expected.mcp)
      expect(expected.mcpFile).toBeUndefined()
      expect(expected.prompt, "a harvest and the triage master read no instructions").toBeNull()
      expect(argOf(launch.argv, "--append-system-prompt-file")).toBeNull()
    }
  } finally { f.stop() }
})

test("an edited file changes the effective config and the launch together, and a file the launch would refuse is refused by the same code", async () => {
  const f = loopFixture()
  try {
    const make = await launchSeam()
    const input = launchInput(f)
    const before = effectiveLaunchConfig({ registry: input.registry, agent: input.agent, purpose: "ordinary", box: input.box as never, credentialFile: input.credential.file, hubMcp: false })
    writeFileSync(f.files.settings, JSON.stringify({ permissions: { deny: ["Bash"] } }))
    const after = effectiveLaunchConfig({ registry: input.registry, agent: input.agent, purpose: "ordinary", box: input.box as never, credentialFile: input.credential.file, hubMcp: false })
    expect(after.settings).not.toEqual(before.settings)
    expect(JSON.parse(argOf((await make(launchInput(f))).argv, "--settings")!)).toEqual(after.settings)

    // The hub adds its own tool server beside the person's: a person's server of that name is refused, here and in the launch.
    writeFileSync(f.files.mcp, JSON.stringify({ mcpServers: { hub: { command: "x" } } }))
    const hubMcp = { command: "hub", args: [], env: {}, reads: [], writes: [] }
    expect(() => effectiveLaunchConfig({ registry: input.registry, agent: input.agent, purpose: "ordinary", box: input.box as never, hubMcp: true })).toThrow("invalid-mcp-configuration")
    await expect(make({ ...launchInput(f), hubMcp })).rejects.toThrow("invalid-mcp-configuration")
    writeFileSync(f.files.settings, JSON.stringify({ env: { KEY: "x" } }))
    expect(() => effectiveLaunchConfig({ registry: input.registry, agent: input.agent, purpose: "ordinary", box: input.box as never, hubMcp: false })).toThrow("invalid-settings-configuration")
  } finally { f.stop() }
})
