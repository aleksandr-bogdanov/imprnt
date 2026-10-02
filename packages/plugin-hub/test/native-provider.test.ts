// A native session is not resumed on another route. The route (provider, credential kind, normalized endpoint) is written
// with the attempt, before anything launches or is fed, so an interrupted first turn leaves it; a session an earlier build
// began has only its settled turns, and those may not authorize a model key. Asserted on Postgres on the runner's own role,
// like the other conversation rules; nothing starts a loop, and no provider is named beyond placeholders.

import { afterAll, afterEach, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { startCluster, freshDatabase, type Cluster } from "./helpers/cluster.ts"
import { writeRegistry } from "./helpers/authorized-registry.ts"
import type { StoreLike } from "../src/store/connect.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { settleTurn } from "../src/runner/settle.ts"
import { boundRoute, normalizeEndpoint, routeKey, routeOf, routeRefusal, type NativeRoute } from "../src/runner/native-provider.ts"
import { conversationFor, markFeedIntent, noteNative, openExecution, registerIncarnation } from "../src/store/conversations.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const mine: { close(): Promise<void> }[] = []
const track = <T extends { close(): Promise<void> }>(sql: T): T => { mine.push(sql); return sql }
afterEach(async () => { for (const one of mine.splice(0)) await one.close().catch(() => {}) })

const LABEL = "same-label"
const login: NativeRoute = { provider: LABEL, credential: "claude-login", endpoint: null }
const keyAt = (endpoint: string): NativeRoute => ({ provider: LABEL, credential: "model-key", endpoint })
const A = "https://a.example.invalid/anthropic"
const B = "https://b.example.invalid/anthropic"

const settings = (provider: string) => ({ adapter: "claude-code", effort: "medium", model: "m", paid: "key", provider })
const TURN = { agent: "p1-lair", runner: "runner-a", preset: "daily", preset_id: "x", input_tokens: 1, cached_input_tokens: 0,
  output_tokens: 1, price: null, plan_usage: null, raw_usage: {}, session_id: null, lacks: [], tail: false }

async function stage() {
  const db = await freshDatabase(cluster)
  const su = track(cluster.connect(db))
  const runner = { sql: track(cluster.connectAs("hub_runner", db)), url: cluster.url(db) } as StoreLike
  await registerIncarnation(runner, { runner: "runner-a", incarnation: "one", machine: "pi", bootId: null })
  // A master's conversation is made from the agent alone; no input has to exist for it.
  const master = await conversationFor(runner, { row: { id: "h0", person: "p1", agent: "p1-lair", kind: "human" }, adapter: "claude-code", machine: "pi" })
  let n = 0
  /**
   * One attempt of the master conversation, opened the way the runner opens it (the route in the attempt's evidence, when it is
   * given), fed unless `fed` is false, and settled under `settle` when that is given. One that is neither fed nor settled stays open.
   */
  const attempt = async (it: { route?: NativeRoute; fed?: boolean; settle?: string }) => {
    const id = `h${++n}`
    await su`insert into inbound (id, person, agent, body, kind, source) values (${id}, 'p1', 'p1-lair', ${`body of ${id}`}, 'human',
      ${{ log_id: id, at: new Date().toISOString(), door: "door-fake", chat: "1000000001", sender_id: "p1", text: `body of ${id}` }}::jsonb)`
    await su.unsafe(`update inbound set claimed_by = 'runner-a', claim_deadline = now() + interval '1 hour' where id = $1`, [id])
    const opened = await openExecution(runner, { row: { id, agent: "p1-lair" }, conversation: master, runner: "runner-a", incarnation: "one", digest: "d",
      nativeSession: master.native_session, ...(it.route ? { evidence: { route: it.route } } : {}) })
    if (it.fed !== false) await markFeedIntent(runner, opened, `body of ${id}`)
    if (it.settle !== undefined) {
      await settleTurn(runner, { inboundId: id, person: "p1", chunks: ["ok"], turn: { ...TURN, preset_settings: settings(it.settle) },
        execution: { id: opened.id, runner: "runner-a", fence: { incarnation: "one" } } })
    }
  }
  /** The engine took a message under the session: a respawn would resume it. */
  const started = () => noteNative(runner, master.id, "started")
  return { runner, id: master.id, attempt, started }
}

test("the first turn is interrupted before it settles: the route written with its attempt still refuses another route", async () => {
  const s = await stage()
  await s.attempt({ route: keyAt(A) })
  await s.started()
  // No turn ever settled, so a rule that needed one would resume anywhere.
  expect(await boundRoute(s.runner, s.id)).toEqual(keyAt(A))
  expect(await routeRefusal(s.runner, s.id, keyAt(A))).toBeNull()
  expect(await routeRefusal(s.runner, s.id, { ...keyAt(A), provider: "other-label" })).toMatchObject({ why: "route-changed" })
  expect(await routeRefusal(s.runner, s.id, login)).toMatchObject({ why: "route-changed" })
})

test("the same provider label behind another endpoint is another route, and two spellings of one endpoint are one", async () => {
  const s = await stage()
  await s.attempt({ route: keyAt(A), settle: LABEL })
  await s.started()
  const refused = await routeRefusal(s.runner, s.id, keyAt(B))
  expect(refused).toMatchObject({ why: "route-changed" })
  // What is said names both endpoints and nothing else of the credential.
  expect(refused!.said).toContain(A)
  expect(refused!.said).toContain(B)
  expect(await routeRefusal(s.runner, s.id, keyAt(normalizeEndpoint("HTTPS://A.example.invalid:443/anthropic/")))).toBeNull()
})

test("a route that did not change resumes, an attempt that was never fed does not move the binding, and a session not yet acknowledged has nothing to protect", async () => {
  const s = await stage()
  await s.attempt({ route: login, settle: LABEL })
  // The engine has not taken a message under the session (`new`): it is replaced by a fresh one, so any route may start.
  expect(await routeRefusal(s.runner, s.id, keyAt(A))).toBeNull()
  await s.started()
  expect(await routeRefusal(s.runner, s.id, login)).toBeNull()
  // An attempt opened under another route and never fed put nothing into the session.
  await s.attempt({ route: keyAt(A), fed: false })
  expect(await boundRoute(s.runner, s.id)).toEqual(login)
  expect(await routeRefusal(s.runner, s.id, keyAt(A))).toMatchObject({ why: "route-changed" })
})

test("a session an earlier build began has no route: its login resumes unasked, and a model key is never authorized by it", async () => {
  const settled = await stage()
  await settled.attempt({ settle: LABEL })
  await settled.started()
  expect(await boundRoute(settled.runner, settled.id)).toBeNull()
  expect(await routeRefusal(settled.runner, settled.id, login)).toBeNull()
  expect(await routeRefusal(settled.runner, settled.id, { ...login, provider: "other-label" })).toMatchObject({ why: "route-changed" })
  // Same label, but a key: nothing says this session may be given to one.
  expect(await routeRefusal(settled.runner, settled.id, keyAt(A))).toMatchObject({ why: "route-unknown" })

  // An interrupted first turn of that build left no settled turn at all: unknown provenance, the same answer.
  const interrupted = await stage()
  await interrupted.attempt({})
  await interrupted.started()
  expect(await routeRefusal(interrupted.runner, interrupted.id, login)).toBeNull()
  expect(await routeRefusal(interrupted.runner, interrupted.id, keyAt(A))).toMatchObject({ why: "route-unknown" })
})

test("the route a preset launches on comes from its credential, and carries no key, file or credential id", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-native-route-"))
  try {
    const file = writeRegistry(dir, {
      hub: { state_dir: dir },
      people: [{ id: "p1", tree: join(dir, "p1") }],
      credentials: [
        { id: "provider-key", kind: "model-key", file: "/var/lib/imprnt-hub/secrets/provider.token", owner: "p1", base_url: "https://A.example.invalid:443/anthropic/" },
        { id: "household-claude", kind: "claude-login", file: "/var/lib/imprnt-hub/credentials/.credentials.json", owner: "p1" },
      ],
      presets: {
        keyed: { adapter: "synthetic", model: "m", provider: LABEL, effort: "medium", paid: "key", credential: "provider-key" },
        login: { adapter: "synthetic", model: "m", provider: LABEL, effort: "medium", paid: "key", credential: "household-claude" },
      },
    })
    const it = loadRegistry(file)
    const keyed = routeOf(it, "keyed", it.presets.keyed), plain = routeOf(it, "login", it.presets.login)
    expect(keyed).toEqual(keyAt(A))
    expect(plain).toEqual(login)
    // One label, two routes: the key and the login are told apart.
    expect(routeKey(keyed)).not.toBe(routeKey(plain))
    expect(JSON.stringify(keyed)).not.toMatch(/provider\.token|provider-key|secrets/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
