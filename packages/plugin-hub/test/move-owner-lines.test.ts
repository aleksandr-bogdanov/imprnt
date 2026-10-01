// What the owner reads where a move is asked from the chat being moved, and what an unresolved attempt is called. Pure: no store, no registry, no
// clock. The command-level checks are in `topic-move-command.test.ts` (the hub tool) and `move-door-command.test.ts` (the door's own commands).

import { expect, test } from "bun:test"
import { moveActions, moveRefusalLine, moveStatusLine, type MoveLineFacts } from "../src/door/move-lines.ts"
import type { Language } from "../src/door/lines.ts"

const LANGUAGES: Language[] = ["en", "ru"]
const facts = (over: Partial<MoveLineFacts> = {}): MoveLineFacts => ({
  move: "mv-7c1e", family: null, stage: "waiting", platform: "discord", name: "coffee", chat: "1000000002", source: "pi", dest: "mac",
  destLive: true, sourceLive: true, finishing: false, withdrawable: true, chatState: "open", ...over,
})
const v = { move: "mv-7c1e", platform: "discord", name: "coffee", chat: "1000000002", source: "pi", dest: "mac" }

test("said in the topic's own chat, a move offers the door's commands and claims no other chat: nothing is conditional on a General that is usable", () => {
  for (const [language, withdraw, only] of [
    ["en", "You can withdraw the move, by sending /move withdraw mv-7c1e here, and <#1000000002> stays on pi.", "The only way forward is to withdraw the move, by sending /move withdraw mv-7c1e here"],
    ["ru", "Перенос можно отозвать, отправив /перенос отозвать mv-7c1e здесь, и <#1000000002> останется на pi.", "Единственный путь — отозвать перенос, отправив /перенос отозвать mv-7c1e здесь"],
  ] as const) {
    const here = facts({ inTopic: true })
    // The same actions as anywhere else: the door answers them in this chat whether or not any agent can run.
    expect(moveActions(here)).toEqual(["withdraw"])
    expect(moveActions(here)).toEqual(moveActions(facts()))
    const text = moveStatusLine(language, here)
    expect(text).toContain(withdraw)
    expect(text).not.toMatch(/General/)
    expect(moveStatusLine(language, facts({ inTopic: true, family: "owner_unknown" }))).toContain(only)
  }
  // A turn that is still being answered: no control is offered in the chat, and the line says the command is sent again afterwards.
  expect(moveActions(facts({ inTopic: true, finishing: true }))).toEqual([])
  // The refusal for a turn still finishing says which command to send again, or asks again plainly where it was not said in that chat.
  expect(moveRefusalLine("en", "turn_finishing", { ...v, inTopic: true })).toContain("send /move withdraw mv-7c1e here again once it has ended")
  expect(moveRefusalLine("ru", "turn_finishing", { ...v, inTopic: true })).toContain("отправьте /перенос отозвать mv-7c1e здесь ещё раз")
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
  // An unresolved attempt in the topic's own chat offers no command there either.
  expect(moveActions(facts({ unresolved: true, inTopic: true }))).toEqual([])
  expect(moveStatusLine("en", facts({ unresolved: true, inTopic: true }))).not.toContain("/move withdraw")
})
