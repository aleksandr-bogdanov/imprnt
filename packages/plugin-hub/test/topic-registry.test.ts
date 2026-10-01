// What the registry says about topic chats, and what is made of it before anybody sees a preview:
// the defaults and their order, the refusals that name a missing or wrong setting, the person's
// General, the archive mapping, and the exact text a person is asked to confirm.
//
// No database and no platform: every answer here is a function of a registry file the loader
// really loaded, so what a check holds up is the loader's refusal or the accessor's answer.

import { afterAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeRegistry } from "./helpers/authorized-registry.ts"
import type { AgentSpec, PersonSpec, RegistrySpec, RunSpec } from "./helpers/registry.ts"
import { RegistryRefused, loadRegistry, type Registry } from "../src/registry/load.ts"
import {
  archiveOf, attentionRoute, canMakeChats, generalOf, generalRoute, legacyBindingOf, legacyMastersOf, resolveMoveDestination, resolveTopicSetup, runnerOfMachine,
  topicCategoryOf, topicDefaultsFor,
} from "../src/registry/topics.ts"
import { topicConfirmationAsk, topicPreview } from "../src/door/topic-lines.ts"
import { previewHash } from "../src/store/confirmations.ts"

const dirs: string[] = []
afterAll(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const DOOR = "door-d"
const OWNER = "100000000000000001"

interface Over {
  person?: Partial<PersonSpec>
  door?: Partial<RunSpec>
  agents?: AgentSpec[]
  run?: RunSpec[]
  machines?: { id: string; os: string }[]
}

function spec(over: Over = {}): RegistrySpec {
  const dir = mkdtempSync(join(tmpdir(), "hub-topic-registry-"))
  dirs.push(dir)
  return {
    hub: { state_dir: dir },
    machines: over.machines ?? [{ id: "pi", os: "linux" }, { id: "mac", os: "macos" }],
    people: [
      { id: "p1", allowed_senders: { [DOOR]: [OWNER] }, topic_machine: "pi", topic_preset: "daily", general: "p1-general", ...over.person },
      { id: "p2", allowed_senders: { "door-d2": [OWNER] } },
    ],
    presets: {
      daily: { adapter: "synthetic", model: "m-daily", provider: "p", effort: "medium", paid: "plan" },
      fast: { adapter: "synthetic", model: "m-fast", provider: "p", effort: "low", paid: "plan" },
    },
    agents: [
      { id: "p1-general", person: "p1", preset: "daily", chat: "1000000001", door: DOOR, runner: "runner-pi" },
      { id: "p2-lair", person: "p2", preset: "daily", chat: "1000000002", door: "door-d2", runner: "runner-pi" },
      { id: "p1-seat", person: "p1", preset: "daily", runner: "runner-pi", role: "council" },
      { id: "p1-jobs", person: "p1", preset: "daily", runner: "runner-pi" },
      ...(over.agents ?? []),
    ],
    run: over.run ?? [
      { id: DOOR, kind: "door", machine: "pi", platform: "discord", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192,
        guild: "800000000000000001", archive_category: "900000000000000001", archive_readonly_roles: ["800000000000000001"], ...over.door },
      { id: "door-d2", kind: "door", machine: "pi", platform: "discord", person: "p2", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      { id: "runner-mac", kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
    ],
  }
}

function registry(over: Over = {}): Registry {
  const made = spec(over)
  return loadRegistry(writeRegistry(made.hub!.state_dir as string, made))
}

function refusal(over: Over): RegistryRefused {
  try { registry(over) } catch (error) { return error as RegistryRefused }
  throw new Error("the registry loaded, and this check is about a refusal")
}

test("a registry with the topic settings loads, and every accessor answers from it and from nothing else", () => {
  const it = registry()
  expect(topicDefaultsFor(it, "p1", DOOR)).toEqual({
    machine: { value: "pi", from: "person" }, preset: { value: "daily", from: "person" },
  })
  expect(generalOf(it, "p1")?.id).toBe("p1-general")
  expect(generalRoute(it, "p1")).toMatchObject({ agent: "p1-general", route: { door: DOOR, chat: "1000000001" }, platform: "discord", language: "en" })
  expect(archiveOf(it, DOOR)).toEqual({ category: "900000000000000001", readonlyRoles: ["800000000000000001"] })
  expect(topicCategoryOf(it, DOOR)).toBeNull()
  // The one runner that serves a machine, and only one the file keeps running.
  expect(runnerOfMachine(it, "mac")).toMatchObject({ runner: { id: "runner-mac" } })
  // A person that names nothing has nothing: no General, no defaults, and it is a plain answer and not a guess.
  expect(generalOf(it, "p2")).toBeNull()
  expect(topicDefaultsFor(it, "p2", DOOR)).toEqual({ machine: null, preset: null })
  expect(archiveOf(registry({ door: { archive_category: undefined, archive_readonly_roles: undefined } }), DOOR)).toBeNull()
})

test("a door's own setting overrides the person's, and the answer says which said it", () => {
  const it = registry({ door: { topic_machine: "mac", topic_preset: "fast", topic_category: "900000000000000002" } })
  expect(topicDefaultsFor(it, "p1", DOOR)).toEqual({ machine: { value: "mac", from: "door" }, preset: { value: "fast", from: "door" } })
  expect(topicCategoryOf(it, DOOR)).toBe("900000000000000002")
})

test("every wrong topic setting is refused by its key, and a General is only ever the person's own agent with a chat and no role", () => {
  expect(refusal({ person: { topic_machine: "nowhere" } }).key).toBe("people[0].topic_machine")
  expect(refusal({ person: { topic_preset: "missing" } }).key).toBe("people[0].topic_preset")
  expect(refusal({ person: { topic_machine: "" } }).key).toBe("people[0].topic_machine")
  expect(refusal({ door: { topic_machine: "nowhere" } }).key).toBe("run[0].topic_machine")
  expect(refusal({ door: { topic_preset: "missing" } }).key).toBe("run[0].topic_preset")
  // Another person's chat is not this person's General, and neither is a seat, an agent with no chat or one that is not there.
  for (const general of ["p2-lair", "p1-seat", "p1-jobs", "p1-nobody"]) {
    const refused = refusal({ person: { general } })
    expect(refused.key, general).toBe("people[0].general")
  }
  // The archive mapping is a category and the roles that are denied in it, together, as Discord ids, on a Discord door.
  expect(refusal({ door: { archive_readonly_roles: undefined } }).message).toContain("archive_readonly_roles")
  expect(refusal({ door: { archive_category: undefined } }).message).toContain("archive_category")
  expect(refusal({ door: { archive_category: "the-archive" } }).key).toBe("run[0].archive_category")
  expect(refusal({ door: { archive_readonly_roles: [] } }).key).toBe("run[0].archive_readonly_roles")
  expect(refusal({ door: { platform: "telegram" } }).message).toContain("only a Discord door")
})

test("the setup is resolved explicit first, then the door, then the person, and both defaults are named in what is returned", () => {
  const asked = { person: "p1", door: DOOR, chat_name: "coffee" }
  const plain = resolveTopicSetup(registry(), asked)
  expect(plain).toMatchObject({ ok: true, chat_name: "coffee", machine: "pi", machine_from: "person", runner: "runner-pi",
    preset: "daily", preset_from: "person", adapter: "synthetic", model: "m-daily" })

  const byDoor = resolveTopicSetup(registry({ door: { topic_machine: "mac", topic_preset: "fast" } }), asked)
  expect(byDoor).toMatchObject({ ok: true, machine: "mac", machine_from: "door", runner: "runner-mac", preset: "fast", preset_from: "door", model: "m-fast" })

  // An explicit choice beats both, per field: the machine can be explicit while the preset is still the default.
  const explicit = resolveTopicSetup(registry({ door: { topic_machine: "mac", topic_preset: "fast" } }), { ...asked, execution_machine: "pi" })
  expect(explicit).toMatchObject({ ok: true, machine: "pi", machine_from: "request", preset: "fast", preset_from: "door" })
  const both = resolveTopicSetup(registry(), { ...asked, execution_machine: "mac", preset: "fast" })
  expect(both).toMatchObject({ ok: true, machine: "mac", machine_from: "request", preset: "fast", preset_from: "request" })
})

test("nothing is invented: a missing default, an unknown name, a machine nothing serves or two serve are refused by name, and before a preview exists", () => {
  const asked = { person: "p1", door: DOOR, chat_name: "coffee" }
  const code = (it: Registry, over: Record<string, unknown> = {}) => {
    const answer = resolveTopicSetup(it, { ...asked, ...over } as never)
    return answer.ok ? "resolved" : answer.code
  }
  // Neither the request, the door nor the person names a machine, and the same for the preset.
  expect(code(registry({ person: { topic_machine: undefined } }))).toBe("execution_machine_missing")
  expect(code(registry({ person: { topic_preset: undefined } }))).toBe("preset_missing")
  expect(code(registry(), { execution_machine: "cloud" })).toBe("execution_machine_unknown")
  expect(code(registry(), { preset: "gigantic" })).toBe("preset_unknown")
  expect(code(registry(), { chat_name: "   " })).toBe("chat_name_invalid")
  expect(code(registry(), { chat_name: "x".repeat(101) })).toBe("chat_name_invalid")
  expect(code(registry(), { chat_name: "two\nlines" })).toBe("chat_name_invalid")
  // A machine with no runner the file keeps running, and one with two, is not chosen for the person.
  const noRunner = registry({ run: spec().run!.filter(one => one.id !== "runner-mac") })
  expect(code(noRunner, { execution_machine: "mac" })).toBe("execution_machine_has_no_runner")
  expect(runnerOfMachine(noRunner, "mac")).toMatchObject({ refused: "none" })
  const stopped = registry({ run: spec().run!.map(one => one.id === "runner-mac" ? { ...one, enabled: false } : one) })
  expect(code(stopped, { execution_machine: "mac" })).toBe("execution_machine_has_no_runner")
  const two = registry({ run: [...spec().run!, { id: "runner-mac-2", kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 }] })
  expect(code(two, { execution_machine: "mac" })).toBe("execution_machine_has_several_runners")
  // A refusal says which key to set.
  const missing = resolveTopicSetup(registry({ person: { topic_machine: undefined } }), asked)
  expect(missing.ok ? "" : missing.message).toContain("topic_machine")
  // A registry that declares no machines has nothing to choose between.
  const none = registry({ machines: [], run: spec().run!.map(({ machine: _machine, ...rest }) => rest), person: { topic_machine: undefined } })
  expect(code(none)).toBe("no_machines_declared")
})

test("a move's destination is the machine that was named and the one runner that serves it: never a default, and every unusable machine is refused by name", () => {
  const code = (it: Registry, machine: string) => {
    const answer = resolveMoveDestination(it, machine)
    return answer.ok ? "resolved" : answer.code
  }
  // The person's and the door's `topic_machine` are for making a chat: a move resolves only what it is given.
  const defaults = registry({ person: { topic_machine: "pi" }, door: { topic_machine: "pi" } })
  expect(resolveMoveDestination(defaults, "mac")).toEqual({ ok: true, machine: "mac", runner: "runner-mac" })
  expect(resolveMoveDestination(defaults, "pi")).toEqual({ ok: true, machine: "pi", runner: "runner-pi" })
  expect(code(defaults, "cloud")).toBe("execution_machine_unknown")
  expect(code(defaults, "")).toBe("execution_machine_unknown")
  const unknown = resolveMoveDestination(defaults, "cloud")
  expect(unknown.ok ? "" : unknown.message).toContain("cloud")
  expect(unknown.ok ? "" : unknown.message).not.toContain("topic_machine")
  // A machine nothing serves, one the file stopped, and one with two runners are not chosen for the owner.
  expect(code(registry({ run: spec().run!.filter(one => one.id !== "runner-mac") }), "mac")).toBe("execution_machine_has_no_runner")
  expect(code(registry({ run: spec().run!.map(one => one.id === "runner-mac" ? { ...one, enabled: false } : one) }), "mac")).toBe("execution_machine_has_no_runner")
  const two = registry({ run: [...spec().run!, { id: "runner-mac-2", kind: "runner", machine: "mac", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 }] })
  expect(code(two, "mac")).toBe("execution_machine_has_several_runners")
  const several = resolveMoveDestination(two, "mac")
  expect(several.ok ? "" : several.message).toContain("runner-mac-2")
  // A registry that declares no machines has nothing to name.
  const none = registry({ machines: [], run: spec().run!.map(({ machine: _machine, ...rest }) => rest), person: { topic_machine: undefined } })
  expect(code(none, "mac")).toBe("no_machines_declared")
})

test("where something that needs the person goes: the chat that can take it, else their General when General can, else nowhere and it says so", () => {
  const it = registry()
  const origin = { door: DOOR, chat: "1000000001" }
  // A chat that can take it gets it.
  expect(attentionRoute(it, { person: "p1", origin, originUsable: true, generalUsable: true })).toMatchObject({ ok: true, via: "origin", agent: "p1-general" })
  // A chat that cannot (archived, gone) sends it to General, which is the person's configured chat and no other.
  const elsewhere = { door: DOOR, chat: "1000000009" }
  expect(attentionRoute(it, { person: "p1", origin: elsewhere, originUsable: false, generalUsable: true }))
    .toMatchObject({ ok: true, via: "general", agent: "p1-general", route: { door: DOOR, chat: "1000000001" } })
  expect(attentionRoute(it, { person: "p1", origin: null, originUsable: false, generalUsable: true })).toMatchObject({ ok: true, via: "general" })
  // General itself cannot take it: there is nowhere else to say it, and no chat is picked because it looks like one.
  expect(attentionRoute(it, { person: "p1", origin, originUsable: false, generalUsable: true })).toEqual({ ok: false, cause: "general_unusable" })
  // A General that is configured but whose chat cannot take a line (archived, gone) is not assumed to: it was measured, and it is named.
  expect(attentionRoute(it, { person: "p1", origin: elsewhere, originUsable: false, generalUsable: false })).toEqual({ ok: false, cause: "general_unusable" })
  expect(attentionRoute(it, { person: "p1", origin: null, originUsable: false, generalUsable: false })).toEqual({ ok: false, cause: "general_unusable" })
  // ...and it does not matter to a chat that can take the line itself.
  expect(attentionRoute(it, { person: "p1", origin, originUsable: true, generalUsable: false })).toMatchObject({ ok: true, via: "origin" })
  // No General configured: named, and never another of the person's chats.
  const bare = registry({ person: { general: undefined } })
  expect(attentionRoute(bare, { person: "p1", origin: elsewhere, originUsable: false, generalUsable: true })).toEqual({ ok: false, cause: "general_not_configured" })
  // A chat the registry does not know for this person is not somewhere to send anything.
  expect(attentionRoute(it, { person: "p1", origin: { door: DOOR, chat: "1000000002" }, originUsable: true, generalUsable: true })).toEqual({ ok: false, cause: "origin_unknown" })
})

test("the ordinary masters of a door are its agents with a chat and no role, General among them: workers, seats and other doors' agents are not, and the answer is the same each time", () => {
  const it = registry({ agents: [{ id: "p1-coffee", person: "p1", preset: "fast", chat: "1000000077", door: DOOR, runner: "runner-mac" }] })
  const masters = legacyMastersOf(it, DOOR)
  expect(masters.map(one => one.agent.id)).toEqual(["p1-coffee", "p1-general"])
  expect(masters.find(one => one.agent.id === "p1-coffee")).toMatchObject({ machine: "mac", runner: "runner-mac", preset: "fast", adapter: "synthetic" })
  expect(masters.map(one => one.agent.id)).not.toContain("p1-jobs")
  expect(masters.map(one => one.agent.id)).not.toContain("p1-seat")
  expect(legacyMastersOf(it, "door-d2").map(one => one.agent.id)).toEqual(["p2-lair"])
  expect(legacyMastersOf(it, DOOR).map(one => one.agent.id)).toEqual(masters.map(one => one.agent.id))
})

test("an adopted master is bound only where the registry still binds it: the full eligible binding, and each way it is not is named", () => {
  const it = registry({ agents: [{ id: "p1-coffee", person: "p1", preset: "fast", chat: "1000000077", door: DOOR, runner: "runner-mac" }] })
  const topic = { agent_id: "p1-coffee", person: "p1", door: DOOR, chat: "1000000077" }
  expect(legacyBindingOf(it, topic)).toMatchObject({ ok: true, master: { machine: "mac", runner: "runner-mac", preset: "fast" } })
  // Retired: the id is not in the registry at all.
  expect(legacyBindingOf(it, { ...topic, agent_id: "p1-retired" })).toEqual({ ok: false, code: "agent_gone", agent: null })
  // Another person's agent now, whatever the route.
  expect(legacyBindingOf(it, { ...topic, person: "p2" })).toMatchObject({ ok: false, code: "person_changed" })
  // A seat has a role and a worker has no chat: neither is an ordinary master, so neither has a route to watch.
  expect(legacyBindingOf(it, { agent_id: "p1-seat", person: "p1", door: DOOR, chat: "1000000001" })).toEqual({ ok: false, code: "role_changed", agent: null })
  expect(legacyBindingOf(it, { agent_id: "p1-jobs", person: "p1", door: DOOR, chat: "1000000001" })).toEqual({ ok: false, code: "not_eligible", agent: null })
  // The entry was edited onto another door or another chat: the registry's answer is given, and the topic's route is not it.
  expect(legacyBindingOf(it, { ...topic, door: "door-d2" })).toMatchObject({ ok: false, code: "door_changed", agent: { id: "p1-coffee", door: DOOR, chat: "1000000077" } })
  expect(legacyBindingOf(it, { ...topic, chat: "1000000012" })).toMatchObject({ ok: false, code: "chat_changed", agent: { id: "p1-coffee", door: DOOR, chat: "1000000077" } })
  expect(legacyBindingOf(it, { ...topic, chat: null })).toMatchObject({ ok: false, code: "chat_changed" })
})

test("a door that cannot make a chat is known from the registry alone, before a preview: one with no guild, one that is not Discord, one that is not there", () => {
  expect(canMakeChats(registry(), DOOR)).toEqual({ ok: true })
  const noGuild = canMakeChats(registry({ door: { guild: undefined } }), DOOR)
  expect(noGuild).toMatchObject({ ok: false, code: "create_unsupported" })
  expect(noGuild.ok ? "" : noGuild.message).toContain("guild")
  expect(canMakeChats(registry(), "door-nowhere")).toMatchObject({ ok: false, code: "create_unsupported" })
})

test("the preview is the labels in the owner's order, then the request exactly as it will be sent, and nothing added to it", () => {
  const request = "Compare the two vendors.\n\n* keep it short\n* `code` and <b>markup</b> stay as they are\nThanks!"
  const text = topicPreview("en", { chat_name: "coffee", machine: "pi", adapter: "claude-code", model: "opus", initial_request: request })
  expect(text).toBe(`Chat: coffee\nExecution machine: pi\nAgent: Claude Code (opus)\n\n${request}`)
  expect(text.split("\n").slice(0, 3).map(line => line.split(":")[0])).toEqual(["Chat", "Execution machine", "Agent"])
  // No explanation beside the machine, and no closing line of any kind after the request.
  expect(text).not.toMatch(/where|will run|will be executing/i)
  expect(text.endsWith(request)).toBe(true)
  // A tool profile is shown after the request, only when one was asked for.
  expect(topicPreview("en", { chat_name: "coffee", machine: "pi", adapter: "synthetic", model: "m", initial_request: request, tool_profile: ["WebFetch"] }))
    .toBe(`Chat: coffee\nExecution machine: pi\nAgent: synthetic (m)\n\n${request}\n\nTools: WebFetch`)
  // The Russian labels are the household's language, the request is the owner's own words in either.
  const ru = topicPreview("ru", { chat_name: "кофе", machine: "pi", adapter: "claude-code", model: "opus", initial_request: "Сравни двух поставщиков" })
  expect(ru.split("\n")[0]).toBe("Чат: кофе")
  expect(ru.endsWith("Сравни двух поставщиков")).toBe(true)
  expect(topicConfirmationAsk("en")).toContain("✅")
  expect(topicConfirmationAsk("ru")).toContain("✅")
  // What is hashed is what is shown: a change to any of the labels, the request or the payload is another hash.
  const payload = { chat_name: "coffee", machine: "pi" }
  const one = previewHash("topic.create", payload, text, topicConfirmationAsk("en"))
  expect(previewHash("topic.create", payload, text.replace("pi", "mac"), topicConfirmationAsk("en"))).not.toBe(one)
  expect(previewHash("topic.create", { ...payload, machine: "mac" }, text, topicConfirmationAsk("en"))).not.toBe(one)
})
