// One typed line starts several agents on one question, and the chat gets ONE
// merged answer. This file is the door's half: the command is parsed from a
// fetched platform message by an allowed sender, one job row per seat lands
// with the whole envelope, one sheet row holds the council, and the chat is
// told once. The seats' answers never reach the chat, which is the settle's
// half in test/council-merge.test.ts and test/council-tail.test.ts.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage, COUNCIL_SEATS, COUNCIL_SEATS_RU } from "./helpers/rollout-stage.ts"
import { chatLogLines, superStore } from "./helpers/hub-fixture.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { readSlice } from "../src/harvest/slice.ts"
import { councilRefused, councilRequested, councilUsage, COUNCIL_PHRASES, COUNCIL_QUESTION_CAP } from "../src/door/lines.ts"
import { parseCouncil, taskDigest } from "../src/door/dispatch.ts"
import { COUNCIL_SHEET, seatTask, SEAT_INSTRUCTION } from "../src/door/council.ts"
import { admitJob } from "../src/runner/job.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { runDoor } from "../src/door/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const LAIR_CHAT = "1000000001"
const RU_CHAT = "0000000000"
const QUESTION = "should the synthetic ledger be weighed twice"

function typed(id: string, text: string, chat = LAIR_CHAT, sender = "p1") {
  return { ...message(id, text), chat, sender_id: sender, from: sender }
}

test("the command is parsed in both languages, the question is the rest of the message byte for byte, and an empty question is usage", () => {
  expect(parseCouncil(`${COUNCIL_PHRASES.en} ${QUESTION}`)).toEqual({ question: QUESTION })
  expect(parseCouncil(`${COUNCIL_PHRASES.ru} ${QUESTION}`)).toEqual({ question: QUESTION })
  expect(parseCouncil(`${COUNCIL_PHRASES.en.toUpperCase()} ${QUESTION}`)).toEqual({ question: QUESTION })
  // Byte for byte: inner runs of spaces, newlines and the verb inside it all survive.
  for (const question of ["first line\nsecond line", "weigh  the  codeword", `tell me what ${COUNCIL_PHRASES.en} means`, "one"]) {
    expect(parseCouncil(`${COUNCIL_PHRASES.en} ${question}`)).toEqual({ question })
    expect(parseCouncil(`${COUNCIL_PHRASES.en}   ${question}`)).toEqual({ question })
  }
  expect(parseCouncil(COUNCIL_PHRASES.en)).toBe("usage")
  expect(parseCouncil(`${COUNCIL_PHRASES.ru} `)).toBe("usage")
  expect(parseCouncil(`${COUNCIL_PHRASES.en}\n`)).toBe("usage")
  // Not a command: the verb inside a sentence, a prefix of the verb, an empty message.
  expect(parseCouncil(`please ${COUNCIL_PHRASES.en} this`)).toBeNull()
  expect(parseCouncil(`${COUNCIL_PHRASES.en}s are slow`)).toBeNull()
  expect(parseCouncil("")).toBeNull()
  // The seat's task is the fixed instruction, then the question, whole.
  expect(seatTask(QUESTION)).toBe(`${SEAT_INSTRUCTION}\n\n${QUESTION}`)
  expect(SEAT_INSTRUCTION).not.toContain("seat")
  // The acknowledgement caps the question and says how many seats.
  const long = "x".repeat(COUNCIL_QUESTION_CAP + 40)
  expect(councilRequested("en", { count: 3, question: long })).toBe(`[door] council of 3 started on: ${"x".repeat(COUNCIL_QUESTION_CAP)}...`)
  expect(councilRequested("ru", { count: 2, question: QUESTION })).toBe(`[дверь] совет из 2 начат по вопросу: ${QUESTION}`)
})
