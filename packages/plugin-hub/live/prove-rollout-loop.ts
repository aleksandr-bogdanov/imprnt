// Standalone helper proof, also imported before any plan-02 check uses it.
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs"
import { join, dirname } from "node:path"
import { loopFixture, launchInput, captureCli, digest, stateFiles, fileProbe, controlledMcp, capabilityProbe, nativeWrap, ending, withAmbient } from "../test/helpers/rollout-loop.ts"
import { claudeCode } from "../src/adapters/claude-code.ts"
import { fakeClaudeCli, healthyResult } from "../test/helpers/fake-cli.ts"
import { boxGate } from "../test/helpers/box-gate.ts"
const f = loopFixture()
const endpoint = controlledMcp()
try {
  const originalHome = process.env.HOME
  await withAmbient({ HOME: f.home }, async () => { assert.equal(process.env.HOME, f.home) })
  assert.equal(process.env.HOME, originalHome)
  await assert.rejects(withAmbient({ HOME: f.home }, async () => { throw new Error("synthetic refusal") }), /synthetic refusal/)
  assert.equal(process.env.HOME, originalHome)
  const input = launchInput(f)
  assert.equal(input.agent.id, "p1-lair")
  assert.equal(input.preset.model, "synthetic-alias")
  assert.equal(input.registry.credentials[0].file, f.login)
  const stream = await claudeCode.start({ preset: input.preset, sessionId: null, wrap: fakeClaudeCli([healthyResult("helper answer")]) })
  try { assert.equal((await ending(stream)).text, "helper answer") } finally { await stream.close() }
  if (process.platform === "linux" || process.platform === "darwin") {
    assert.equal(boxGate().ok, true)
    const box = nativeWrap(input.box)
    try {
      const child = Bun.spawnSync(box.wrap(["/bin/cat", join(f.trees.person("p1").tree, "CLAUDE.md")]), { stdout: "pipe", stderr: "pipe", timeout: 5000 })
      assert.equal(child.exitCode, 0)
      assert.match(child.stdout.toString(), /ambient-project-instruction-sentinel/)
    } finally { box.stop() }
  }
  const capture = join(f.dir, "capture.json")
  const env = { PATH: process.env.PATH, HOME: f.home, CLAUDE_CONFIG_DIR: input.sessionDir, CLAUDE_SECURESTORAGE_CONFIG_DIR: dirname(f.login), CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }
  const flags = ["claude", "--setting-sources", "", "--settings", f.files.settings, "--mcp-config", f.files.mcp, "--append-system-prompt-file", f.files.fragment]
  for (const [name, argv] of [["isolated", flags], ["ambient", ["claude"]]] as const) {
    const child = Bun.spawn(captureCli(capture, f)([...argv]), { env, cwd: input.sessionDir, stdin: "pipe", stdout: "pipe", stderr: "pipe" })
    try {
      child.stdin.write('{"message":{"content":"proof"}}\n')
      await child.stdin.flush()
      const reader = child.stdout.getReader()
      const timer = setTimeout(() => child.kill(), 5000)
      try { assert.equal((await reader.read()).done, false) } finally { clearTimeout(timer); reader.releaseLock() }
      const seen = JSON.parse(readFileSync(capture, "utf8"))
      assert.equal(seen.cwd, input.sessionDir)
      assert.equal(seen.credentialDigest, digest(readFileSync(f.login, "utf8")))
      assert.equal(seen.leaked, false)
      if (name === "isolated") {
        assert.deepEqual(seen.ambient, [])
        assert.equal(seen.fragment, readFileSync(f.files.fragment, "utf8"))
        assert.deepEqual(seen.mcp, { mcpServers: {} })
      } else assert.match(JSON.stringify(seen.ambient), /ambient-hook-sentinel/)
    } finally { child.kill(); await child.exited }
  }
  assert.equal(readFileSync(join(input.sessionDir, "session-write"), "utf8"), "synthetic-session-state")
  for (const file of Object.values(stateFiles(f))) {
    assert.equal(fileProbe([], file, "read").code, 0)
    assert.equal(fileProbe([], file, "write").code, 0)
  }
  for (const method of ["initialize", "tools/list", "tools/call"]) {
    const reply = await fetch(endpoint.url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { name: "receipt", arguments: { codeword: "proof" } } }) })
    assert.equal(reply.status, 200)
    assert.ok((await reply.json() as any).result)
  }
  assert.deepEqual(endpoint.receipts, ["proof"])
  const binary = join(f.dir, "capability-cli")
  writeFileSync(binary, '#!/bin/sh\ncase "$1" in --version) echo synthetic-version;; --help) echo "--settings --setting-sources --strict-mcp-config --append-system-prompt-file --tools";; *) exit 2;; esac\n')
  chmodSync(binary, 0o700)
  const probe = capabilityProbe(binary, { HOME: f.home, PATH: process.env.PATH })
  assert.equal(probe.ok, true)
  assert.equal(probe.version, "synthetic-version")
  assert.equal(probe.flags.length, 5)
  assert.equal(capabilityProbe("/nonexistent/synthetic-cli", {}).ok, false)
} finally { endpoint.stop(); f.stop() }
assert.equal(existsSync(f.dir), false)
console.log("HELPER PASS plan-02: loaded synthetic registry, child argv/env/cwd/sources, poison detection, session write, unboxed direct/symlink probes, MCP receipts, capability probe, child and directory cleanup")
