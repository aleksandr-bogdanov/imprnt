// A command a person types is always answered, and the batch it came in is
// always acknowledged.
//
// A refusal that escapes as a plain error leaves the batch unacknowledged, and
// the door pulls the same batch again on every read: the person is never told
// anything, and every message after the command in that chat waits behind it
// for ever. Each shape below reached such an error, and the check is that the
// person hears one sentence about it and the next message in the same chat is
// accepted.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { runDoor } from "../src/door/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR = "1000000001"
const RESEARCH = "1000000009"
const GUILD = "2000000000"
/** A runner the file says is stopped, whose id is also a legal agent id. */
const HELD = "held"

function household(options: { heldAgent?: boolean } = {}) {
  const os = process.platform === "darwin" ? "macos" : "linux"
  return {
    admin: { chats: [{ name: "lair", chat: LAIR }, { name: "research", chat: RESEARCH }] },
    machines: [{ id: "mac", os }],
    registry: (base: any) => ({
      ...base,
      agents: [
        ...base.agents!.map((one: any) => ({ ...one, person: "p1" })),
        ...(options.heldAgent ? [{ id: HELD, person: "p1", preset: "daily", runner: "runner-pi" }] : []),
      ],
      run: [
        { id: "door-fake", kind: "door", platform: "fake", person: "p1", token_file: "/dev/null",
          schedule: "always", memory_limit_mb: 192, guild: GUILD, default_preset: "daily" },
        { id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
        { id: HELD, kind: "runner", schedule: "always", enabled: false, memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ],
    }),
  }
}

for (const shape of [
  { what: "an adopt whose id is a stopped run entry's", heldAgent: false, text: `/agent adopt ${HELD} research` },
  { what: "a recover of an agent whose id is a stopped run entry's", heldAgent: true, text: `/recover ${HELD}` },
]) {
  test(`${shape.what} is answered, and the next message in the same chat is accepted`, async () => {
    const it = await rolloutStage(cluster, "discord", household({ heldAgent: shape.heldAgent }))
    let door: Awaited<ReturnType<typeof runDoor>> | undefined
    try {
      // The door alone, because the answer and the acknowledgement are both the
      // door's: whatever a hub later does with the row is said separately.
      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
      it.edge.batch([message("20", shape.text)], "21")
      it.edge.batch([message("30", "the message after the command")], "31")
      expect(await observe(async () => (await it.read.inbound()).some(row => row.body === "the message after the command"), 15000),
        "the message after the command is accepted").toBe(true)
      const said = it.edge.posts().filter(post => post.chat === LAIR && post.text.includes(HELD))
      expect(said, `the person is told one sentence about ${HELD}: ${JSON.stringify(it.edge.posts())}`).toHaveLength(1)
    } finally { await door?.stop(); await it.stop() }
  }, 90_000)
}
