// Real door and real token-file selection, synthetic loopback HTTP transport.
import { runDoor } from "../../src/door/run.ts"
import { telegram } from "../../src/door/platforms/telegram.ts"
import { loadRegistry } from "../../src/registry/load.ts"
const [registryFile, door, endpoint] = process.argv.slice(2)
try {
  const entry = (loadRegistry(registryFile).data.run as Record<string, unknown>[]).find(e => e.id === door)!
  const transport = (async (input: any, init: any) => {
    const response = await fetch(endpoint, { method: "POST", body: JSON.stringify({ url: String(input), body: init?.body }) })
    await Bun.sleep(10)
    return response
  }) as typeof fetch
  const handle = await runDoor({ registryFile, door, platform: telegram({ tokenFile: String(entry.token_file), fetch: transport }) })
  process.on("SIGTERM", async () => { await handle.stop(); process.exit(0) })
  console.log(JSON.stringify({ ready: true, pid: process.pid }))
  await new Promise(() => {})
} catch (error) { console.log(JSON.stringify({ ready: false, error: String(error) })); process.exit(1) }
