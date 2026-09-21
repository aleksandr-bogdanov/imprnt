// Test infrastructure: one registry edit in a process of its own, so two
// edits can meet the way a hub applying a command and a board setting a key
// meet on one machine.
//
// argv: <file> <entry path> <key> <value as JSON> [<ready file> <release file>]
//
// With the last two, the edit stops after its last read-back and before its
// rename, says so by writing the ready file, and waits for the release file.
import { existsSync, writeFileSync } from "node:fs"
import { setKey } from "../../src/registry/edit.ts"

const [file, entryPath, key, value, ready, release] = process.argv.slice(2)
const seam = ready && release ? {
  async afterCheck() {
    writeFileSync(ready, "")
    while (!existsSync(release)) await Bun.sleep(10)
  },
} : undefined
try {
  const result = await setKey(file, entryPath, key, JSON.parse(value), seam ? { seam } : {})
  process.stdout.write(JSON.stringify(result) + "\n")
} catch (error) {
  process.stdout.write(JSON.stringify({ refused: (error as { step?: string }).step ?? String((error as Error).message) }) + "\n")
}
