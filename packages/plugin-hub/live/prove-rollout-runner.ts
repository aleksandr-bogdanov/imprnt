import assert from "node:assert/strict"
import { controlledAdapter, observe, editAgent, brokenStream, processTree, treeBytes } from "../test/helpers/rollout-runner.ts"
import { rolloutFixture } from "../test/helpers/rollout-fixtures.ts"
import { fakeClaudeCli } from "../test/helpers/fake-cli.ts"
import { childGone, residentBytes } from "../test/helpers/scripted-adapter.ts"
import { existsSync } from "node:fs"
import { nativeWrap } from "../test/helpers/rollout-loop.ts"

export async function proveRolloutRunner() {
  const f = rolloutFixture()
  const edge = controlledAdapter()
  let configured = 0
  edge.onStart(row => { configured++; row.loop.setAnswer(() => "configured answer") })
  const preset = f.preset as Parameters<typeof edge.adapter.start>[0]["preset"]
  try {
    editAgent(f.file, "p1-lair", { preset: "alternate", mode: "on-demand", sleeping: true, idle_seconds: 1 })
    const loaded = Bun.TOML.parse(await Bun.file(f.file).text()) as any
    assert.equal(loaded.agents[0].preset, "alternate")
    assert.equal(loaded.agents[0].sleeping, true)
    assert.throws(() => editAgent(f.file, "missing", { sleeping: false }))
    edge.failStarts(1)
    await assert.rejects(edge.adapter.start({ preset, sessionId: null }), /task-start/)
    const a = await edge.adapter.start({ preset, sessionId: null })
    edge.failStarts(1, options => options.preset.model === "synthetic-task-target")
    const b = await edge.adapter.start({ preset, sessionId: null })
    assert.equal(configured, 2)
    await assert.rejects(edge.adapter.start({ preset: { ...preset, model: "synthetic-task-target" }, sessionId: null }), /task-start/)
    let endsA = 0, endsB = 0
    a.onTurnEnd(end => { assert.equal(end.text, "configured answer"); endsA++ })
    b.onTurnEnd(() => endsB++)
    edge.hold(message => message.id === "tail")
    await a.feed({ id: "tail", text: "synthetic tail" })
    await b.feed({ id: "ordinary", text: "synthetic input" })
    assert.equal(await observe(() => endsB === 1), true)
    assert.equal(endsA, 0)
    edge.suppressClose(true)
    await a.close()
    assert.equal(childGone(a.pid!), false)
    edge.suppressClose(false)
    edge.sessions[0].loop.endTurn()
    assert.equal(await observe(() => endsA === 1), true)
    edge.throwFeed(message => message.id === "throw")
    await assert.rejects(b.feed({ id: "throw", text: "synthetic error" }), /task-feed/)
    edge.sessions[0].grow(48)
    assert.equal(await observe(() => residentBytes(a.pid!) > 48 * 1024 * 1024), true)
    let exits = 0
    void edge.sessions[0].session.exited.then(() => exits++)
    edge.sessions[0].fail()
    edge.sessions[0].fail()
    assert.equal(await observe(() => exits === 1 && childGone(a.pid!)), true)
    assert.equal(childGone(b.pid!), false)
    edge.suppressExit(true)
    let suppressed = false
    void edge.sessions[1].session.exited.then(() => { suppressed = true })
    edge.sessions[1].fail()
    assert.equal(await observe(() => suppressed, 100), false)
    for (const mode of ["exit", "eof", "parse"] as const) {
      const child = Bun.spawn(brokenStream(fakeClaudeCli([]), mode)([]), { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
      try {
        child.stdin.write('{"message":{"content":"probe"}}\n')
        await child.stdin.flush()
        const reader = child.stdout.getReader()
        const read = () => Promise.race([reader.read(), Bun.sleep(2000).then(() => { throw new Error("synthetic wire proof did not reach its boundary") })])
        const first = await read()
        assert.match(new TextDecoder().decode(first.value), /isReplay/)
        if (mode === "parse") {
          const bytes = new TextDecoder().decode(first.value)
          const next = bytes.includes("not-json") ? bytes : new TextDecoder().decode((await read()).value)
          assert.match(next, /not-json/)
        } else {
          assert.equal((await read()).done, true)
          if (mode === "exit") assert.equal(await child.exited, 7)
        }
      } finally { child.kill(); await child.exited }
    }
  } finally { await edge.stop(); f.stop() }
  assert.ok(edge.sessions.every(row => row.closed))
  assert.equal(await observe(() => edge.sessions.every(row => childGone(row.session.pid!))), true)
  const nested = controlledAdapter("synthetic-tree", true)
  let owned: number[] = []
  try {
    const session = await nested.adapter.start({ preset, sessionId: null })
    assert.equal(await observe(() => processTree(session.pid!).length === 3), true)
    owned = processTree(session.pid!)
    nested.sessions[0].grow(32)
    assert.equal(await observe(() => treeBytes(session.pid!) > 80 * 1024 * 1024), true)
    assert.ok(treeBytes(session.pid!) > residentBytes(session.pid!))
  } finally { await nested.stop() }
  assert.equal(await observe(() => owned.every(pid => childGone(pid))), true)
  const boxed = rolloutFixture()
  const wrapper = nativeWrap({ agent: "p1-lair", person: "p1", tree: boxed.trees.person("p1").tree,
    sharedZone: boxed.trees.sharedZone, otherTrees: [boxed.trees.person("p2").tree] })
  const edgeBox = controlledAdapter("synthetic-profile-cleanup")
  let profiles: string[] = []
  try {
    const session = await edgeBox.adapter.start({ preset, sessionId: null, wrap: wrapper.wrap })
    assert.equal(childGone(session.pid!), false)
    profiles = edgeBox.sessions.flatMap(row => row.loop.spawns().map(s => s.profile).filter((p): p is string => p !== null))
    assert.ok(profiles.every(path => existsSync(path)))
    await edgeBox.stop()
    assert.ok(profiles.every(path => !existsSync(path)))
  } finally { await edgeBox.stop(); wrapper.stop(); boxed.stop() }
  console.log("HELPER PASS plan-03: independent sessions, tail barrier, throws, allocation, once-only exit, suppressed-exit control, EOF, parser fault, registry edits, child cleanup")
}
