// Every sentence a person reads about a voice note, in both languages, and the
// two classes a failure can be.
//
// THE FIVE LINES ARE COMPARED AGAINST THE FUNCTIONS THAT PIN THEM, never against
// a literal retyped here, so the pinning lives in one place and what this check
// asserts is that the door POSTS what was pinned.
//
// WHICH CLOCK IS ARMED WHILE A NOTE HAS NO WORDS. Only the new one. "The loop has
// not accepted this message" is a false sentence about a message that has no text
// yet, so the acked line is asserted ABSENT in the same run the transcribing line
// is asserted present.
//
// The thresholds are seconds here, read from the registry as each person's own,
// which is what makes a one-second threshold a legal file rather than a fixture
// trick.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { chatLogLines } from "./helpers/hub-fixture.ts"
import { fakeRecognizer } from "./helpers/fake-recognizer.ts"
import { WAV_RATE, plantSamples, writeWav } from "./helpers/wav.ts"
import {
  clockLine, gapMarker, transcriberBack, transcriberDown, voiceGaveUp, voiceUnreadable,
} from "../src/door/lines.ts"
import { splitPoints } from "../src/voice/pcm.ts"
import { chunkFilePath, writeChunkFile } from "../src/voice/transcript.ts"
import { clockDeadlines } from "../src/door/clock.ts"
import { runDoor } from "../src/door/run.ts"
import { runRunner } from "../src/runner/run.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const FFMPEG = Bun.which("ffmpeg")
const NEEDS_FFMPEG = FFMPEG ? "" : " [skipped: ffmpeg is not on PATH]"

/** A decodable clip, as the bytes a platform would hand over. */
function clip(seconds = 1): Uint8Array {
  const path = `${process.env.TMPDIR ?? "/tmp"}/outage-${crypto.randomUUID()}.wav`
  try {
    writeWav(path, plantSamples({ seconds, rate: WAV_RATE, quietAt: [] }), WAV_RATE)
    return new Uint8Array(readFileSync(path))
  } finally { Bun.spawnSync(["rm", "-f", path]) }
}

const AUDIO = clip()

/** One voice note in a named chat, from the person that chat belongs to. */
function note(id: string, who: { chat: string; person: string }, bytes = AUDIO) {
  return {
    platform_message_id: id, chat: who.chat, sender_id: who.person, from: who.person,
    text: "", at: new Date().toISOString(),
    media: [{ kind: "voice" as const, remote_id: "voice", name: "note.wav",
      mime: "audio/wav", bytes: bytes.length, caption: null }],
  }
}

const P1 = { chat: "1000000001", person: "p1" }
const P2 = { chat: "0000000000", person: "p2" }

/** A port nothing listens on, so the recognizer is unreachable by construction. */
async function deadPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") })
  const port = Number(server.port)
  await server.stop(true)
  return port
}

function savedPath(body: string): string {
  return body.match(/\(voice ([^)]+)\)/)![1]
}

/** The one row, once the door has written it down. */
async function firstRow(it: { read: { inbound(): Promise<any[]> } }) {
  expect(await observe(async () => (await it.read.inbound()).length === 1, 20_000),
    "the note was written down").toBe(true)
  return (await it.read.inbound())[0]
}

test("RUN-13 a note that takes long yields the transcribing line and never the acked line, in each person's own language", async () => {
  const port = await deadPort()
  const it = await rolloutStage(cluster, "telegram", {
    // Both clocks are ONE second, so a build that armed the acked clock on a
    // note with no words would post its line inside this check's window.
    people: [
      { id: "p1", language: "en", transcribed_seconds: 1, acked_seconds: 1 },
      { id: "p2", language: "ru", transcribed_seconds: 1, acked_seconds: 1 },
    ],
    voice: { port, retry_seconds: 600 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  /** Whether the line was on disk INSIDE the attempt that posted it. */
  const onDiskWhenPosted = new Map<string, boolean>()
  try {
    it.edge.file("voice", AUDIO)
    const platform = {
      ...it.edge.platform,
      async post(where: { chat: string; text: string }) {
        const person = where.chat === P1.chat ? "p1" : "p2"
        const agent = where.chat === P1.chat ? "p1-lair" : "p2-lair"
        onDiskWhenPosted.set(where.text, chatLogLines(it.stateDir, person, agent)
          .some(line => line.direction === "out" && line.text === where.text))
        return it.edge.platform.post(where)
      },
    }
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform })
    it.edge.batch([note("1", P1), note("2", P2)], "2")

    const TRANSCRIBING = /^\[(door|дверь)\] (still transcribing|всё ещё расшифров)/
    for (const who of [P1, P2]) {
      expect(await observe(() => it.edge.posts().some(p => p.chat === who.chat && TRANSCRIBING.test(p.text)), 20_000),
        "RUN-13 the transcribing line, in that person's own words").toBe(true)
    }
    const posts = it.edge.posts()
    for (const [who, language, other] of [[P1, "en", "ru"], [P2, "ru", "en"]] as const) {
      const mine = posts.filter(p => p.chat === who.chat)
      const transcribing = mine.filter(p => TRANSCRIBING.test(p.text))
      expect(transcribing, `RUN-13 exactly one ${language} transcribing line`).toHaveLength(1)
      // Compared WHOLE against the pinned function, with the elapsed seconds
      // the only free number.
      const seconds = Number(/(\d+)/.exec(transcribing[0].text)![1])
      expect(transcribing[0].text).toBe(clockLine(language, "transcribed", seconds))
      // THE ABSENCE IS THE ASSERTION.
      expect(mine.filter(p => p.text === clockLine(language, "acked", seconds)),
        "RUN-13 the loop cannot have failed to accept a message that has no text").toHaveLength(0)
      expect(mine.some(p => /still waiting|всё ещё жду/.test(p.text)),
        "RUN-13 no waiting line of any kind while the words do not exist").toBe(false)
      // Neither person reads the other's marker.
      expect(transcribing[0].text).not.toContain(other === "ru" ? "[дверь]" : "[door]")
      // The chat log carried it before the platform was asked.
      expect(onDiskWhenPosted.get(transcribing[0].text),
        "RUN-13 the line is written down before it is sent").toBe(true)
    }
    // The ledger's own key is ASCII for both, so a household groups its waits by
    // stamp rather than by a translated sentence.
    const expired = (await it.read.ledger({ stream: "clock" })).filter(e => e.kind === "expired")
    expect(expired, "RUN-13 one expiry each").toHaveLength(2)
    expect(expired.map(e => e.detail.stamp)).toEqual(["transcribed", "transcribed"])
  } finally { await door?.stop(); await it.stop() }
}, 120_000)

test(`RUN-13 once the words land, a shipped clock is measured from the moment they landed${NEEDS_FFMPEG}`, async () => {
  if (!FFMPEG) return
  const recognizer = await fakeRecognizer()
  recognizer.setAnswer({ text: "synthetic spoken codeword", audio_s: 1, decode_ms: 1 })
  // Held for four seconds, so a build measuring from `received_at` reports
  // seconds that include the whole wait for the words.
  recognizer.setDelayMs(4000)
  const it = await rolloutStage(cluster, "telegram", {
    people: [
      { id: "p1", language: "en", transcribed_seconds: 600, acked_seconds: 1 },
      { id: "p2", language: "ru" },
    ],
    voice: { port: recognizer.port, chunk_seconds: 0 },
  })
  // NO RUNNER, so nothing accepts the message and the acked clock is the one
  // that runs out. That is the clock whose base the words move.
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    it.edge.file("voice", AUDIO)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([note("1", P1)], "2")
    expect(await observe(async () =>
      (await it.read.ledger({ stream: "clock" })).some(e => e.detail.stamp === "acked"), 30_000),
      "RUN-13 the acked clock runs once the words exist").toBe(true)
    const row = (await it.read.inbound())[0]
    const line = (await it.read.ledger({ stream: "clock" })).find(e => e.detail.stamp === "acked")!
    const fromReceived = (new Date(line.at).getTime() - new Date(row.received_at).getTime()) / 1000
    const fromWords = (new Date(line.at).getTime() - new Date(row.media_done_at!).getTime()) / 1000
    // The arithmetic, against the two timestamps the check read off the row.
    expect(fromReceived - fromWords, "RUN-13 the wait for the words really was long")
      .toBeGreaterThan(3)
    expect(Number(line.detail.seconds), "RUN-13 measured from the moment the words existed")
      .toBeLessThanOrEqual(Math.ceil(fromWords) + 1)
    expect(Number(line.detail.seconds), "RUN-13 and not from when the note arrived")
      .toBeLessThan(Math.round(fromReceived))
  } finally { await door?.stop(); await recognizer.stop(); await it.stop() }
}, 120_000)

test(`RUN-13 an unreachable recognizer yields one line per episode across forty tries, and one when it works again${NEEDS_FFMPEG ? " [the works-again half is skipped: ffmpeg is not on PATH]" : ""}`, async () => {
  const recognizer = await fakeRecognizer()
  recognizer.setAnswer({ text: "synthetic spoken codeword", audio_s: 1, decode_ms: 1 })
  recognizer.setStatus(503)
  const it = await rolloutStage(cluster, "telegram", {
    people: [{ id: "p1", language: "en", transcribed_seconds: 600 }, { id: "p2", language: "ru" }],
    voice: { port: recognizer.port, chunk_seconds: 0, retry_seconds: 1 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    it.edge.file("voice", AUDIO)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([note("1", P1)], "2")
    // FORTY is the point: one notice per episode, never one per try.
    await firstRow(it)
    expect(await observe(async () => (await it.read.inbound())[0].media_attempts >= 40, 90_000),
      "RUN-13 forty tries").toBe(true)
    const row = (await it.read.inbound())[0]
    expect(row.media_state, "RUN-13 the note is still waiting and nothing is lost").toBe("pending")
    const down = (await it.read.noticeRows()).filter(n => n.body === transcriberDown("en", 1))
    expect(down, "RUN-13 one line for the whole episode").toHaveLength(1)
    expect(String(down[0].notice_key), "RUN-13 keyed on the recognizer and the episode")
      .toMatch(/^voice:down:local:/)
    const health = (await it.read.sheet("voice_health")).find(r => r.id === "local")!
    expect(health.data.since, "RUN-13 when the episode began").not.toBeNull()
    expect(Number(health.data.attempts), "RUN-13 and how many tries it has cost")
      .toBeGreaterThanOrEqual(40)
    expect(health.data.class).toBe("infra")

    // And one line when it works again, with the queue behind it named. That
    // half needs a real conversion, so where the converter is absent the
    // episode above is the whole of what this case can say.
    if (!FFMPEG) return
    recognizer.setStatus(200)
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
    expect(await observe(async () => (await it.read.inbound())[0].media_state === "done", 30_000)).toBe(true)
    // THE ROW'S OWN STATE IS NOT EVIDENCE THAT THE LINE EXISTS. The words are
    // written by the statement that ends the step, and the sentence is a later
    // row in a transaction of its own, behind the diary line, the health sheet,
    // the projection's file write and the count of what is still queued. So
    // `done` is readable for a few milliseconds before the line is, and a read
    // taken the instant `done` appears can land inside that. This waits for the
    // line to have been posted at all, keyed, and the assertions below are still
    // the whole of what judges it: that it says exactly this, once.
    await observe(async () => (await it.read.noticeRows())
      .some(n => String(n.notice_key).startsWith("voice:back:")), 20_000)
    const back = (await it.read.noticeRows()).filter(n => n.body === transcriberBack("en", 0))
    expect(back, "RUN-13 one line when it works again").toHaveLength(1)
    expect(String(back[0].notice_key)).toMatch(/^voice:back:local:/)
    expect((await it.read.sheet("voice_health")).find(r => r.id === "local")!.data.since,
      "RUN-13 the episode is over").toBeNull()
    expect(await observe(async () =>
      (await it.read.ledger({ subject: row.id })).some(e => e.kind === "delivered"), 20_000)).toBe(true)
    expect((await it.read.ledger({ subject: row.id })).filter(e =>
      ["received", "acked", "started", "answered", "delivered"].includes(e.kind)).map(e => e.kind))
      .toEqual(["received", "acked", "started", "answered", "delivered"])
    // The notice went to this person's own chat, and was delivered there.
    expect(it.edge.posts().filter(p => p.text === transcriberDown("en", 1)).map(p => p.chat))
      .toEqual([P1.chat])
  } finally { await runner?.stop(); await door?.stop(); await recognizer.stop(); await it.stop() }
}, 180_000)

test(`RUN-13 with two people on one recognizer, a person told "not answering" is not told it again until they read "works again", across the other person's success and a door restart${NEEDS_FFMPEG}`, async () => {
  if (!FFMPEG) return
  const recognizer = await fakeRecognizer()
  recognizer.setAnswer({ text: "synthetic spoken codeword", audio_s: 1, decode_ms: 1 })
  recognizer.setStatus(503)
  const it = await rolloutStage(cluster, "telegram", {
    people: [{ id: "p1", language: "en", transcribed_seconds: 600 }, { id: "p2", language: "ru", transcribed_seconds: 600 }],
    voice: { port: recognizer.port, chunk_seconds: 0, retry_seconds: 1 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  const downLines = (chat: string) => it.edge.posts().filter(p => p.chat === chat && /not answering|не отвечает/.test(p.text))
  try {
    it.edge.file("voice", AUDIO)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    // The first person's note fails: one line to them, and the episode opens.
    it.edge.batch([note("1", P1)], "2")
    await firstRow(it)
    expect(await observe(() => downLines(P1.chat).length === 1, 30_000), "RUN-13 the first person is told once").toBe(true)
    const attemptsBefore = async () => Number((await it.read.inbound()).find(r => r.person === "p1")!.media_attempts)
    // The second person's note works: their success clears the recognizer's
    // sheet while the first person's note is still failing on every retry.
    recognizer.setStatus(200)
    it.edge.batch([note("2", P2)], "3")
    expect(await observe(async () => (await it.read.inbound()).some(r => r.person === "p2" && r.media_state === "done"), 30_000)).toBe(true)
    expect(await observe(async () => (await it.read.sheet("voice_health")).find(r => r.id === "local")?.data.since === null, 20_000),
      "RUN-13 the sheet's episode is cleared by the other person's success").toBe(true)
    recognizer.setStatus(503)
    const seen = await attemptsBefore()
    expect(await observe(async () => await attemptsBefore() >= seen + 3, 30_000), "RUN-13 the first person's note keeps failing").toBe(true)
    expect(downLines(P1.chat), "RUN-13 no second line while the first stands").toHaveLength(1)
    // A door started again reads back what this person was last told, so it
    // does not open a second episode for them either.
    await door.stop()
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    const again = await attemptsBefore()
    expect(await observe(async () => await attemptsBefore() >= again + 3, 30_000)).toBe(true)
    expect(downLines(P1.chat), "RUN-13 one line across the restart too").toHaveLength(1)
    expect(downLines(P2.chat), "RUN-13 the second person was never failed and hears nothing").toHaveLength(0)
    // And when it works again for them, they read it once, which ends their episode.
    recognizer.setStatus(200)
    await observe(async () => (await it.read.noticeRows()).some(n => String(n.notice_key).startsWith("voice:back:") && n.person === "p1"), 30_000)
    expect((await it.read.noticeRows()).filter(n => String(n.notice_key).startsWith("voice:back:") && n.person === "p1")).toHaveLength(1)
  } finally { await door?.stop(); await recognizer.stop(); await it.stop() }
}, 180_000)

test(`RUN-13 a dialled recognizer whose key file is blank is the same episode${NEEDS_FFMPEG}`, async () => {
  // The converter runs BEFORE the key is read, so a box without one never
  // reaches the key at all and this is about the key.
  if (!FFMPEG) return
  const keyFile = join(await Bun.file("/dev/null").exists() ? "/tmp" : "/tmp", `voice-key-${crypto.randomUUID()}`)
  writeFileSync(keyFile, "", { mode: 0o600 })
  const it = await rolloutStage(cluster, "telegram", {
    people: [{ id: "p1", language: "en", transcribed_seconds: 600 }, { id: "p2", language: "ru" }],
    credentials: [{ id: "recognizer-key", kind: "api-key", file: keyFile, owner: "p1" }],
    voice: { provider: "deepgram", credential: "recognizer-key", chunk_seconds: 0, retry_seconds: 600 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    it.edge.file("voice", AUDIO)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([note("1", P1)], "2")
    await firstRow(it)
    expect(await observe(async () => (await it.read.inbound())[0].media_failure !== null, 30_000)).toBe(true)
    const row = (await it.read.inbound())[0]
    // A key that is not there is the box having a bad day, never the note's
    // fault, so the note waits and the person is told once.
    expect(row.media_failure).toMatchObject({ class: "infra", cause: "credential-blank" })
    expect(row.media_state, "RUN-13 the note waits").toBe("pending")
    expect(await observe(async () =>
      (await it.read.noticeRows()).some(n => n.body === transcriberDown("en", 600)), 20_000)).toBe(true)
    const down = (await it.read.noticeRows()).filter(n => n.body === transcriberDown("en", 600))
    expect(down, "RUN-13 one line, the same sentence the local recognizer's outage gets").toHaveLength(1)
    const health = (await it.read.sheet("voice_health")).find(r => r.id === "local")!
    expect(health.data).toMatchObject({ class: "infra", cause: "credential-blank" })
  } finally { await door?.stop(); await it.stop(); Bun.spawnSync(["rm", "-f", keyFile]) }
}, 90_000)

test(`RUN-13 a note the recognizer heard no words in is answered at once, with no retry armed${NEEDS_FFMPEG}`, async () => {
  if (!FFMPEG) return
  const recognizer = await fakeRecognizer()
  recognizer.setAnswer({ text: "", audio_s: 1, decode_ms: 1 })
  const it = await rolloutStage(cluster, "telegram", {
    people: [{ id: "p1", language: "en" }, { id: "p2", language: "ru" }],
    voice: { port: recognizer.port, chunk_seconds: 0, retry_seconds: 1 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    it.edge.file("voice", AUDIO)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
    it.edge.batch([note("1", P1)], "2")
    await firstRow(it)
    expect(await observe(async () => (await it.read.inbound())[0].media_state === "failed", 20_000)).toBe(true)
    const row = (await it.read.inbound())[0]
    // NO RETRY AT ALL: waiting will not put words into silence.
    expect(row.media_retry_at, "RUN-13 nothing is armed").toBeNull()
    expect(row.media_failure).toMatchObject({ class: "content", cause: "audio-empty" })
    expect(row.body, "RUN-13 the media line and the pinned sentence")
      .toBe(`(voice ${savedPath(row.body)})\n${voiceUnreadable("en")}`)
    expect(await observe(async () =>
      (await it.read.ledger({ subject: row.id })).some(e => e.kind === "delivered"), 20_000)).toBe(true)
    expect((await it.read.ledger({ subject: row.id })).filter(e =>
      ["received", "acked", "started", "answered", "delivered"].includes(e.kind)).map(e => e.kind))
      .toEqual(["received", "acked", "started", "answered", "delivered"])
    expect(it.scripted.fed().some(f => f.text.includes(voiceUnreadable("en"))),
      "RUN-13 and the agent answers it").toBe(true)
    expect(recognizer.requests.filter(r => r.method === "POST"),
      "RUN-13 asked once and never again").toHaveLength(1)
  } finally { await runner?.stop(); await door?.stop(); await recognizer.stop(); await it.stop() }
}, 90_000)

test("RUN-13 a note that gives up keeps what it has, in order, with a marker where the rest was", async () => {
  const long = clip(150)
  const recognizer = await fakeRecognizer()
  recognizer.setStatus(503)
  const it = await rolloutStage(cluster, "telegram", {
    people: [{ id: "p1", language: "en", transcribed_seconds: 600 }, { id: "p2", language: "ru" }],
    voice: { port: recognizer.port, chunk_seconds: 60, retry_seconds: 2, give_up_hours: 24 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    it.edge.file("voice", long)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
    it.edge.batch([note("1", P1, long)], "2")
    await firstRow(it)
    expect(await observe(async () => (await it.read.inbound())[0].media_state === "pending", 20_000)).toBe(true)
    const path = savedPath((await it.read.inbound())[0].body)

    // The pieces this note already has, planted through the production writer at
    // the boundaries the production cut puts them. Two came back and the third
    // did not, which is the state a note is in when its window runs out, and the
    // only state that can carry a gap marker at all: a stretch with no entry on
    // file says nothing about how long it was.
    const points = splitPoints(plantSamples({ seconds: 150, rate: WAV_RATE, quietAt: [] }), WAV_RATE, 60)
    const at = (n: number) => ({ from_s: (n === 1 ? 0 : points[n - 2]) / WAV_RATE, to_s: points[n - 1] / WAV_RATE })
    expect(points, "RUN-13 a 150 s note at a 60 s chunk is three pieces").toHaveLength(3)
    writeChunkFile(chunkFilePath(path, 0), {
      recognizer: "local", chunk_seconds: 60, chunks: [
        { n: 1, ...at(1), text: "synthetic piece one", decode_ms: 1, state: "done" },
        { n: 2, ...at(2), text: "synthetic piece two", decode_ms: 1, state: "done" },
        { n: 3, ...at(3), text: "", decode_ms: 0, state: "failed" },
      ],
    })

    // NOTHING OF IT REACHES THE PERSON WHILE THE RETRIES RUN.
    await Bun.sleep(2500)
    const seenBefore = JSON.stringify(it.edge.posts()) + JSON.stringify(chatLogLines(it.stateDir, "p1", "p1-lair"))
    for (const piece of ["synthetic piece one", "synthetic piece two"]) {
      expect(seenBefore, "RUN-13 a partial transcript is not an answer").not.toContain(piece)
    }

    writeFileSync(it.registryFile,
      readFileSync(it.registryFile, "utf8").replace("give_up_hours = 24", "give_up_hours = 0"))
    expect(await observe(async () => (await it.read.inbound())[0].media_state === "failed", 30_000),
      "RUN-13 the window ran out").toBe(true)
    const row = (await it.read.inbound())[0]
    const missing = Math.round(at(3).to_s - at(3).from_s)
    expect(row.body, "RUN-13 the media line, the pieces in order with the gap where the rest was, then the sentence")
      .toBe([`(voice ${path})`,
        `synthetic piece one synthetic piece two ${gapMarker("en", missing)}`,
        voiceGaveUp("en", 0)].join("\n"))
    expect(await observe(async () =>
      (await it.read.ledger({ subject: row.id })).some(e => e.kind === "delivered"), 20_000)).toBe(true)
    expect((await it.read.ledger({ subject: row.id })).filter(e =>
      ["received", "acked", "started", "answered", "delivered"].includes(e.kind)).map(e => e.kind))
      .toEqual(["received", "acked", "started", "answered", "delivered"])
  } finally { await runner?.stop(); await door?.stop(); await recognizer.stop(); await it.stop() }
}, 120_000)

test(`RUN-13 a recognizer that works says none of the five things${NEEDS_FFMPEG}`, async () => {
  if (!FFMPEG) return
  const recognizer = await fakeRecognizer()
  recognizer.setAnswer({ text: "synthetic spoken codeword", audio_s: 1, decode_ms: 1 })
  const it = await rolloutStage(cluster, "telegram", {
    people: [{ id: "p1", language: "en" }, { id: "p2", language: "ru" }],
    voice: { port: recognizer.port, chunk_seconds: 0 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    it.edge.file("voice", AUDIO)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
    it.edge.batch([note("1", P1)], "2")
    const row = await firstRow(it)
    expect(await observe(async () =>
      (await it.read.ledger({ subject: row.id })).some(e => e.kind === "delivered"), 30_000)).toBe(true)
    const said = it.edge.posts().map(p => p.text)
    for (const line of [clockLine("en", "transcribed", 1), transcriberDown("en", 300),
      transcriberBack("en", 0), voiceUnreadable("en"), voiceGaveUp("en", 24)]) {
      expect(said, "RUN-13 a build that said one of these on every note fails here").not.toContain(line)
    }
    const health = await it.read.sheet("voice_health")
    expect(health.filter(r => r.data.since !== null), "RUN-13 and nothing was ever unwell").toEqual([])
    expect(health[0]?.data.last_ok_at, "RUN-13 success is known from a real note").toBeTruthy()
  } finally { await runner?.stop(); await door?.stop(); await recognizer.stop(); await it.stop() }
}, 90_000)

test(`RUN-13 a note that gives up after a MIDDLE chunk failed marks every stretch it never heard${NEEDS_FFMPEG}`, async () => {
  // The case above plants the LAST chunk as the one that failed, which is the
  // one shape where the stretch that is missing is already described on file.
  // This one stops the note in the middle, end to end through the door, so the
  // piece after the failure is a stretch the person would otherwise never be
  // told about.
  if (!FFMPEG) return
  const long = clip(150)
  const recognizer = await fakeRecognizer()
  recognizer.setAnswer({ text: "synthetic piece one", audio_s: 59, decode_ms: 1 })
  // The first chunk lands, the second and everything after it does not.
  recognizer.setRefuseFrom(2)
  const it = await rolloutStage(cluster, "telegram", {
    people: [{ id: "p1", language: "en", transcribed_seconds: 600 }, { id: "p2", language: "ru" }],
    voice: { port: recognizer.port, chunk_seconds: 60, retry_seconds: 2, give_up_hours: 24 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  let runner: Awaited<ReturnType<typeof runRunner>> | undefined
  try {
    it.edge.file("voice", long)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    runner = await runRunner({ runner: "runner-pi", registryFile: it.registryFile, adapters: { [it.adapterName]: it.scripted.adapter } })
    it.edge.batch([note("1", P1, long)], "2")
    const first = await firstRow(it)
    expect(await observe(() =>
      recognizer.requests.filter(r => r.method === "POST").length >= 2, 60_000),
      "RUN-13 the first chunk was answered and the second was asked for").toBe(true)
    expect(await observe(async () => (await it.read.inbound())[0].media_attempts >= 1, 30_000),
      "RUN-13 and the note is waiting on the chunk that failed").toBe(true)
    expect((await it.read.inbound())[0].media_state).toBe("pending")

    writeFileSync(it.registryFile,
      readFileSync(it.registryFile, "utf8").replace("give_up_hours = 24", "give_up_hours = 0"))
    expect(await observe(async () => (await it.read.inbound())[0].media_state === "failed", 40_000),
      "RUN-13 the window ran out").toBe(true)
    const row = (await it.read.inbound())[0]
    expect(row.id).toBe(first.id)
    const path = savedPath(row.body)
    // The boundaries the production cut puts them at, derived here from the
    // same planted samples the door saved.
    const points = splitPoints(plantSamples({ seconds: 150, rate: WAV_RATE, quietAt: [] }), WAV_RATE, 60)
    expect(points, "RUN-13 a 150 s note at a 60 s chunk is three pieces").toHaveLength(3)
    const span = (n: number) => Math.round((points[n - 1] - (n === 1 ? 0 : points[n - 2])) / WAV_RATE)
    expect(row.body, "RUN-13 the piece that came back, then a marker for each stretch that did not")
      .toBe([`(voice ${path})`,
        `synthetic piece one ${gapMarker("en", span(2))} ${gapMarker("en", span(3))}`,
        voiceGaveUp("en", 0)].join("\n"))
    expect(await observe(async () =>
      (await it.read.ledger({ subject: row.id })).some(e => e.kind === "delivered"), 30_000)).toBe(true)
  } finally { await runner?.stop(); await door?.stop(); await recognizer.stop(); await it.stop() }
}, 180_000)

test("RUN-13 a note that gave up counts the shipped clocks from the moment its text existed, not from when it arrived", async () => {
  // THE WINDOW IS REAL HERE, which is what the case above cannot say: it sets
  // the give-up window to zero, so its row arrives and gives up in the same
  // second and every base reads the same. This one plants the arrival a day
  // back, which is the shape a household really meets, and a base of
  // `received_at` then tells the person the agent has been silent for a day
  // directly under the sentence saying their note was only just answered.
  const port = await deadPort()
  const it = await rolloutStage(cluster, "telegram", {
    people: [
      { id: "p1", language: "en", transcribed_seconds: 600, acked_seconds: 600, started_seconds: 600 },
      { id: "p2", language: "ru" },
    ],
    voice: { port, retry_seconds: 1, give_up_hours: 24 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    it.edge.file("voice", AUDIO)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([note("1", P1)], "2")
    const first = await firstRow(it)
    expect(await observe(async () => (await it.read.inbound())[0].media_attempts >= 1, 30_000),
      "RUN-13 the note is waiting on a recognizer that is not there").toBe(true)
    await door.stop()
    door = undefined

    // A day and an hour ago, which is past the window this household allows.
    await it.read.sql("update inbound set received_at = now() - interval '25 hours' where id = $1",
      [first.id])

    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    expect(await observe(async () => (await it.read.inbound())[0].media_state === "failed", 40_000),
      "RUN-13 the window ran out").toBe(true)
    const row = (await it.read.inbound())[0]
    expect(row.body, "RUN-13 and the person was told").toContain(voiceGaveUp("en", 24))

    // THE MOMENT THE TEXT EXISTED. A give-up writes the sentence the person
    // reads, so that is when this row's text came into being, and the three
    // shipped clocks are measured from it.
    expect(row.media_done_at, "RUN-13 the give-up stamped when the text existed").not.toBeNull()
    expect(Math.abs(Date.now() - new Date(row.media_done_at!).getTime()),
      "RUN-13 and that moment is now, not a day ago").toBeLessThan(60_000)
    const [due] = clockDeadlines(
      { state: "received", received_at: row.received_at, media_state: row.media_state,
        media_done_at: row.media_done_at },
      { acked_seconds: 600, started_seconds: 600, answered_seconds: 900, delivered_seconds: 60 },
    )
    expect(due.stamp).toBe("acked")
    expect(due.at, "RUN-13 the clock runs from here, rather than having run out yesterday")
      .toBeGreaterThan(Date.now())

    // And a door coming back to this row reads the same thing, which is where
    // the person would otherwise be told the loop had ignored them for a day,
    // directly under the sentence saying the note was only just finished.
    await door.stop()
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    await Bun.sleep(3000)
    // The control: this door does write into this person's chat, and did. The
    // line is waited for by its own text, because under load it lands after
    // the three seconds kept above as the window for the line below.
    expect(await observe(async () =>
      it.edge.posts().some(p => p.chat === P1.chat && p.text === transcriberDown("en", 1)), 30_000),
      "RUN-13 the person was told the recognizer was not answering").toBe(true)
    expect(it.edge.posts().filter(p => p.chat === P1.chat && p.text === transcriberDown("en", 1)),
      "RUN-13 the person was told the recognizer was not answering").toHaveLength(1)
    expect(it.edge.posts().filter(p => p.chat === P1.chat && /still waiting/.test(p.text)).map(p => p.text),
      "RUN-13 no wait line at all, and never one counting from a day ago").toEqual([])
  } finally { await door?.stop(); await it.stop() }
}, 180_000)
