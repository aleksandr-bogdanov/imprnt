// What an owner reads about a move, and the family every block lands in. Pure: no store, no registry, no clock.
//
// NEW CODES. The sets below are the ones the runtime and the hub export TODAY. A code a later slice adds to them lands in a family by
// membership, prefix or the side that set it, and the "every code" check here walks the sets as they are, so it covers a new code the moment it
// is added. Nothing in this file claims support for a code that is not in a set: the final wording per code is reviewed once the merged tree
// renders them.

import { expect, test } from "bun:test"
import { MOVE_FAMILIES, CLEARED_BY, SCOPE_REASONS, STORE_CODES, moveFamilyOf, type MoveFamily } from "../src/mcp/move-status.ts"
import {
  MOVE_COMMANDS, moveActions, moveActiveNotice, moveDoorRefusalLine, moveRefusalLine, moveSeenLine, moveStatusLine, moveWithdrawnNotice, seenCommand, withdrawCommand,
  type MoveDoorKind, type MoveLineFacts,
} from "../src/door/move-lines.ts"
import { MACHINERY_LINES, type Language } from "../src/door/lines.ts"
import { HUB_CODES } from "../src/hub/moves.ts"
import { EXPORT_CODES } from "../src/runner/move-export.ts"
import { PREFLIGHT_CODES } from "../src/runner/move-import.ts"
import { BLOCK } from "../src/runner/move.ts"
import { SERVE_CODES } from "../src/runner/move-serve.ts"
import { MOVE_STAGES } from "../src/store/moves.ts"

const LANGUAGES: Language[] = ["en", "ru"]
/** The internal id of a move's gate or chat line (`move:<id>`). A command the owner is told to send (`/move`, `/move: it shows ...`) is not one. */
const INTERNAL_MOVE_ID = /(?<![/\w])move:/i
const EVERY_CODE = [...new Set([...HUB_CODES, ...EXPORT_CODES, ...SERVE_CODES, ...PREFLIGHT_CODES, BLOCK, ...Object.keys(STORE_CODES), ...SCOPE_REASONS])].sort()

/** A move's id, as a line may carry it only inside the exact withdrawal command. */
const MOVE = "mv-7c1e"

const facts = (over: Partial<MoveLineFacts> = {}): MoveLineFacts => ({
  move: MOVE, family: null, stage: "waiting", platform: "discord", name: "coffee", chat: "1000000002", source: "pi", dest: "mac",
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
  // A serve block about the configuration is the person's settings and not a mismatch of what was loaded.
  for (const code of SERVE_CODES) expect(moveFamilyOf({ code, by: "dest" }), code).toBe(code.startsWith("serve_config_") ? "config_differs" : "loaded_mismatch")
})

test("the workspace and configuration blocks of the handoff are the owner's own to fix, in families of their own and never the source's 'has not shown it stopped'", () => {
  const table: Record<string, MoveFamily> = {
    config_mismatch: "config_differs", config_unverifiable: "config_differs", dest_config_changed: "config_differs",
    dest_config_unverifiable: "config_differs", serve_config_changed: "config_differs", serve_config_unverifiable: "config_differs",
    workspace_unsynced: "source_workspace", workspace_unpushed: "source_workspace", workspace_branch: "source_workspace",
    workspace_unavailable: "source_workspace", workspace_plan_mismatch: "source_workspace",
    dest_workspace_moved: "destination_workspace", dest_workspace_busy: "destination_workspace", dest_workspace_branch: "destination_workspace",
    dest_workspace_dirty: "destination_workspace", dest_workspace_behind: "destination_workspace", dest_workspace_ahead: "destination_workspace",
    dest_workspace_divergent: "destination_workspace", dest_workspace_unavailable: "destination_workspace",
    repository_unsynced: "workspace_not_carried", too_many_repositories: "workspace_not_carried",
    nested_repository_unproven: "workspace_not_carried", not_a_checkout: "workspace_not_carried",
  }
  for (const [code, family] of Object.entries(table)) {
    // Whoever raised it and wherever it was exported from, the family is by the code.
    for (const by of ["source", "dest", "hub", "store", undefined]) expect(moveFamilyOf({ code, by }), `${code} by ${by}`).toBe(family)
  }
  for (const family of ["config_differs", "source_workspace", "destination_workspace"] as const) expect(CLEARED_BY[family]).toBe("side")
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
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|topic-move|operation|execution|attempt_id/i)
      expect(text).not.toMatch(INTERNAL_MOVE_ID)
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

test("every family, in both languages and wherever it is said, is made of its own words with no slot, code or id, never names General, and the files-and-settings families say what has to be true without advising that anything be thrown away", () => {
  const ACTION: Partial<Record<MoveFamily, Record<Language, string>>> = {
    source_workspace: { en: "each declared repository has to be clean, on its declared branch and pushed", ru: "каждый объявленный репозиторий должен быть чистым, на своей ветке и отправленным" },
    destination_workspace: { en: "clean and at exactly the handed-off commit", ru: "чистым и ровно на переданном коммите" },
    config_differs: { en: "the same on pi and mac", ru: "одинаковыми на pi и mac" },
    workspace_not_carried: { en: "Declare the repositories it uses, with sync enabled on both machines", ru: "Объявите репозитории, которые он использует, с включённой синхронизацией на обеих машинах" },
  }
  const destructive = /discard|delete|remove|wipe|reset|overwrit|throw away|erase|сброс|удал|сотр|стер|отбро/i
  for (const family of MOVE_FAMILIES) {
    for (const language of LANGUAGES) {
      for (const inTopic of [false, true]) {
        const text = moveStatusLine(language, forFamily(family, { inTopic }))
        const where = `${family} ${language} inTopic=${inTopic}`
        expect(text, where).not.toMatch(/[{}]|\bt-[0-9a-f]|[0-9a-f]{8}-[0-9a-f]{4}/)
        expect(text, where).not.toMatch(INTERNAL_MOVE_ID)
        for (const code of EVERY_CODE) expect(text, `${where} says ${code}`).not.toContain(code)
        expect(text, where).not.toMatch(/General/i)
        const action = ACTION[family]?.[language]
        if (action !== undefined) {
          expect(text, where).toContain(action)
          // What has to be true is said without any step that costs the owner their work, and without a replay.
          expect(text, where).not.toMatch(destructive)
          expect(text, where).not.toMatch(/\bresume|\breplay|возобнов|повторно запу/i)
        }
      }
    }
  }
  // These four are told what to make true and no longer the generic "stays on hold until that is sorted out there".
  for (const family of Object.keys(ACTION) as MoveFamily[]) expect(moveStatusLine("en", forFamily(family))).not.toContain("until that is sorted out there")
  expect(moveStatusLine("en", forFamily("registry"))).toContain("until that is sorted out there")
  // The configuration is named by what is compared and what is not, and no value of it is shown.
  expect(moveStatusLine("en", forFamily("config_differs"))).toContain("the engine login and the hub's own server are not compared")
  expect(moveStatusLine("en", forFamily("config_differs"))).toContain("no values are shown here")
})

test("said in the topic's own chat a move names the door's commands in the person's language, and offers each only where it really works", () => {
  const withdraw = { en: `by sending /move withdraw ${MOVE} here`, ru: `отправив /перенос отозвать ${MOVE} здесь` }
  expect(withdrawCommand("en", MOVE)).toBe(`/move withdraw ${MOVE}`)
  expect(withdrawCommand("ru", MOVE)).toBe(`/перенос отозвать ${MOVE}`)
  for (const language of LANGUAGES) {
    const cmd = MOVE_COMMANDS[language]
    const here = moveStatusLine(language, facts({ inTopic: true }))
    expect(here, language).toContain(`${cmd.status} `)
    expect(here, language).toContain(withdraw[language])
    // The id is in the exact command and nowhere else, and the bare withdrawal is never what is offered.
    expect(here.split(MOVE), language).toHaveLength(2)
    expect(here, language).not.toContain(`${cmd.withdraw} ${language === "en" ? "here" : "здесь"}`)
    // Said anywhere else the owner is not pointed at a command: that chat is where they already are, and the id is not said at all.
    expect(moveStatusLine(language, facts()), language).not.toMatch(/\/move|\/перенос/)
    for (const stage of MOVE_STAGES) expect(moveStatusLine(language, facts({ stage })), `${language} ${stage}`).not.toContain(MOVE)
    for (const family of MOVE_FAMILIES) expect(moveStatusLine(language, forFamily(family)), `${language} ${family}`).not.toContain(MOVE)
    // A move past the point of withdrawal, and a turn still finishing, never show the withdrawal command.
    expect(moveStatusLine(language, facts({ stage: "activated", withdrawable: false, inTopic: true })), language).not.toContain(cmd.withdraw)
    expect(moveStatusLine(language, facts({ finishing: true, inTopic: true })), language).not.toContain(cmd.withdraw)
    expect(moveStatusLine(language, facts({ unresolved: true, inTopic: true })), language).not.toContain(cmd.withdraw)
  }
  // Where the held messages are answered is never promised to be the destination while the move can still be withdrawn.
  expect(moveStatusLine("en", facts({ inTopic: true }))).toContain("on mac if it goes through, on pi if it is withdrawn")
  expect(moveStatusLine("ru", facts({ inTopic: true }))).toContain("на mac, если перенос состоится, и на pi, если его отозвать")
  const past = moveStatusLine("en", facts({ stage: "activated", withdrawable: false, inTopic: true }))
  expect(past).toContain("answered after it ends: on mac.")
  expect(past).not.toContain("if it is withdrawn")
  // A move that has ended says nothing about a gate.
  expect(moveStatusLine("en", facts({ stage: "withdrawn", withdrawable: false, inTopic: true }))).not.toContain("messages here are kept")
})

test("the acknowledgement is shown only at an interruption with no turn held, and only as the exact command for the attempt and revision that were shown", () => {
  const failure = { attempt: "att-9", revision: 4 }
  expect(seenCommand("en", failure)).toBe("/move seen att-9 4")
  expect(seenCommand("ru", failure)).toBe("/перенос принято att-9 4")
  const waitingOwner = facts({ stage: "awaiting_owner", inTopic: true, failure })
  expect(moveActions(waitingOwner)).toEqual(["continue", "withdraw"])
  expect(moveStatusLine("en", waitingOwner)).toContain("Send /move seen att-9 4 here and the move goes back to waiting")
  expect(moveStatusLine("ru", waitingOwner)).toContain("Напишите /перенос принято att-9 4 здесь")
  expect(moveStatusLine("en", waitingOwner)).toContain("that does not continue the interrupted work, which stays held")
  // Never bare: with no interruption known there is no command to show, and no other stage shows one.
  expect(moveStatusLine("en", facts({ stage: "awaiting_owner", inTopic: true }))).not.toContain("/move seen")
  for (const stage of MOVE_STAGES.filter(one => one !== "awaiting_owner")) expect(moveStatusLine("en", facts({ stage, inTopic: true, failure })), stage).not.toContain("/move seen")
  // A turn that is owned refuses it, so it is not offered: the line says to send the command again once the turn is over.
  for (const held of [{ finishing: true }, { unresolved: true }]) {
    const text = moveStatusLine("en", facts({ stage: "awaiting_owner", inTopic: true, failure, ...held }))
    expect(text).not.toContain("/move seen")
  }
  expect(moveStatusLine("en", facts({ stage: "awaiting_owner", inTopic: true, failure, finishing: true }))).toContain("the command is then sent here again")
  // Said anywhere else the model is asked, and the attempt is not in the words the owner reads.
  const elsewhere = moveStatusLine("en", facts({ stage: "awaiting_owner", failure }))
  expect(elsewhere).toContain("Tell me you have seen it")
  expect(elsewhere).not.toContain("att-9")
})

test("the notice that a move went through is the door's own line, names the chat and never the agent, and says 'this chat' only where it lands in that chat", () => {
  const AGENT = "p1-coffee"
  for (const language of LANGUAGES) {
    const named = { platform: "discord", name: "coffee", agent: AGENT, chat: "1000000002", source: "pi", dest: "mac" }
    const text = moveActiveNotice(language, named)
    expect(text.startsWith(`${MACHINERY_LINES[language]} `), language).toBe(true)
    expect(text).toContain("<#1000000002>")
    expect(text).toContain("mac")
    expect(text).not.toContain(AGENT)
    const adopted = { platform: "telegram", name: AGENT, agent: AGENT, chat: null, source: "pi", dest: "mac" }
    const HERE = language === "en" ? "“this chat”" : "«этот чат»"
    const MOVED = language === "en" ? "“the chat being moved”" : "«переносимый чат»"
    expect(moveActiveNotice(language, { ...adopted, inTopic: true })).toContain(HERE)
    expect(moveActiveNotice(language, adopted)).toContain(MOVED)
    expect(moveActiveNotice(language, adopted)).not.toContain(HERE)
    expect(moveActiveNotice(language, adopted)).not.toContain(AGENT)
    expect(moveActiveNotice(language, { ...adopted, inTopic: true })).not.toContain(AGENT)
  }
  expect(moveActiveNotice("en", { platform: "discord", name: "coffee", chat: "1", dest: "mac" })).toContain("now runs on mac. Same conversation and history; messages that waited are answered there.")
})

test("what the door answers to a command that is not a standing says that nothing was changed, is the door's own line, and offers only what works", () => {
  // The leak check itself: an internal id is caught wherever it sits, the command the owner is told to send is not.
  for (const leak of ["move:3f2a", "gate move:3f2a", "(move:fake:1:7001)", "topic-move:3f2a"]) expect(leak).toMatch(INTERNAL_MOVE_ID)
  for (const command of ["Send /move: it shows", "Send /move, it shows", "/move: it", "Отправьте /перенос: там"]) expect(command).not.toMatch(INTERNAL_MOVE_ID)
  const kinds: MoveDoorKind[] = ["none", "usage", "older_message", "other_move", "before_interruption", "message_conflict", "other_interruption", "nothing_to_acknowledge"]
  for (const language of LANGUAGES) {
    for (const kind of kinds) {
      const text = moveDoorRefusalLine(language, kind)
      expect(text.startsWith(`${MACHINERY_LINES[language]} `), `${kind} ${language}`).toBe(true)
      expect(text, `${kind} ${language}`).not.toMatch(/[{}]|[0-9a-f]{8}-[0-9a-f]{4}|withdraw_path/)
      expect(text, `${kind} ${language}`).not.toMatch(INTERNAL_MOVE_ID)
    }
    // A stale or retargeted answer sends the owner to the standing for the exact command, and says nothing was recorded.
    expect(moveDoorRefusalLine(language, "other_interruption")).toContain(MOVE_COMMANDS[language].status)
    expect(moveDoorRefusalLine(language, "older_message")).toContain(MOVE_COMMANDS[language].status)
    expect(moveDoorRefusalLine(language, "other_move")).toContain(MOVE_COMMANDS[language].status)
    expect(moveDoorRefusalLine(language, "usage")).toContain(`${MOVE_COMMANDS[language].seen} <`)
    // The usage names the move in the withdrawal, as a placeholder and never as the bare words.
    expect(moveDoorRefusalLine(language, "usage")).toContain(`${MOVE_COMMANDS[language].withdraw} <`)
  }
  expect(moveDoorRefusalLine("en", "older_message")).toContain("nothing was changed")
  expect(moveDoorRefusalLine("en", "other_move")).toContain("nothing was changed")
  expect(moveDoorRefusalLine("en", "other_interruption")).toContain("nothing was recorded")
  for (const language of LANGUAGES) {
    const seen = moveSeenLine(language, "waiting", "STANDING")
    expect(seen.startsWith(`${MACHINERY_LINES[language]} `)).toBe(true)
    expect(seen).toContain("STANDING")
  }
  expect(moveSeenLine("en", "waiting", "")).toContain("the interrupted work was not resumed, released or replayed")
  expect(moveSeenLine("en", "replay", "")).toContain("already acknowledged")
  expect(moveSeenLine("en", "awaiting_owner", "")).toContain("another interruption now stands")
  // Words about an older interruption, answered after the move stopped on a newer one: nothing is recorded, and the line never says the move is waiting again.
  expect(moveSeenLine("en", "superseded", "S")).toContain("nothing was recorded now")
  expect(moveSeenLine("en", "superseded", "S")).not.toContain("back to waiting")
  expect(moveSeenLine("ru", "superseded", "S")).not.toContain("вернулся к ожиданию")
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
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|operation|execution/i)
    expect(text).not.toMatch(INTERNAL_MOVE_ID)
  }
  expect(moveWithdrawnNotice("en", v)).toContain("Interrupted work, if there is any, still waits for your choice.")
  expect(moveWithdrawnNotice("en", { ...v, platform: "telegram", chat: null })).toContain("coffee")
})

test("every refusal line says nothing was done and offers nothing that is not open, and one said in the topic's own chat names the exact command to send again", () => {
  const v = { move: MOVE, platform: "discord", name: "coffee", chat: "1000000002", source: "pi", dest: "mac", requested: "pi" }
  for (const language of LANGUAGES) {
    for (const kind of ["turn_finishing", "too_late", "other_destination"] as const) {
      const text = moveRefusalLine(language, kind, v)
      expect(text.length, `${kind} ${language}`).toBeGreaterThan(30)
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}|operation|execution|withdraw_path_missing/i)
      expect(text).not.toMatch(INTERNAL_MOVE_ID)
      // Said anywhere but in the topic's own chat, the id is not said at all.
      expect(text, `${kind} ${language}`).not.toContain(MOVE)
    }
  }
  expect(moveRefusalLine("en", "turn_finishing", { ...v, inTopic: true })).toContain(`send /move withdraw ${MOVE} here again once it has ended`)
  expect(moveRefusalLine("ru", "turn_finishing", { ...v, inTopic: true })).toContain(`отправьте /перенос отозвать ${MOVE} здесь ещё раз`)
  // An acknowledgement refused the same way names its own exact command, and never the withdrawal's.
  const retry = "/move seen att-1 3"
  expect(moveRefusalLine("en", "turn_finishing", { ...v, inTopic: true, retry })).toContain(`send ${retry} here again once it has ended`)
  expect(moveRefusalLine("en", "turn_finishing", { ...v, inTopic: true, retry })).not.toContain("/move withdraw")
  expect(moveRefusalLine("en", "turn_finishing", v)).toContain("ask again once it has ended")
  expect(moveRefusalLine("en", "turn_finishing", v)).toContain("nothing is retried")
  expect(moveRefusalLine("en", "too_late", v)).not.toMatch(/ask again|try again|reopen/i)
  expect(moveRefusalLine("en", "other_destination", v)).toContain("not to pi")
  expect(moveRefusalLine("en", "other_destination", v)).toContain("mac")
})

const REFUSALS = ["turn_finishing", "turn_unresolved", "too_late", "other_destination"] as const

test("a chat whose only name is its agent's own id is 'this chat' only in a line delivered in that chat, and the chat being moved anywhere else; a name somebody gave it and a Discord mention are said as they are, and no line carries the id", () => {
  const AGENT = "p1-coffee"
  const HERE: Record<Language, string> = { en: "“this chat”", ru: "«этот чат»" }
  const MOVED: Record<Language, string> = { en: "“the chat being moved”", ru: "«переносимый чат»" }
  // An adopted chat on a platform with no mention: its display name was the agent's id.
  const adopted = { move: MOVE, platform: "telegram", name: AGENT, agent: AGENT, chat: null, source: "pi", dest: "mac" }
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
      ...MOVE_FAMILIES.map(family => moveStatusLine(language, forFamily(family, { ...adopted, inTopic: true }))),
      ...MOVE_STAGES.map(stage => moveStatusLine(language, facts({ ...adopted, stage, withdrawable: stage === "waiting", inTopic: true }))),
      ...REFUSALS.map(kind => moveRefusalLine(language, kind, { ...adopted, requested: "venus", inTopic: true })),
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
  expect(moveStatusLine("en", facts({ platform: "telegram", agent: AGENT, name: "coffee", chat: null, inTopic: true }))).toContain("coffee")
  expect(moveStatusLine("ru", facts({ platform: "telegram", agent: AGENT, name: "  ", chat: null }))).toContain(MOVED.ru)
  expect(moveStatusLine("ru", facts({ platform: "telegram", agent: AGENT, name: "  ", chat: null, inTopic: true }))).toContain(HERE.ru)
  // Where the platform has a mention the mention is said, and the id never is, whatever the name.
  const mention = moveStatusLine("en", facts({ platform: "discord", agent: AGENT, name: AGENT, chat: "1000000002" }))
  expect(mention).toContain("<#1000000002>")
  expect(mention).not.toContain(AGENT)
  // The agent is optional: a caller that does not know it says the name as before.
  expect(moveStatusLine("en", facts({ platform: "telegram", name: AGENT, chat: null }))).toContain(AGENT)
})
