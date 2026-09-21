// Looking a chat up on the platform is the slowest thing an adopt does, and
// during a platform outage it retries for as long as the household's delivery
// bounds allow. None of that may hold up anybody else's chat.
//
// Every chat a door serves hands its batches through one accepting chain and
// one reserved connection, so a lookup made inside that chain stalls every
// person on the door until it gives up. The check types an adopt in the
// owner's chat while every lookup fails, and a plain message in the second
// person's chat on the same door, and asserts the plain message is accepted
// while the lookup is still retrying.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { runDoor } from "../src/door/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR = "1000000001"
const OTHER = "0000000000"
const RESEARCH = "1000000009"
const GUILD = "2000000000"
/** Long enough that a lookup under these bounds outlasts the whole assertion. */
const RETRY_SECONDS = 20

test("an adopt whose chat lookup keeps failing does not hold up another person's chat on the same door", async () => {
  const os = process.platform === "darwin" ? "macos" : "linux"
  const it = await rolloutStage(cluster, "discord", {
    admin: { chats: [{ name: "lair", chat: LAIR }, { name: "research", chat: RESEARCH }, { name: "other", chat: OTHER }] },
    machines: [{ id: "mac", os }],
    registry: (base: any) => ({
      ...base,
      run: [
        { id: "door-fake", kind: "door", platform: "fake", person: "p1", token_file: "/dev/null",
          schedule: "always", memory_limit_mb: 192, guild: GUILD, default_preset: "daily" },
        { id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      ],
    }),
  })
  const text = readFileSync(it.registryFile, "utf8")
  const slow = text.replace("delivery_retry_seconds = 1", `delivery_retry_seconds = ${RETRY_SECONDS}`)
  expect(slow).not.toBe(text)
  writeFileSync(it.registryFile, slow)
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.setRefusing(true)
    it.edge.batch([message("20", "/agent adopt p1-new research")], "21")
    expect(await observe(() => it.edge.adminCalls().some(one => one.verb === "resolveChat"), 10000),
      "the lookup started").toBe(true)
    it.edge.batch([{ ...message("30", "hello from the second person"), chat: OTHER, sender_id: "p2", from: "p2" }], "31")
    expect(await observe(async () => (await it.read.inbound()).some(row => row.body === "hello from the second person"), 10000),
      "the second person's message is accepted while the owner's lookup is still retrying").toBe(true)
    // Still retrying at that moment: the first failure and no answer yet.
    expect(it.edge.adminCalls().filter(one => one.verb === "resolveChat").length).toBeLessThan(3)
    expect(it.edge.posts().filter(post => post.text.includes("p1-new")), "the adopt is not answered before its lookup ends").toEqual([])
  } finally { await door?.stop(); await it.stop() }
}, 120_000)
