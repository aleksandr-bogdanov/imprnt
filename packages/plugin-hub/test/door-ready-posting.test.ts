// A door says ready only once its reply sender has made its first pass over
// the replies waiting for it. A statement the door issues after ready lands in
// whatever quiet window its caller opens next, and the restart budget in
// test/door-clock.test.ts opens its window a fixed 2 s after ready. The wait
// has to end even when the store refuses that pass, and the door has to say
// why, or a door with a broken store would start silently.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { appendNotice } from "../src/store/outbox.ts"
import { runDoor } from "../src/door/run.ts"

type Door = Awaited<ReturnType<typeof runDoor>>

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const start = (it: Awaited<ReturnType<typeof rolloutStage>>) =>
  runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })

/** Fails by name when the door is not handed back within the bound. */
async function readyWithin(starting: Promise<Door>, milliseconds: number): Promise<Door> {
  const late = Symbol("late")
  const won = await Promise.race([starting, Bun.sleep(milliseconds).then(() => late)])
  if (won === late) throw new Error(`the door was not handed back ready within ${milliseconds} ms`)
  return won as Door
}

test("a door is handed back ready only after its reply sender's first pass: a reply waiting at start is sent before ready, and ready waits while that send is held", async () => {
  const it = await rolloutStage(cluster, "telegram")
  const store = await superStore(cluster, it.db)
  let open: () => void = () => {}
  const gate = new Promise<void>(resolve => { open = resolve })
  const reached: string[] = []
  const post = it.edge.platform.post
  it.edge.platform.post = async where => { reached.push(where.text); await gate; return post(where) }
  let door: Door | undefined
  let ready = false
  let starting: Promise<Door> | undefined
  try {
    await appendNotice(store, { person: "p1", agent: "p1-lair", body: "a reply waiting at start",
      noticeKey: `ready:${crypto.randomUUID()}`, route: { door: "door-fake", chat: "1000000001" } })
    starting = start(it).then(handle => { ready = true; door = handle; return handle })
    expect(await observe(() => reached.includes("a reply waiting at start"), 15_000),
      "the reply sender must reach the reply that was waiting at start").toBe(true)
    // The send is held here, so the first pass is still running. A door handed
    // back now issues that pass's remaining statements after ready.
    await Bun.sleep(1500)
    expect(ready, "the door must not say ready while its reply sender's first pass is still running").toBe(false)
    open()
    door = await readyWithin(starting, 15_000)
    expect(it.edge.posts().some(one => one.text === "a reply waiting at start"),
      "the reply waiting at start must have been sent by the time the door says ready").toBe(true)
  } finally {
    open()
    if (!door && starting) door = await starting.catch(() => undefined)
    await door?.stop(); await store.sql.close(); await it.stop()
  }
})

test("a door whose store refuses the reply sender's first read is still handed back ready in bounded time, and says why on stderr", async () => {
  const it = await rolloutStage(cluster, "telegram")
  const store = await superStore(cluster, it.db)
  const said: string[] = []
  const write = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
    said.push(String(chunk))
    return (write as (...args: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof process.stderr.write
  const unreadable = (line: string) => /\bpost\b/.test(line) && /permission denied for table outbox/.test(line)
  let door: Door | undefined
  try {
    // The control: a door whose store answers says nothing about its reply
    // sender, so the line below cannot be an unrelated one.
    door = await readyWithin(start(it), 15_000)
    await door.stop(); door = undefined
    expect(said.filter(unreadable), "a door whose store answers must say nothing about a refused read").toEqual([])

    // The refusal lands during the first platform read, after the start's own
    // repair has read the outbox and before the reply sender's first read,
    // which waits for that platform read to finish.
    const pull = it.edge.platform.pull
    let refused = false
    it.edge.platform.pull = async where => {
      if (!refused) { refused = true; await store.sql`revoke select on outbox from hub_door` }
      return pull(where)
    }
    door = await readyWithin(start(it), 15_000)
    expect(refused).toBe(true)
    expect(said.some(unreadable),
      `the door must say on stderr that its reply sender could not read, with the store's cause. It said:\n${said.join("")}`).toBe(true)
  } finally {
    process.stderr.write = write
    await store.sql`grant select on outbox to hub_door`.catch(() => {})
    await door?.stop(); await store.sql.close(); await it.stop()
  }
})
