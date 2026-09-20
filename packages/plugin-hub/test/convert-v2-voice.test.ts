// A voice line carried over from the old system and one this hub writes are ONE
// shape in the tail.
//
// The old system wrote a voice note as `(voice) <the words>`, one line. This one
// writes the kind marker on its own line and the words under it, which is the
// record every other kind already uses. Two shapes in one log is one agent
// reading two formats, so the conversion normalises the marker's line break and
// touches nothing else: the words come over byte for byte.
//
// SCOPED TO WHAT A PERSON SAID. An out line is the agent speaking, and an agent
// that writes `(voice)` inside its own answer is quoting rather than sending a
// note, so the rule applies to inbound lines alone.
//
// Pure over planted source files, plus one spawned session for the last case.
// No door and no runner take part in the conversion itself.
import { expect, test } from "bun:test"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { seam, startCluster } from "./helpers/cluster.ts"
import { inventory, jsonlBytes, migrationFixture } from "./helpers/rollout-migration.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { RUNNER, insertInbound, stageHub } from "./helpers/hub-fixture.ts"
import { readTail } from "../src/chatlog.ts"
import { spliceTranscript } from "../src/voice/step.ts"
import { runRunner } from "../src/runner/run.ts"

async function converter() {
  return (await seam("src/migrate/chatlog.ts")).convertV2Chatlog as (manifest: any) => Promise<any>
}

function rows(bytes: Record<string, string>) {
  return Object.values(bytes).join("").trim().split("\n").filter(Boolean).map(s => JSON.parse(s))
}

/** One tab-separated v2 day of p1's own lines, at the day's noon. */
function plantLog(root: string, day: string, texts: string[]): string {
  const file = join(root, `${day}.log`)
  writeFileSync(file, texts.map((text, n) =>
    [`${day}T12:0${n}:00.000Z`, "p1", `telegram:1000000001:${day}-${n}`, JSON.stringify(text)].join("\t"),
  ).join("\n") + "\n")
  return file
}

/** One rendered v2 day of p1's own lines, newlines as the old system wrote them. */
function plantMd(root: string, day: string, texts: string[]): string {
  const file = join(root, `${day}.md`)
  writeFileSync(file, `# Synthetic chat\nDate: ${day}\n\n` + texts.map((text, n) =>
    `12:0${n}:00  p1: ${text.replaceAll("\n", "⏎")}`).join("\n") + "\n")
  return file
}

const SAID = "synthetic dictated codeword and a second clause"

test("ROLL-02 a converted voice line is the marker, a newline and the words, byte for byte", async () => {
  const f = migrationFixture()
  try {
    const convert = await converter()
    const source = `(voice) ${SAID}`
    const file = plantLog(f.roots[0].root, "2026-07-05", [source])
    f.logManifest.inventory = inventory([f.old, f.tab, file])
    await convert(f.logManifest)
    const lines = rows(jsonlBytes(f.stateDir, "p1", "p1-lair")).filter(r => r.direction === "in")
    const converted = lines.find(r => r.text.startsWith("(voice"))!
    // Compared WHOLE. A build that inserted the break anywhere else, or that
    // changed a character of the words, fails here rather than passing a
    // substring test.
    expect(converted.text, "ROLL-02 the marker's line, then the words").toBe(`(voice)\n${SAID}`)
    expect(converted.text.slice("(voice)\n".length), "ROLL-02 the words are untouched").toBe(SAID)
    // The control: the source really was one line, so a build that changed
    // nothing fails rather than passing by accident.
    expect(source).not.toContain("\n")
    expect(converted.text).not.toBe(source)
  } finally { f.stop() }
})

test("ROLL-02 the tail renders a converted line and a new one as one shape", async () => {
  const f = migrationFixture()
  try {
    const convert = await converter()
    const today = new Date().toISOString().slice(0, 10)
    const file = plantLog(f.roots[0].root, today, [`(voice) ${SAID}`])
    f.logManifest.inventory = inventory([f.old, f.tab, file])
    await convert(f.logManifest)

    // The line THIS hub writes, composed by the production splice over the
    // lines the door assembles at accept time.
    const path = "/var/lib/imprnt-hub/p1/inbox/synthetic/0.ogg"
    const fresh = spliceTranscript(
      { lines: [`(voice ${path})`, "synthetic caption"], media: [{ kind: "voice", line: 0 }] },
      0, SAID,
    ) as { text: string }
    appendFileSync(
      join(f.stateDir, "p1", "chatlog", "p1-lair", `${today}.jsonl`),
      JSON.stringify({ id: "synthetic-v3", at: new Date().toISOString(), direction: "in", from: "p1", text: fresh.text }) + "\n",
    )

    const tail = await readTail({ stateDir: f.stateDir, person: "p1", agent: "p1-lair",
      now: new Date(), hours: 24, tokens: 8000 })
    const both = [`(voice)\n${SAID}`, fresh.text]
    for (const text of both) {
      expect(tail, "ROLL-02 both shapes reach the tail").toContain(text)
      const [marker, words] = text.split("\n")
      expect(marker.startsWith("(voice"), "ROLL-02 a kind line of its own").toBe(true)
      expect(words, "ROLL-02 the words on the line under it").toBe(SAID)
    }
    // THE ONLY DIFFERENCE is the saved path the old system never kept.
    expect(both[1]).toContain(path)
    expect(both[0]).not.toContain("/")
  } finally { f.stop() }
})

test("ROLL-02 the conversion of a voice line is idempotent", async () => {
  const f = migrationFixture()
  try {
    const convert = await converter()
    const file = plantLog(f.roots[0].root, "2026-07-05", [`(voice) ${SAID}`, "an ordinary sentence"])
    f.logManifest.inventory = inventory([f.old, f.tab, file])
    const first = await convert(f.logManifest)
    const after = jsonlBytes(f.stateDir, "p1", "p1-lair")
    const second = await convert(f.logManifest)
    expect(second.count, "ROLL-02 the second run appends nothing").toBe(0)
    expect(second.skipped).toBe(first.count)
    expect(jsonlBytes(f.stateDir, "p1", "p1-lair"), "ROLL-02 the same bytes").toEqual(after)
  } finally { f.stop() }
})

test("ROLL-02 only a line that IS a voice note is touched", async () => {
  const f = migrationFixture()
  try {
    const convert = await converter()
    const untouched = [
      "a sentence that merely mentions (voice) in the middle",
      "(photo) synthetic picture caption",
      "(voice)",
      "an ordinary sentence",
    ]
    const file = plantLog(f.roots[0].root, "2026-07-05", untouched)
    f.logManifest.inventory = inventory([f.old, f.tab, file])
    await convert(f.logManifest)
    const texts = rows(jsonlBytes(f.stateDir, "p1", "p1-lair")).map(r => r.text)
    for (const source of untouched) {
      // Byte for byte, and a marker alone stays ONE line because there are no
      // words to put on a second.
      expect(texts, `ROLL-02 ${source} is not a voice note`).toContain(source)
    }
    expect(texts.filter(t => t.includes("\n")).length, "ROLL-02 no break was inserted anywhere").toBe(1)
  } finally { f.stop() }
})

test("ROLL-02 the rule applies to both v2 source formats", async () => {
  const f = migrationFixture()
  try {
    const convert = await converter()
    const tab = plantLog(f.roots[0].root, "2026-07-05", [`(voice) ${SAID}`])
    const rendered = plantMd(f.roots[0].root, "2026-07-06", [`(voice) ${SAID}`])
    f.logManifest.inventory = inventory([f.old, f.tab, tab, rendered])
    await convert(f.logManifest)
    const voices = rows(jsonlBytes(f.stateDir, "p1", "p1-lair"))
      .filter(r => r.direction === "in" && r.text.startsWith("(voice"))
    expect(voices, "ROLL-02 one from each format").toHaveLength(2)
    for (const line of voices) expect(line.text).toBe(`(voice)\n${SAID}`)
  } finally { f.stop() }
})

test("ROLL-02 the words inside a converted voice line reach a spawned session", async () => {
  const f = migrationFixture()
  const cluster = await startCluster()
  let h: Awaited<ReturnType<typeof stageHub>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    const convert = await converter()
    const codeword = `synthetic-dictated-${crypto.randomUUID()}`
    h = await stageHub(cluster)
    const at = new Date(Date.now() - 1000).toISOString()
    const file = join(f.roots[0].root, `${at.slice(0, 10)}.log`)
    writeFileSync(file, `${at}\tp1\ttelegram:1000000001:99\t${JSON.stringify(`(voice) ${codeword}`)}\n`)
    f.logManifest.inventory = inventory([f.old, f.tab, file])
    f.logManifest.state_dir = h.stateDir
    await convert(f.logManifest)
    runner = await runRunner({ runner: RUNNER, registryFile: h.registryFile,
      adapters: { [h.adapterName]: h.scripted.adapter } })
    await insertInbound(cluster, h.db, { id: "new-message", body: "synthetic new work" })
    expect(await observe(async () => (await h!.read.outbox()).some(r => r.inbound_id === "new-message"))).toBe(true)
    const fed = h.scripted.fed()
    expect(fed[0].text, "ROLL-02 the transport carries the dictated words").toContain(codeword)
    expect(fed[0].text, "ROLL-02 and the marker on its own line above them").toContain(`(voice)\n${codeword}`)
  } finally { await runner?.stop(); await h?.stop(); await cluster.stop(); f.stop() }
})

test("ROLL-02 nothing else about the converter moves", async () => {
  const f = migrationFixture()
  try {
    const convert = await converter()
    const file = plantLog(f.roots[0].root, "2026-07-05", [`(voice) ${SAID}`])
    f.logManifest.inventory = inventory([f.old, f.tab, file])
    await convert(f.logManifest)
    // The record of what was carried over, and its bounds.
    const history = JSON.parse(readFileSync(join(f.stateDir, "migration-history.json"), "utf8"))
    expect(Object.keys(history.batches)).toEqual(["synthetic-cutover"])
    expect(history.agents["p1/p1-lair"].from <= history.agents["p1/p1-lair"].until).toBe(true)
    // A source the reviewed inventory never named at all is refused.
    const unnamed = plantLog(f.roots[0].root, "2026-07-08", ["an ordinary sentence"])
    await expect(convert({ ...f.logManifest, batch_id: "second-batch" })).rejects.toThrow(/inventory missing/)
    // Two formats for one day of one chat need a decision, and the decision is
    // honoured when it is made.
    const clash = plantMd(f.roots[0].root, "2026-07-05", ["an ordinary sentence"])
    const manifest = { ...f.logManifest, batch_id: "third-batch",
      inventory: inventory([f.old, f.tab, file, unnamed, clash]) }
    await expect(convert(manifest)).rejects.toThrow(/overlap requires reconciliation/)
    const settled = await convert({ ...manifest, batch_id: "fourth-batch",
      reconciliation: [{ keep: { file, ordinal: 1 }, omit: { file: clash, ordinal: 1 } }] })
    expect(settled.count + settled.skipped).toBeGreaterThan(0)
    // And a source whose bytes changed under a reviewed manifest is refused,
    // which is why this is the last thing the check does to the file.
    appendFileSync(file, "\n")
    await expect(convert(f.logManifest)).rejects.toThrow(/source digest changed/)
  } finally { f.stop() }
})
