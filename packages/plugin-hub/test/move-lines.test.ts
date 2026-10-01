// What an owner reads about a move, and the family every block lands in. Pure: no store, no registry, no clock.
//
// NEW CODES. The sets below are the ones the runtime and the hub export TODAY. A code a later slice adds to them lands in a family by
// membership, prefix or the side that set it, and the "every code" check here walks the sets as they are, so it covers a new code the moment it
// is added. Nothing in this file claims support for a code that is not in a set: the final wording per code is reviewed once the merged tree
// renders them.

import { expect, test } from "bun:test"
import { MOVE_FAMILIES, CLEARED_BY, SCOPE_REASONS, STORE_CODES, moveFamilyOf, type MoveFamily } from "../src/mcp/move-status.ts"
import { moveActions, moveRefusalLine, moveStatusLine, moveWithdrawnNotice, type MoveLineFacts } from "../src/door/move-lines.ts"
import { MACHINERY_LINES, type Language } from "../src/door/lines.ts"
import { HUB_CODES } from "../src/hub/moves.ts"
import { EXPORT_CODES } from "../src/runner/move-export.ts"
import { PREFLIGHT_CODES } from "../src/runner/move-import.ts"
import { BLOCK } from "../src/runner/move.ts"
import { SERVE_CODES } from "../src/runner/move-serve.ts"
import { MOVE_STAGES } from "../src/store/moves.ts"

const LANGUAGES: Language[] = ["en", "ru"]
const EVERY_CODE = [...new Set([...HUB_CODES, ...EXPORT_CODES, ...SERVE_CODES, ...PREFLIGHT_CODES, BLOCK, ...Object.keys(STORE_CODES), ...SCOPE_REASONS])].sort()

const facts = (over: Partial<MoveLineFacts> = {}): MoveLineFacts => ({
  family: null, stage: "waiting", platform: "discord", name: "coffee", chat: "1000000002", source: "pi", dest: "mac",
  destLive: true, sourceLive: true, finishing: false, withdrawable: true, chatState: "open", ...over,
})
/** What can be said about a family at the stage it is raised at: the registry and serve families are raised after activation. */
const stageOf = (family: MoveFamily): MoveLineFacts["stage"] => (family === "registry" || family === "loaded_mismatch" ? "activated" : "waiting")
const forFamily = (family: MoveFamily, over: Partial<MoveLineFacts> = {}) =>
  facts({ family, stage: stageOf(family), withdrawable: stageOf(family) === "waiting", chatState: family === "archived" ? "archived" : "open", ...over })

test("every code the runtime, the hub and the store name lands in a named family, and never in `other`", () => {
  expect(EVERY_CODE.length).toBeGreaterThan(40)
  for (const code of EVERY_CODE) {
    const family = moveFamilyOf({ code })
    expect(MOVE_FAMILIES, code).toContain(family)
    expect(family, `${code} has no family of its own`).not.toBe("other")
  }
  // The families the owner is told differently about, by what clears them.
  expect(moveFamilyOf({ code: "drain_owner_unknown", by: "store" })).toBe("owner_unknown")
  expect(moveFamilyOf({ code: "topic_not_active", by: "store" })).toBe("archived")
  expect(moveFamilyOf({ code: BLOCK, by: "source" })).toBe("source_unproven")
  expect(moveFamilyOf({ code: "scope_unproven", by: "source" })).toBe("source_unproven")
  expect(moveFamilyOf({ code: "scope_unsupported", by: "source" })).toBe("workspace_not_carried")
  for (const reason of SCOPE_REASONS) expect(moveFamilyOf({ code: reason })).toBe("workspace_not_carried")
  expect(moveFamilyOf({ code: "dest_profile_unbound", by: "dest" })).toBe("destination_setup")
  expect(moveFamilyOf({ code: "profile_mismatch", by: "source" })).toBe("destination_setup")
  expect(moveFamilyOf({ code: "native_build_unknown", by: "source" })).toBe("engine_session")
  expect(moveFamilyOf({ code: "native_dest_refused", by: "source" })).toBe("engine_session")
  for (const code of HUB_CODES) expect(moveFamilyOf({ code, by: "hub" }), code).toBe("registry")
  for (const code of SERVE_CODES) expect(moveFamilyOf({ code, by: "dest" }), code).toBe("loaded_mismatch")
})

test("a code nobody classified is read by its prefix, then by the side that set it, and `other` is the last resort and still a family", () => {
  expect(moveFamilyOf({ code: "native_something_new", by: "dest" })).toBe("engine_session")
  expect(moveFamilyOf({ code: "dest_something_new", by: "source" })).toBe("destination_setup")
  expect(moveFamilyOf({ code: "registry_something_new", by: "source" })).toBe("registry")
  expect(moveFamilyOf({ code: "serve_something_new", by: "source" })).toBe("loaded_mismatch")
  expect(moveFamilyOf({ code: "brand_new", by: "hub" })).toBe("registry")
  expect(moveFamilyOf({ code: "brand_new", by: "dest" })).toBe("destination_setup")
  expect(moveFamilyOf({ code: "brand_new", by: "source" })).toBe("source_unproven")
  expect(moveFamilyOf({ code: "brand_new", by: "store" })).toBe("other")
  expect(moveFamilyOf({ code: "brand_new" })).toBe("other")
  // Who clears a family is stated for every one of them, and only a withdrawal or a reopen is the owner's.
  expect(Object.keys(CLEARED_BY).sort()).toEqual([...MOVE_FAMILIES].sort())
  expect(CLEARED_BY.owner_unknown).toBe("withdraw")
  expect(CLEARED_BY.archived).toBe("reopen")
  for (const family of MOVE_FAMILIES.filter(one => one !== "owner_unknown" && one !== "archived")) expect(CLEARED_BY[family]).toBe("side")
})

test("every family has words in both languages, its own, and none of them is a code, an id or a promise that it will clear itself", () => {
  const seen = new Map<string, string>()
  for (const family of MOVE_FAMILIES) {
    for (const language of LANGUAGES) {
      const text = moveStatusLine(language, forFamily(family))
      expect(text.length, `${family} ${language}`).toBeGreaterThan(40)
      seen.set(`${language}:${family}`, text)
      for (const code of EVERY_CODE) expect(text, `${family} ${language} says ${code}`).not.toContain(code)
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|\bmove:|topic-move|operation|execution|attempt_id/i)
      // Nothing is promised to clear itself or to be retried.
      expect(text).not.toMatch(/\b(will|shall) (retry|try again|resume|continue by itself|fix itself)|automatically/i)
      expect(text).not.toMatch(/автоматическ|повторит(ся)? сам|будет повторен/i)
    }
    expect(seen.get(`en:${family}`)).not.toBe(seen.get(`ru:${family}`))
  }
  // Families do not share a sentence: an owner told the same thing for two reasons is told nothing.
  expect(new Set(MOVE_FAMILIES.map(family => seen.get(`en:${family}`))).size).toBe(MOVE_FAMILIES.length)
  expect(new Set(MOVE_FAMILIES.map(family => seen.get(`ru:${family}`))).size).toBe(MOVE_FAMILIES.length)
  // Names are the owner's own words: the machines and the chat, in that order of use, and nothing else of the move.
  expect(moveStatusLine("en", forFamily("source_unproven"))).toContain("<#1000000002>")
  expect(moveStatusLine("en", forFamily("source_unproven"))).toContain("pi")
  expect(moveStatusLine("en", forFamily("source_unproven", { platform: "telegram" }))).toContain("coffee")
})

test("every stage reads, in both languages, with no raw state name or id", () => {
  for (const stage of MOVE_STAGES) {
    for (const language of LANGUAGES) {
      const text = moveStatusLine(language, facts({ stage, withdrawable: stage === "waiting" || stage === "source_released" || stage === "importing" || stage === "awaiting_owner" }))
      expect(text.length, `${stage} ${language}`).toBeGreaterThan(20)
      expect(text).not.toMatch(/source_released|registry_written|awaiting_owner|importing|activated/)
    }
  }
})

test("a withdrawal is offered only while the move can be withdrawn and no turn is finishing, and past activation it says it is past", () => {
  const withdraw = (language: Language, f: MoveLineFacts) => moveStatusLine(language, f)
  for (const stage of ["waiting", "source_released", "importing"] as const) {
    expect(moveActions(facts({ stage }))).toContain("withdraw")
    expect(withdraw("en", facts({ stage }))).toContain("You can withdraw the move, and <#1000000002> stays on pi.")
    expect(withdraw("ru", facts({ stage }))).toContain("Перенос можно отозвать, и <#1000000002> останется на pi.")
  }
  for (const stage of ["activated", "registry_written"] as const) {
    const f = facts({ stage, withdrawable: false })
    expect(moveActions(f)).not.toContain("withdraw")
    expect(withdraw("en", f)).toContain("past the point of withdrawal")
    expect(withdraw("en", f)).not.toContain("You can withdraw")
    expect(withdraw("ru", f)).toContain("Отозвать перенос уже нельзя")
    // A block there is the side's own: no way out is invented for the owner.
    for (const family of ["registry", "loaded_mismatch"] as const) {
      const blocked = facts({ stage, withdrawable: false, family })
      expect(moveActions(blocked)).toEqual([])
      expect(withdraw("en", blocked)).not.toMatch(/withdraw the move|reopen/i)
    }
  }
  // A turn that is still finishing makes a withdrawal impossible this instant: it is said, and not offered.
  const finishing = facts({ finishing: true })
  expect(moveActions(finishing)).toEqual([])
  expect(withdraw("en", finishing)).toContain("still finishing")
  expect(withdraw("en", finishing)).not.toContain("You can withdraw")
  expect(withdraw("ru", finishing)).not.toContain("Перенос можно отозвать")
  // When the owner's only way forward is the withdrawal, it is said so.
  expect(withdraw("en", forFamily("owner_unknown"))).toContain("The only way forward is to withdraw the move")
  expect(moveActions(forFamily("owner_unknown"))).toEqual(["withdraw"])
})

test("an answer about an interruption is offered only where the move is waiting on one, and it is never worded as resuming the interrupted work", () => {
  const waitingOnOwner = facts({ stage: "awaiting_owner" })
  expect(moveActions(waitingOnOwner)).toEqual(["continue", "withdraw"])
  for (const stage of MOVE_STAGES.filter(one => one !== "awaiting_owner")) expect(moveActions(facts({ stage })), stage).not.toContain("continue")
  expect(moveActions(facts({ stage: "awaiting_owner", finishing: true }))).toEqual([])
  const en = moveStatusLine("en", waitingOnOwner)
  const ru = moveStatusLine("ru", waitingOnOwner)
  expect(en).toContain("Tell me you have seen it and the move goes back to waiting")
  expect(en).toContain("that does not continue the interrupted work, which stays held until you decide about it separately")
  expect(ru).toContain("прерванную работу это не продолжает, она остаётся удержанной")
  for (const text of [en, ru]) expect(text).not.toMatch(/resum|replay|re-run|release[sd]? the|возобнов|повтор|снимет/i)
  // The interruption is what is said first at that stage, even with a block noted on the move.
  expect(moveStatusLine("en", facts({ stage: "awaiting_owner", family: "source_unproven" }))).toContain("interrupted")
})

test("a reopen is offered only for a chat that is archived, and bringing a machine online only while the move waits on one", () => {
  expect(moveActions(forFamily("archived"))).toEqual(["reopen", "withdraw"])
  expect(moveStatusLine("en", forFamily("archived"))).toContain("Reopen the chat to let the move go on.")
  expect(moveStatusLine("ru", forFamily("archived"))).toContain("Откройте чат снова")
  for (const chatState of ["archiving", "reopening", "gone"] as const) {
    const f = forFamily("archived", { chatState })
    expect(moveActions(f), chatState).toEqual(["withdraw"])
    expect(moveStatusLine("en", f), chatState).not.toMatch(/Reopen/)
    expect(moveStatusLine("ru", f), chatState).not.toMatch(/Откройте/)
  }
  expect(moveStatusLine("en", forFamily("archived", { chatState: "gone" }))).toContain("deleted in Discord")
  // Waiting on a destination that is not connected says its name first, and offers to bring it online.
  const offline = facts({ destLive: false })
  expect(moveStatusLine("en", offline).startsWith("Waiting for mac:")).toBe(true)
  expect(moveStatusLine("ru", offline).startsWith("Ждём mac:")).toBe(true)
  expect(moveStatusLine("en", offline)).toContain("Bring mac online")
  expect(moveStatusLine("en", offline)).toContain("nothing moves to another machine")
  expect(moveStatusLine("en", facts({ destLive: true }))).not.toContain("Bring")
  expect(moveStatusLine("en", facts({ destLive: false, finishing: true }))).not.toContain("Bring")
  expect(moveStatusLine("en", facts({ sourceLive: false }))).toContain("Waiting for pi")
  // The destination, never the source, is what the move waits for when both are down.
  expect(moveStatusLine("en", facts({ destLive: false, sourceLive: false })).startsWith("Waiting for mac:")).toBe(true)
  // A family only the side can clear promises nothing and retries nothing.
  expect(moveStatusLine("en", forFamily("destination_setup"))).toContain("Nothing is retried for you.")
  expect(moveStatusLine("en", forFamily("destination_setup"))).not.toMatch(/Reopen|Bring/)
})

test("the withdrawal notice is the door's own line in the person's language, names the chat and the machines, and carries no id", () => {
  const v = { platform: "discord", name: "coffee", chat: "1000000002", source: "pi", dest: "mac" }
  for (const language of LANGUAGES) {
    const text = moveWithdrawnNotice(language, v)
    expect(text.startsWith(`${MACHINERY_LINES[language]} `)).toBe(true)
    expect(text).toContain("<#1000000002>")
    expect(text).toContain("pi")
    expect(text).toContain("mac")
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|\bmove:|operation|execution/i)
  }
  expect(moveWithdrawnNotice("en", v)).toContain("Interrupted work, if there is any, still waits for your choice.")
  expect(moveWithdrawnNotice("en", { ...v, platform: "telegram", chat: null })).toContain("coffee")
})

test("every refusal line says nothing was done, offers nothing that is not open, and puts the recovery-route limit on the version and not on the owner", () => {
  const v = { platform: "discord", name: "coffee", chat: "1000000002", source: "pi", dest: "mac", requested: "pi" }
  for (const language of LANGUAGES) {
    for (const kind of ["turn_finishing", "too_late", "recovery_route", "other_destination"] as const) {
      const text = moveRefusalLine(language, kind, v)
      expect(text.length, `${kind} ${language}`).toBeGreaterThan(30)
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|\bmove:|operation|execution|withdraw_path_missing/i)
    }
  }
  const route = moveRefusalLine("en", "recovery_route", v)
  expect(route).toContain("limit of the current version")
  expect(route).toContain("not a decision of yours")
  expect(route).not.toMatch(/not allowed|forbidden|disallow|you may not/i)
  expect(moveRefusalLine("en", "turn_finishing", v)).toContain("nothing is retried")
  expect(moveRefusalLine("en", "too_late", v)).not.toMatch(/ask again|try again|reopen/i)
  expect(moveRefusalLine("en", "other_destination", v)).toContain("not to pi")
  expect(moveRefusalLine("en", "other_destination", v)).toContain("mac")
})

const REFUSALS = ["turn_finishing", "turn_unresolved", "too_late", "recovery_route", "other_destination"] as const

test("a chat whose only name is its agent's own id is 'this chat' only in a line delivered in that chat, and the chat being moved anywhere else; a name somebody gave it and a Discord mention are said as they are, and no line carries the id", () => {
  const AGENT = "p1-coffee"
  const HERE: Record<Language, string> = { en: "“this chat”", ru: "«этот чат»" }
  const MOVED: Record<Language, string> = { en: "“the chat being moved”", ru: "«переносимый чат»" }
  // An adopted chat on a platform with no mention: its display name was the agent's id.
  const adopted = { platform: "telegram", name: AGENT, agent: AGENT, chat: null, source: "pi", dest: "mac" }
  const general = { platform: "telegram", chat: "7" }
  for (const language of LANGUAGES) {
    // Said anywhere but in the topic's own chat (General's inspect, withdraw and continue, a request made from General, a notice that fell back to General).
    const elsewhere = [
      ...MOVE_FAMILIES.map(family => moveStatusLine(language, forFamily(family, adopted))),
      ...MOVE_STAGES.map(stage => moveStatusLine(language, facts({ ...adopted, stage, withdrawable: stage === "waiting" }))),
      ...REFUSALS.map(kind => moveRefusalLine(language, kind, { ...adopted, requested: "venus" })),
      moveWithdrawnNotice(language, adopted),
    ]
    for (const line of elsewhere) {
      expect(line, `${language}: ${line}`).not.toContain(AGENT)
      expect(line, `${language}: ${line}`).toContain(MOVED[language])
      expect(line, `${language}: ${line}`).not.toContain(HERE[language])
    }
    // Delivered in the topic's own chat: that chat is "this chat".
    const inTopic = [
      ...MOVE_FAMILIES.map(family => moveStatusLine(language, forFamily(family, { ...adopted, inTopic: true, general }))),
      ...MOVE_STAGES.map(stage => moveStatusLine(language, facts({ ...adopted, stage, withdrawable: stage === "waiting", inTopic: true, general }))),
      ...REFUSALS.map(kind => moveRefusalLine(language, kind, { ...adopted, requested: "venus", inTopic: true, general })),
      moveWithdrawnNotice(language, { ...adopted, inTopic: true }),
    ]
    for (const line of inTopic) {
      expect(line, `${language}: ${line}`).not.toContain(AGENT)
      expect(line, `${language}: ${line}`).toContain(HERE[language])
      expect(line, `${language}: ${line}`).not.toContain(MOVED[language])
    }
  }
  // A name somebody gave the chat is the name, and an empty name is not said as nothing.
  expect(moveStatusLine("en", facts({ platform: "telegram", agent: AGENT, name: "coffee", chat: null }))).toContain("coffee")
  expect(moveStatusLine("en", facts({ platform: "telegram", agent: AGENT, name: "coffee", chat: null }))).not.toContain(MOVED.en)
  expect(moveStatusLine("en", facts({ platform: "telegram", agent: AGENT, name: "coffee", chat: null, inTopic: true, general }))).toContain("coffee")
  expect(moveStatusLine("ru", facts({ platform: "telegram", agent: AGENT, name: "  ", chat: null }))).toContain(MOVED.ru)
  expect(moveStatusLine("ru", facts({ platform: "telegram", agent: AGENT, name: "  ", chat: null, inTopic: true, general }))).toContain(HERE.ru)
  // Where the platform has a mention the mention is said, and the id never is, whatever the name.
  const mention = moveStatusLine("en", facts({ platform: "discord", agent: AGENT, name: AGENT, chat: "1000000002" }))
  expect(mention).toContain("<#1000000002>")
  expect(mention).not.toContain(AGENT)
  // The agent is optional: a caller that does not know it says the name as before.
  expect(moveStatusLine("en", facts({ platform: "telegram", name: AGENT, chat: null }))).toContain(AGENT)
})
