import { readFileSync, writeFileSync } from "node:fs"
import type { Cluster } from "./cluster.ts"
import { stageHub, type StageOptions } from "./hub-fixture.ts"
import { rolloutPlatform } from "./rollout-platform.ts"

export async function rolloutStage(cluster: Cluster, name: "telegram" | "discord", options: StageOptions = {}) {
  const customize = options.registry
  const hub = await stageHub(cluster, {
    ...options,
    hub: { tick_seconds: 1, ...options.hub },
    people: options.people ?? [{ id: "p1", language: "en" }, { id: "p2", language: "ru" }],
    agents: options.agents ?? [{
      id: "p2-lair", person: "p2", preset: "daily", chat: "0000000000",
      door: "door-fake", runner: "runner-pi",
    }],
    registry: base => {
      const spec = { ...base, agents: base.agents!.map(one => ({ ...one, runner: "runner-pi" })) }
      return customize ? customize(spec) : spec
    },
  })
  let text = readFileSync(hub.registryFile, "utf8")
  for (const person of ["p1", "p2"]) {
    text = text.replace(`id = "${person}"\n`, `id = "${person}"\nallowed_senders = { door-fake = ["${person}"] }\n`)
  }
  text += "\n[door]\ndelivery_retry_seconds = 1\ndelivery_max_attempts = 3\nread_retry_seconds = 1\n[runner]\ntask_retry_seconds = 1\n"
  writeFileSync(hub.registryFile, text)
  return { ...hub, edge: rolloutPlatform(name) }
}
