// What the owner reads where a move is asked from the chat being moved, what an unresolved attempt is called, and why a move is refused for want
// of a General. Pure: no store, no registry, no clock. The command-level checks are in `topic-move-command.test.ts`.

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { writeRegistry } from "./helpers/registry.ts"
import { moveActions, moveRefusalLine, moveStatusLine, recoveryReasonLine, type GeneralReason, type GeneralState, type MoveLineFacts, type RecoveryCause } from "../src/door/move-lines.ts"
import { senderReachesGeneral } from "../src/mcp/move-general.ts"
import type { Language } from "../src/door/lines.ts"
import { loadRegistry, type Registry } from "../src/registry/load.ts"

const LANGUAGES: Language[] = ["en", "ru"]
const facts = (over: Partial<MoveLineFacts> = {}): MoveLineFacts => ({
  family: null, stage: "waiting", platform: "discord", name: "coffee", chat: "1000000002", source: "pi", dest: "mac",
  destLive: true, sourceLive: true, finishing: false, withdrawable: true, chatState: "open", ...over,
})
const GENERAL = { platform: "discord", chat: "1000000009" }
const v = { platform: "discord", name: "coffee", chat: "1000000002", source: "pi", dest: "mac" }

test("said in the topic's own chat, a move names General for checking on it and withdrawing it, and never offers that control in a chat that is gated", () => {
  for (const [language, withdraw, only] of [
    ["en", "You can withdraw the move in General (<#1000000009>), and <#1000000002> stays on pi.", "The only way forward is to withdraw the move in General (<#1000000009>)"],
    ["ru", "Перенос можно отозвать в General (<#1000000009>), и <#1000000002> останется на pi.", "Единственный путь — отозвать перенос в General (<#1000000009>)"],
  ] as const) {
    const here = facts({ inTopic: true, general: GENERAL })
    expect(moveActions(here)).toEqual(["withdraw"])
    const text = moveStatusLine(language, here)
    expect(text).toContain("General (<#1000000009>)")
    expect(text).toContain(withdraw)
    expect(text).not.toContain(language === "en" ? "You can withdraw the move, and" : "Перенос можно отозвать, и")
    expect(moveStatusLine(language, facts({ inTopic: true, general: GENERAL, family: "owner_unknown" }))).toContain(only)
    // Said anywhere else there is no pointer: that chat is where the owner already is.
    expect(moveStatusLine(language, facts())).not.toContain("General")
  }
  // An interruption is answered in General as well.
  const waiting = facts({ stage: "awaiting_owner", inTopic: true, general: GENERAL })
  expect(moveActions(waiting)).toEqual(["continue", "withdraw"])
  expect(moveStatusLine("en", waiting)).toContain("In General (<#1000000009>), tell me you have seen it")
  expect(moveStatusLine("ru", waiting)).toContain("В General (<#1000000009>) скажите")
  // A platform with no mention names it as General.
  expect(moveStatusLine("en", facts({ inTopic: true, general: { platform: "telegram", chat: "7" } }))).toContain("in General,")
  // No General that is shown usable: no control is claimed in the gated chat, and the line says so.
  for (const general of [null, undefined]) {
    const none = facts({ inTopic: true, ...(general === null ? { general } : {}) })
    expect(moveActions(none)).toEqual([])
    for (const language of LANGUAGES) {
      expect(moveStatusLine(language, none)).not.toMatch(/You can withdraw|Перенос можно отозвать|tell me you have seen|Скажите, что вы это увидели/)
    }
    expect(moveStatusLine("en", none)).toContain("no General chat is shown to be usable")
  }
  // A move past the point of withdrawal or finished says nothing about a gate.
  expect(moveStatusLine("en", facts({ stage: "withdrawn", withdrawable: false, inTopic: true, general: GENERAL }))).not.toContain("takes no new message")
  // The refusal for a turn still finishing says where to ask again, or that there is nowhere.
  expect(moveRefusalLine("en", "turn_finishing", { ...v, inTopic: true, general: GENERAL })).toContain("ask again in General (<#1000000009>) once it has ended")
  expect(moveRefusalLine("ru", "turn_finishing", { ...v, inTopic: true, general: GENERAL })).toContain("попросите снова в General (<#1000000009>)")
  expect(moveRefusalLine("en", "turn_finishing", { ...v, inTopic: true, general: null })).toContain("nowhere to ask again")
  expect(moveRefusalLine("en", "turn_finishing", v)).toContain("ask again once it has ended")
})

test("an attempt that may never end by itself is unresolved and not 'still finishing': it says to restore what observes the source, refuses what a finishing turn refuses, and promises nothing", () => {
  const open = facts({ unresolved: true, sourceLive: false })
  const live = facts({ unresolved: true })
  for (const f of [open, live]) {
    expect(moveActions(f)).toEqual([])
    expect(moveActions(facts({ ...f, stage: "awaiting_owner" }))).toEqual([])
    for (const language of LANGUAGES) {
      const text = moveStatusLine(language, f)
      expect(text, language).not.toMatch(/still finishing|ещё не закончен|You can withdraw|Перенос можно отозвать|Bring mac|Подключите mac/)
      expect(text, language).not.toMatch(/\b(will|shall) (end|finish|complete|resume|replay|release)|automatically|автоматическ|будет (завершён|повторен|снят)/i)
      expect(text, language).not.toMatch(/resum|replay|unhold|release[sd]? the|возобнов|повтор(ит|ён)|снимет/i)
    }
  }
  // The source machine that is not connected is the one to bring online, so that it can be seen again.
  expect(moveStatusLine("en", open)).toContain("What <#1000000002> was answering on pi is unresolved")
  expect(moveStatusLine("en", open)).toContain("pi is not connected")
  expect(moveStatusLine("en", open)).toContain("Bring pi online so that it can be observed again")
  expect(moveStatusLine("ru", open)).toContain("Подключите pi")
  // A source that is connected has to report on it again, and nothing says it will.
  expect(moveStatusLine("en", live)).toContain("Until pi reports on it again, the move can neither be withdrawn nor go on.")
  expect(moveStatusLine("en", live)).not.toContain("Bring pi")
  expect(moveStatusLine("en", live)).toContain("Nothing is retried for you.")
  // A healthy turn is still said as finishing, and stays distinct.
  expect(moveStatusLine("en", facts({ finishing: true }))).toContain("still finishing")
  expect(moveStatusLine("en", facts({ finishing: true }))).not.toContain("unresolved")
  // The refusal agrees with the status and never asks for a retry.
  expect(moveRefusalLine("en", "turn_unresolved", { ...v, sourceLive: false })).toContain("is unresolved")
  expect(moveRefusalLine("en", "turn_unresolved", { ...v, sourceLive: false })).toContain("Bring pi online so that it can be observed again")
  expect(moveRefusalLine("en", "turn_unresolved", v)).toContain("Until pi reports on it again")
  expect(moveRefusalLine("ru", "turn_unresolved", { ...v, sourceLive: false })).toContain("Подключите pi")
  expect(moveRefusalLine("en", "turn_unresolved", v)).not.toMatch(/ask again|try again|still finishing/i)
  // An unresolved attempt in the topic's own chat does not claim control there either.
  expect(moveActions(facts({ unresolved: true, inTopic: true, general: GENERAL }))).toEqual([])
})

test("a General that cannot follow the move is refused with its real cause and next step in both languages, and never suggests what cannot be done", () => {
  const reasons: [GeneralReason, GeneralState | undefined][] = [
    ["no_general", undefined], ["general_is_the_topic", undefined], ["owner_not_in_general", undefined], ["general_binding_changed", undefined],
    ["general_not_open", "archived"], ["general_not_open", "archiving"], ["general_not_open", "reopening"], ["general_not_open", "gone"],
    ["general_not_open", "not_set_up"], ["general_not_open", "closed"], ["general_moving", undefined], ["general_gated", undefined], ["general_runner_offline", undefined],
    ["general_asleep", undefined], ["general_door_off", undefined], ["general_door_offline", undefined],
  ]
  const seen = new Set<string>()
  for (const [reason, state] of reasons) {
    const cause: RecoveryCause = { reason, ...(state === undefined ? {} : { state }), machine: "pi" }
    for (const language of LANGUAGES) {
      const line = moveRefusalLine(language, "recovery_route", { ...v, cause })
      seen.add(`${language}:${recoveryReasonLine(language, cause)}`)
      expect(line, `${reason} ${state} ${language}`).toContain(language === "en" ? "limit of the current version and not a decision of yours" : "ограничение текущей версии")
      expect(line, `${reason} ${state} ${language}`).not.toMatch(/withdraw_path_missing|general_|[0-9a-f]{8}-[0-9a-f]{4}|not allowed|forbidden|disallow|you may not/i)
    }
  }
  // Each cause has its own words, in each language.
  expect(seen.size).toBe(reasons.length * 2)
  const en = (reason: GeneralReason, state?: GeneralState) => recoveryReasonLine("en", { reason, ...(state === undefined ? {} : { state }), machine: "pi" })
  // A runner that is offline: the machine is named and is to be brought online.
  expect(en("general_runner_offline")).toContain("(pi) is not connected")
  expect(en("general_runner_offline")).toContain("Bring it online and ask again")
  expect(recoveryReasonLine("ru", { reason: "general_runner_offline", machine: "pi" })).toContain("Подключите её")
  // A General asleep is woken, and a door that is stopped is enabled, where one that is only not connected is brought online: each is its own step.
  expect(en("general_asleep")).toContain("Wake it, then ask again")
  expect(recoveryReasonLine("ru", { reason: "general_asleep" })).toContain("Разбудите его")
  expect(en("general_door_off")).toContain("(on pi) is switched off in the registry")
  expect(en("general_door_off")).toContain("Enable it, then ask again")
  expect(recoveryReasonLine("ru", { reason: "general_door_off", machine: "pi" })).toContain("Включите её")
  expect(en("general_door_offline")).toContain("(on pi) is not connected")
  expect(en("general_door_offline")).toContain("Bring it online and ask again")
  expect(recoveryReasonLine("ru", { reason: "general_door_offline", machine: "pi" })).toContain("Подключите её")
  expect(recoveryReasonLine("en", { reason: "general_door_offline" })).not.toContain("()")
  // Archived: asked again once open, and a reopen from another chat is not offered. Being archived or reopened: waited for.
  expect(en("general_not_open", "archived")).toContain("archived")
  expect(en("general_not_open", "archived")).toContain("cannot be asked for through me from another chat")
  expect(en("general_not_open", "archived")).not.toMatch(/Reopen it|reopen it/)
  expect(en("general_not_open", "archiving")).toContain("being archived")
  expect(en("general_not_open", "reopening")).toContain("being reopened")
  // Deleted: it is never suggested that it be reopened, the registry has to name a chat that exists.
  expect(en("general_not_open", "gone")).toContain("deleted in Discord and cannot be reopened")
  expect(en("general_not_open", "gone")).toContain("registry has to name a General chat that exists")
  expect(en("general_not_open", "gone")).not.toMatch(/Reopen it|reopen it/)
  // Nothing to do now, and no General at all.
  expect(en("general_is_the_topic")).toContain("nothing to do about it now")
  expect(en("no_general")).toContain("No General chat is configured")
  // No sender of this person on General's door: the registry is where one is configured, and nobody else's identity is suggested.
  expect(en("owner_not_in_general")).toContain("no sender configured on the door of your General chat")
  expect(en("owner_not_in_general")).toContain("Configure this person's sender for General's door in the registry, then ask again")
  expect(en("owner_not_in_general")).not.toMatch(/Ask as someone|someone who is|as someone/i)
  expect(recoveryReasonLine("ru", { reason: "owner_not_in_general" })).toContain("Настройте отправителя этого человека для двери General в реестре и попросите снова")
  expect(recoveryReasonLine("ru", { reason: "owner_not_in_general" })).not.toContain("от имени того")
  // Without a cause the line is the general one it always was.
  expect(moveRefusalLine("en", "recovery_route", v)).toContain("no General chat that is shown to be usable and independent")
})

/** A registry the real loader read: two doors, and two people whose allowed senders are as given (the second is always allowed on door-a as 500). */
function registry(allowed: Record<string, string[]>): Registry {
  const dir = mkdtempSync(join(tmpdir(), "move-owner-lines-"))
  try {
    const presets = { daily: { adapter: "synthetic", model: "m", provider: "p", effort: "medium", paid: "plan" } }
    const file = writeRegistry(dir, {
      hub: { state_dir: dir },
      people: [{ id: "p1", allowed_senders: allowed }, { id: "p2", allowed_senders: { "door-a": ["500"] } }],
      presets,
      agents: [
        { id: "p1-a", person: "p1", preset: "daily", chat: "1", door: "door-a", runner: "runner-x" },
        { id: "p1-b", person: "p1", preset: "daily", chat: "2", door: "door-b", runner: "runner-x" },
      ],
    })
    return loadRegistry(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test("General's door is where General's senders are compared: the exact sender on the same door, the person's configured route from another, and nobody else", () => {
  const both = registry({ "door-a": ["111"], "door-b": ["222"] })
  // Same door: exactly that door's list. A stranger is not let in, and the other door's id is not read as this door's.
  expect(senderReachesGeneral(both, "p1", { door: "door-a", sender: "111" }, "door-a")).toBe(true)
  expect(senderReachesGeneral(both, "p1", { door: "door-a", sender: "777" }, "door-a")).toBe(false)
  expect(senderReachesGeneral(both, "p1", { door: "door-a", sender: "222" }, "door-a")).toBe(false)
  // Another door: the ids of the two doors are never compared, and the person's own configured route into General's door is what counts.
  expect(senderReachesGeneral(both, "p1", { door: "door-a", sender: "111" }, "door-b")).toBe(true)
  expect(senderReachesGeneral(both, "p1", { door: "door-a", sender: "999" }, "door-b")).toBe(true)
  // A person with no senders on General's door has no route there, and another person's list on it grants nothing.
  expect(senderReachesGeneral(registry({ "door-a": ["111"] }), "p1", { door: "door-a", sender: "111" }, "door-b")).toBe(false)
  expect(senderReachesGeneral(registry({ "door-a": ["111"], "door-b": [] }), "p1", { door: "door-a", sender: "111" }, "door-b")).toBe(false)
  expect(senderReachesGeneral(registry({ "door-b": ["222"] }), "p1", { door: "door-b", sender: "500" }, "door-a")).toBe(false)
})
