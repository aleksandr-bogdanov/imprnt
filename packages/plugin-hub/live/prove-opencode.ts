// What the pinned OpenCode build does with a hub launch, read off the real binary. NO MODEL IS
// CALLED and no real key is needed: the key is a random placeholder, the provider is only asked
// whether it reads as connected, and no prompt is ever posted.
//
//   bun live/prove-opencode.ts --bin /path/to/opencode --provider <engine provider id> --model <model id> [--unboxed]
//
// Nothing is defaulted: no provider, account or model has been chosen, so the run names them. The
// output is JSON on stdout and holds no key, no password and no environment.
//
// What it shows, each as a field of the output:
//   read_back     the server's effective configuration held what the launch asked for (the permissions, the
//                 disabled subagents, the pinned model, no plugins, the same servers): `start` refuses if not,
//                 so a run that got this far is the observation that the restriction is real on this build;
//   session_store a session created by one server process was found by the next one under the same data
//                 directory, by the id the hub's map names (the `sessionStore` list of `VALIDATED`);
//   identity      a resume under another model or provider was refused before any process started;
//   effort        an effort the model has no variant for was refused by name, and the refusal lists the variants
//                 the real engine reports for the model;
//   stop          the engine was asked to abort, its process tree was ended, and what the process table says of it.
//
// What it does not show: a turn, a tool call, a provider's answer, usage, refusal wording, or any resume of an
// interrupted turn. Those need a real key and a chosen provider, and are reported apart as real-provider evidence.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpenCode } from "../src/adapters/opencode.ts"
import { makeOpenCodeLaunch, probeOpenCodeVersion } from "../src/adapters/opencode-launch.ts"
import type { AdapterSession } from "../src/adapters/types.ts"

const arg = (name: string) => { const at = process.argv.indexOf(name); return at < 0 ? undefined : process.argv[at + 1] }
const bin = arg("--bin"), provider = arg("--provider"), model = arg("--model")
if (!bin || !provider || !model) {
  console.error("usage: bun live/prove-opencode.ts --bin <opencode> --provider <id> --model <id> [--unboxed]")
  process.exit(2)
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "hub-prove-opencode-")))
const tree = join(root, "tree")
mkdirSync(join(tree, "vault"), { recursive: true })
mkdirSync(join(root, "secrets"))
const keyFile = join(root, "secrets", "provider.token")
writeFileSync(keyFile, "synthetic-" + crypto.randomUUID() + "\n", { mode: 0o600 })
const sessionDir = join(root, "state", "p1", "sessions", "p1-lair", "conversation-1")
const adapter = createOpenCode()
const result: Record<string, unknown> = { bin, provider, model, version: probeOpenCodeVersion(bin), boxed: !process.argv.includes("--unboxed") }
const open: AdapterSession[] = []

type Changed = Partial<{ model: string; provider: string; effort: string }>
const launchFor = (changed: Changed = {}) => {
  const preset = { adapter: "opencode", model, provider, effort: "default", paid: "key", ...changed }
  const launch = makeOpenCodeLaunch({
    registry: null, preset, credential: { id: "provider-key", kind: "model-key", file: keyFile, owner: "p1" },
    agent: { id: "p1-lair", person: "p1", preset: "p", runner: "r", tools: ["Read", "Bash"] }, sessionDir, purpose: "ordinary",
    box: { agent: "p1-lair", person: "p1", tree, otherTrees: [], stateRoot: join(root, "state", "p1"), sessionDir, purpose: "ordinary" },
  } as never, bin)
  return { preset, launch }
}
const start = async (session: { id: string; resume: boolean }, changed: Changed = {}) => {
  const { preset, launch } = launchFor(changed)
  const started = await adapter.start({ preset, sessionId: null, session, cwd: launch.cwd, argv: launch.argv, env: launch.env,
    credentialId: launch.credentialId, wrap: process.argv.includes("--unboxed") ? (argv: string[]) => argv : launch.wrap })
  open.push(started)
  return started
}

try {
  const id = crypto.randomUUID()
  const first = await start({ id, resume: false })
  result.read_back = "held: start refuses a server whose effective configuration differs, and this one started"
  result.reported_session = first.reportedSessionId === id
  await first.close()
  result.first_gone = (await first.exitEvidence!()).confirmed

  const second = await start({ id, resume: true })
  result.session_store = second.reportedSessionId === id ? "the engine's own session was found again by the id the map names" : "NOT FOUND"
  const evidence = await second.interrupt!({ graceMs: 3000 })
  result.stop = { leader: evidence.leader, descendants: evidence.descendants, confirmed: evidence.confirmed, survivors: evidence.survivors, basis: evidence.basis, via: evidence.via }

  const refused = async (changed: Changed) => {
    try { await start({ id, resume: true }, changed); return "STARTED" } catch (error) { return (error as Error).message }
  }
  result.identity = { model: await refused({ model: model + "-other" }), provider: await refused({ provider: provider + "-other" }) }
  // An effort the model cannot have is refused by name, and the refusal lists the variants the real engine reports for this
  // model (`GET /provider`): that list is what a non-default effort may be, read with no model call.
  result.effort = { unlisted: await refused({ effort: "no-such-effort" }) }
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  result.failed = (error as Error).message
  console.log(JSON.stringify(result, null, 2))
  process.exitCode = 1
} finally {
  for (const session of open) await session.close().catch(() => {})
  rmSync(root, { recursive: true, force: true })
}
