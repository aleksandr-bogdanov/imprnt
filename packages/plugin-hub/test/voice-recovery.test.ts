// A wedged recognizer costs one piece of a note, and the door asks the hub for
// the one restart it is allowed to ask for.
//
// THE DOOR ASKS AND THE HUB ACTS. No door and no agent ever speaks to a service
// manager: the door writes a control row, which is a grant it already holds, and
// the hub is the one process that turns it into a restart. So the request is a
// row somebody can read afterwards rather than a signal nobody can.
//
// WHY THE SECOND REQUEST IS REFUSED BY THE HUB AND NOT BY THE DOOR. The refusal
// is a `refusal` line, and the door holds no insert policy for that stream. A
// door-side refusal would need a fence widened for a diagnostic the hub can
// already write on its apply side, so the limit lives where the line can be
// written.
//
// The door-driven cases need `ffmpeg`, because a deadline can only be reached
// once the audio has become samples. The hub-side cases need nothing and run
// everywhere.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { startCluster, seam, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage } from "./helpers/rollout-stage.ts"
import { serviceOs } from "./helpers/rollout-service.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { observe } from "./helpers/rollout-runner.ts"
import { fakeRecognizer } from "./helpers/fake-recognizer.ts"
import { WAV_RATE, plantSamples, writeWav } from "./helpers/wav.ts"
import { message } from "./helpers/rollout-ingress.ts"
import { runDoor } from "../src/door/run.ts"
import { runHub } from "../src/hub/run.ts"
import { requestRecovery } from "../src/hub/control.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

const FFMPEG = Bun.which("ffmpeg")
const NEEDS_FFMPEG = FFMPEG ? "" : " [skipped: ffmpeg is not on PATH]"

/** A decodable clip of a known length, as the bytes a platform would hand over. */
function clip(seconds: number): Uint8Array {
  const path = `${process.env.TMPDIR ?? "/tmp"}/recovery-${crypto.randomUUID()}.wav`
  try {
    writeWav(path, plantSamples({ seconds, rate: WAV_RATE, quietAt: [] }), WAV_RATE)
    return new Uint8Array(readFileSync(path))
  } finally { Bun.spawnSync(["rm", "-f", path]) }
}

function voiceMessage(id: string, bytes: Uint8Array) {
  return {
    ...message(id, ""),
    media: [{ kind: "voice" as const, remote_id: "voice", name: "note.wav",
      mime: "audio/wav", bytes: bytes.length, caption: null }],
  }
}

test("RUN-13 the recognizer entry is the third recovery target, the door is its only asker, and the shapes around it are refused", async () => {
  const recognizer = await fakeRecognizer()
  const it = await rolloutStage(cluster, "telegram", { voice: { port: recognizer.port },
    hub: { outage_retry_seconds: 600 } })
  const store = await superStore(cluster, it.db)
  // The renderer is inert here. A tick that reaches the recognizer entry throws
  // inside its own pass, because the program that runs one is rendered by a
  // later step, and the control watch this check is about is independent of it.
  const os = serviceOs(it.stateDir, process.platform === "darwin" ? "launchd" : "systemd",
    ["door-fake", "runner-pi", "transcriber"])
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    const ask = (over: Record<string, unknown>) => requestRecovery(store, {
      id: `ask-${crypto.randomUUID()}`, actor: "door", source: "door",
      target_kind: "run", target_id: "transcriber", registryFile: it.registryFile, ...over,
    } as never)

    // 5. The three wrong shapes, each refused by the NAME it throws, so a build
    //    cannot rename its way past this check.
    await expect(ask({ target_kind: "door", target_id: "door-fake" }),
      "RUN-13 a door may not ask for a door back, its own included")
      .rejects.toThrow("recovery-not-authorized")
    await expect(ask({ target_id: "runner-pi" }),
      "RUN-13 a run target is a recognizer entry and nothing else")
      .rejects.toThrow("invalid-recovery-target")
    await expect(ask({ target_kind: "run", target_id: "nothing-declared" }))
      .rejects.toThrow("invalid-recovery-target")

    // 2. Exactly ONE row of the right shape.
    const asked = await ask({})
    expect(asked).toMatchObject({ target_kind: "run", target_id: "transcriber", status: "pending" })
    const rows = await it.read.sheet("control")
    expect(rows, "RUN-13 one control row and no other").toHaveLength(1)
    expect(rows[0].data).toMatchObject({ source: "door", actor: "door",
      target_kind: "run", target_id: "transcriber" })
    const requested = (await it.read.ledger({ stream: "control" })).filter(e => e.kind === "recovery.requested")
    expect(requested, "RUN-13 one line, as the door").toHaveLength(1)
    expect(requested[0].actor).toBe("door")

    // 3. The hub applies it through the OS seam, exactly as it does a door.
    hub = await runHub({ registryFile: it.registryFile, machine: "pi", os: os.os })
    expect(await observe(async () => (await it.read.sheet("control")).some(r => r.data.status === "applied"),
      10_000), "RUN-13 the hub is what restarts it").toBe(true)
    expect(os.calls.filter(c => c.operation === "restart")).toEqual([{ operation: "restart", target: "transcriber" }])
    const applied = (await it.read.ledger({ stream: "control" })).filter(e => e.kind === "recovery.applied")
    expect(applied).toHaveLength(1)
    expect(applied[0].actor).toBe("hub")

    // 4. A second ask inside the interval is refused, with the interval named,
    //    and the seam is not called twice.
    await ask({})
    expect(await observe(async () => (await it.read.sheet("control")).some(r => r.data.status === "refused"),
      10_000), "RUN-13 the hub refuses a restart it has just done").toBe(true)
    const refused = (await it.read.sheet("control")).find(r => r.data.status === "refused")!
    expect(String(refused.data.cause), "RUN-13 the refusal names the interval").toContain("600")
    const refusals = (await it.read.ledger({ stream: "control" })).filter(e => e.kind === "recovery.refused")
    expect(refusals).toHaveLength(1)
    expect(refusals[0].actor).toBe("hub")
    expect(os.calls.filter(c => c.operation === "restart"),
      "RUN-13 one restart in total").toHaveLength(1)

    // 6. And the two shipped targets still work, so a build that replaced the
    //    target check rather than widening it fails here.
    await requestRecovery(store, { id: `door-${crypto.randomUUID()}`, actor: "operator",
      source: "cli", target_kind: "door", target_id: "door-fake", registryFile: it.registryFile })
    expect(await observe(() => os.calls.some(c => c.operation === "restart" && c.target === "door-fake"),
      10_000), "RUN-13 an operator's door recovery is unchanged").toBe(true)
    const chat = await requestRecovery(store, { id: `chat-${crypto.randomUUID()}`, actor: "p1",
      source: "chat", sender_id: "p1", person: "p1", door: "door-fake", chat: "1000000001",
      agent: "p1-lair", target_kind: "agent", target_id: "p1-lair", registryFile: it.registryFile })
    expect(chat, "RUN-13 an agent recovery from a chat is unchanged")
      .toMatchObject({ target_kind: "agent", target_id: "p1-lair", status: "pending" })
  } finally { await hub?.stop(); await store.close(); await recognizer.stop(); await it.stop() }
}, 90_000)

test("RUN-13 a recognizer entry on another machine is not this hub's to restart", async () => {
  const recognizer = await fakeRecognizer()
  // The hub refuses to run for a machine whose declared system is not the one
  // it is on, so the machine it runs for is this one and the recognizer sits on
  // the other.
  const here = process.platform === "darwin" ? "macos" : "linux"
  const it = await rolloutStage(cluster, "telegram", {
    machines: [{ id: "pi", os: here === "macos" ? "linux" : "macos" }, { id: "mac", os: here }],
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1",
        token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always",
        memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
    voice: { port: recognizer.port, machine: "pi" },
  })
  const store = await superStore(cluster, it.db)
  const os = serviceOs(it.stateDir, "launchd", ["transcriber"])
  let hub: Awaited<ReturnType<typeof runHub>> | undefined
  try {
    await requestRecovery(store, { id: `ask-${crypto.randomUUID()}`, actor: "door", source: "door",
      target_kind: "run", target_id: "transcriber", registryFile: it.registryFile })
    hub = await runHub({ registryFile: it.registryFile, machine: "mac", os: os.os })
    await Bun.sleep(1500)
    expect(os.calls.filter(c => c.operation === "restart"),
      "RUN-13 a hub restarts what runs beside it and nothing else").toEqual([])
    expect((await it.read.sheet("control"))[0].data.status,
      "RUN-13 the row waits for the hub it belongs to").toBe("pending")
  } finally { await hub?.stop(); await store.close(); await recognizer.stop(); await it.stop() }
}, 60_000)

test(`RUN-13 a chunk that outran its deadline ends the converter, abandons the request and asks once${NEEDS_FFMPEG}`, async () => {
  if (!FFMPEG) return
  const audio = clip(1)
  const recognizer = await fakeRecognizer()
  // ACCEPTED AND NEVER ANSWERED, which is the shape a wedged single-threaded
  // recognizer has.
  recognizer.setDelayMs(60_000)
  const it = await rolloutStage(cluster, "telegram", {
    voice: { port: recognizer.port, chunk_seconds: 0, chunk_deadline_seconds: 1, retry_seconds: 600 },
    hub: { outage_retry_seconds: 600 },
  })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    it.edge.file("voice", audio)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([voiceMessage("1", audio)], "2")
    expect(await observe(async () => (await it.read.sheet("control")).length === 1, 20_000),
      "RUN-13 one control row, for the entry the door reaches").toBe(true)
    const row = (await it.read.sheet("control"))[0]
    expect(row.data).toMatchObject({ target_kind: "run", target_id: "transcriber", actor: "door" })
    const asked = (await it.read.ledger({ stream: "control" })).filter(e => e.kind === "recovery.requested")
    expect(asked).toHaveLength(1)
    expect(asked[0].actor).toBe("door")

    // The request really arrived and really was never answered, so the wait was
    // abandoned rather than waited out.
    expect(recognizer.requests.filter(r => r.method === "POST").length).toBeGreaterThanOrEqual(1)
    // A HUNG RECOGNIZER NEVER HOLDS A NOTE: the row is still waiting, with a
    // retry of its own, and nothing about it is finished.
    const note = (await it.read.inbound())[0]
    expect(note.media_state, "RUN-13 the note waits").toBe("pending")
    expect(note.media_retry_at).not.toBeNull()
    expect(note.media_failure).toMatchObject({ class: "infra", cause: "chunk-deadline" })
    // No converter of this process survives the deadline.
    const children = Bun.spawnSync(["ps", "-Ao", "ppid=,args="], { stdout: "pipe" })
      .stdout.toString().split("\n").map(l => l.trim())
      .filter(l => Number(l.split(/\s+/)[0]) === process.pid && l.includes("ffmpeg"))
    expect(children, "RUN-13 the converter was ended on the deadline").toEqual([])
  } finally { await door?.stop(); await recognizer.stop(); await it.stop() }
}, 90_000)

test(`RUN-15 a changed chunk length lands on the next note with nothing restarted${NEEDS_FFMPEG}`, async () => {
  if (!FFMPEG) return
  // 150 s at a 60 s chunk is three pieces, and the same note uncut is one.
  const audio = clip(150)
  const recognizer = await fakeRecognizer()
  recognizer.setAnswer({ text: "synthetic spoken codeword", audio_s: 60, decode_ms: 1 })
  const it = await rolloutStage(cluster, "telegram", { voice: { port: recognizer.port, chunk_seconds: 60 } })
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    it.edge.file("voice", audio)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    // The door runs in THIS process, so this pid is the door's own.
    const pid = process.pid
    it.edge.batch([voiceMessage("1", audio)], "2")
    expect(await observe(async () => (await it.read.inbound()).some(r => r.media_state === "done"), 30_000)).toBe(true)
    const cut = recognizer.requests.filter(r => r.method === "POST").length
    expect(cut, "RUN-15 a 150 s note at a 60 s chunk is three requests").toBe(3)

    writeFileSync(it.registryFile,
      readFileSync(it.registryFile, "utf8").replace("chunk_seconds = 60", "chunk_seconds = 0"))
    // A changed knob lands within ONE tick, which is what the door's shared
    // per-tick parse buys: the file is read once a tick for the whole door
    // rather than once per pass per agent.
    await Bun.sleep(Number(1200))
    it.edge.batch([voiceMessage("2", audio)], "3")
    expect(await observe(async () => (await it.read.inbound()).filter(r => r.media_state === "done").length === 2, 30_000)).toBe(true)
    expect(recognizer.requests.filter(r => r.method === "POST").length - cut,
      "RUN-15 the same note uncut is one request").toBe(1)
    expect(process.pid, "RUN-15 nothing was restarted to read the new value").toBe(pid)
    expect(await it.read.sheet("control"), "RUN-15 and nothing was asked of the hub").toEqual([])
  } finally { await door?.stop(); await recognizer.stop(); await it.stop() }
}, 120_000)

test(`RUN-13 a recognizer that answers asks for nothing${NEEDS_FFMPEG}`, async () => {
  if (!FFMPEG) return
  const audio = clip(1)
  const recognizer = await fakeRecognizer()
  recognizer.setAnswer({ text: "synthetic spoken codeword", audio_s: 1, decode_ms: 1 })
  const it = await rolloutStage(cluster, "telegram", { voice: { port: recognizer.port, chunk_seconds: 0 } })
  const os = serviceOs(it.stateDir, "launchd", ["transcriber"])
  let door: Awaited<ReturnType<typeof runDoor>> | undefined
  try {
    it.edge.file("voice", audio)
    door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.edge.platform })
    it.edge.batch([voiceMessage("1", audio)], "2")
    expect(await observe(async () => (await it.read.inbound()).some(r => r.media_state === "done"), 20_000)).toBe(true)
    expect(await it.read.sheet("control"), "RUN-13 a build that asked on every failure fails here").toEqual([])
    expect(os.calls, "RUN-13 the door never speaks to a service manager").toEqual([])
  } finally { await door?.stop(); await recognizer.stop(); await it.stop() }
}, 60_000)
