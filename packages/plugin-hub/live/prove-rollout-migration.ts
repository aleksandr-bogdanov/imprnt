import { strict as assert } from "node:assert"
import { chmodSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { migrationFixture, privateJson, readPrivateManifest, inventory, jsonlBytes, plantCanonical, historicalRows, note, envelope, plantTabHistory } from "../test/helpers/rollout-migration.ts"
import { scratchVault } from "../test/helpers/scratch-vault.ts"
import { writeImprntShim } from "../test/helpers/imprnt-shim.ts"
import { parseHarvestReply } from "../src/harvest/parse.ts"
import { readTail } from "../src/chatlog.ts"

export async function proveMigrationFixtures() {
  const f = migrationFixture()
  let vault: Awaited<ReturnType<typeof scratchVault>> | undefined
  try {
    assert.notEqual(f.source, f.snapshot)
    assert.equal(f.sources.length, 2)
    const tabFiles = plantTabHistory(f.roots[1].root, historicalRows)
    assert.equal(tabFiles.length, 3)
    assert.equal(tabFiles.flatMap(file => readFileSync(file, "utf8").trim().split("\n")).length, 5)
    for (const file of tabFiles) {
      for (const line of readFileSync(file, "utf8").trim().split("\n")) {
        const [at, sender, id, text] = line.split("\t")
        assert(file.endsWith(at.slice(0, 10) + ".log"))
        assert.equal(sender, "p2")
        assert(historicalRows.some(row => row.id === id && row.text === JSON.parse(text)))
      }
    }
    assert.equal(f.sources[0].agents.agents[0].tools.length, 4)
    assert.equal(f.sources[1].agents.mcp, undefined)
    const file = privateJson(join(f.dir, "manifest.json"), f.handoffManifest)
    assert.equal(readPrivateManifest(file).items.length, 5)
    chmodSync(file, 0o644)
    assert.throws(() => readPrivateManifest(file))
    chmodSync(file, 0o600)
    writeFileSync(file, "{")
    assert.throws(() => readPrivateManifest(file))
    privateJson(file, f.handoffManifest)
    const before = inventory([f.frozen])
    writeFileSync(f.frozen, readFileSync(f.frozen, "utf8") + " ")
    assert.notDeepEqual(inventory([f.frozen]), before)
    assert.deepEqual(await f.lookup({ guild: "synthetic-guild", token_file: f.token }), [{ name: "synthetic-channel", id: "0000000000" }])
    f.setChannels([])
    assert.deepEqual(await f.lookup({}), [])
    f.setChannels([{ name: "synthetic-channel", id: "0000000000" }, { name: "synthetic-channel", id: "1000000001" }])
    assert.equal((await f.lookup({})).length, 2)
    assert.equal(f.lookups.length, 3)
    assert.equal(statSync(f.token).mode & 0o777, 0o600)
    plantCanonical(f.stateDir, "p2", "p2-lair", historicalRows)
    assert.equal(Object.keys(jsonlBytes(f.stateDir, "p2", "p2-lair")).length, 3)
    const tail = await readTail({ stateDir: f.stateDir, person: "p2", agent: "p2-lair", now: new Date("2026-08-15T13:00:00Z"), hours: 2000, tokens: 8000 })
    for (const row of historicalRows) assert(tail.includes(row.text))
    vault = await scratchVault(f.dir)
    const shim = writeImprntShim(f.dir)
    assert.equal(parseHarvestReply(envelope(note())).kind, "notes")
    const apply = (text: string) => {
      const staged = join(f.dir, "staged.md")
      writeFileSync(staged, text)
      return Bun.spawnSync([shim, "ingest", "--apply", staged, "--vault", vault!.vaultDir], { stdout: "pipe", stderr: "pipe", env: { ...process.env, XDG_CONFIG_HOME: join(f.dir, "xdg") } })
    }
    assert.equal(apply(note()).exitCode, 0)
    assert(existsSync(join(vault.vaultDir, "life", "synthetic-history.md")))
    assert.equal(apply(note()).exitCode, 0)
    assert.equal(apply(note("Synthetic history", "A different synthetic fact.")).exitCode, 1)
    assert(existsSync(join(vault.vaultDir, "_needs-review.md")))
    assert.equal(apply(note("Invalid synthetic note", "Body.", false)).exitCode, 1)
    console.log("H08 fixture proof: private manifests, source digests, lookup faults, canonical history, parser, real ingest filed/noop/conflict/refused")
  } finally { await vault?.remove(); f.stop() }
}
if (import.meta.main) await proveMigrationFixtures()
