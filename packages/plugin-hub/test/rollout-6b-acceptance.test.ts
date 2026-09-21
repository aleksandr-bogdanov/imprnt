// The evidence inventory for dispatch, the shared zone, phone provisioning and
// the interim off-box copy, held as DATA, and the assertions that the data is
// honest. (SPEC §6, L4, L13)
//
// WHAT THIS FILE IS. It reads files, calls four pure finding producers, and
// asks this machine which of its gates are open. It starts no cluster and does
// not re-run the checks it names, and it could not: what it refuses is an
// inventory that claims a check nobody wrote, a test a file no longer declares,
// a gate a skip closed, an automated row that quietly gated itself, or an
// owner-only row a script says it satisfied.
//
// A SKIP NEVER CLOSES A GATE. A test behind a gate that is shut on the machine
// running it is printed here as a gate still open, with its reason, and never
// as a pass. The validator below refuses a row whose evidence is a skip, a
// failure or nothing at all, each for its own reason.
//
// THE OWNER-ONLY ROWS CARRY NO EVIDENCE IN THIS REPOSITORY, and never will. A
// real dispatch from a phone, a real note moved and read by the second person,
// a real channel adopted by name and renamed in the app, and the owner's own
// restore of a real copy on a second machine are observations only the owner
// makes, during the cutover, in the steps named beside each. Something run in
// this process against the fake platform, a scratch vault or a disk image is a
// stand-in, and the validator refuses every stand-in by name.
//
// WHAT WAS NOT PROVED, carried here as data rather than left in a summary. The
// rows below close what a check really measured. The list of gaps is what the
// phase could not measure at all, and it is asserted to stay open.
//
// WHICH ASSERTIONS ARE GREEN FROM THE FIRST RUN, said so nobody reads a green
// here as evidence of work: the owner-only refusals and the gaps list are data
// in this file, so they hold the moment it exists. What can be red is every
// assertion that reads another file: a named test that is not there, a gate
// where the row says there is none, and a shipped check edited without a line
// here saying why.
//
// Which of the six protected windows this could reach: none. It reads them
// only through the inventory's own file names.

import { expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { hubPath } from "./helpers/cluster.ts"
import { boxGate } from "./helpers/box-gate.ts"
import { deviceGate, pgDumpGate } from "./helpers/backup-stage.ts"
import { zoneFindings, type ZoneCheckState } from "../src/check/zone.ts"
import { staleDispatchJobs } from "../src/check/jobs.ts"
import { staleJobs } from "../src/check/schedule.ts"
import { backupFindings } from "../src/check/backup.ts"
import type { RunEntry } from "../src/registry/load.ts"

/** How an observation is made. A skip never closes a gate. */
type Seam = "A" | "K" | "C"
/** What one run of one check on one operating system came to. */
type Ran = "ran" | "skipped" | "failed"
/** The gates this phase's checks sit behind, each asked of the machine. */
type Gate = "box" | "device" | "pg_dump"

interface Bound {
  seam: Exclude<Seam, "C">
  file: string
  /**
   * Words from each test's own title, one entry per test the row leans on, so
   * a file that was emptied or a test that was renamed away fails here.
   */
  tests: string[]
  /** The gates a K test sits behind. An A test sits behind none. */
  gates: Gate[]
  /** The two operating systems, as the round that closed the phase ran them. */
  runs: Record<"macos" | "linux", Ran>
}

interface OwnerOnly {
  /** The observation, in words. */
  what: string
  /** The step of the owner's cutover procedure that makes it. */
  step: string
  /** What a script might offer in its place, and what it is not. */
  notSatisfiedBy: string[]
}

interface Row {
  requirement: string
  observation: string
  bound: Bound[]
  owner: OwnerOnly[]
}

const BOTH: Record<"macos" | "linux", Ran> = { macos: "ran", linux: "ran" }

/**
 * The phase's requirement table, one row per requirement and one for the six
 * windows.
 *
 * `runs` is what the round that closed the phase saw: the full suite on macOS
 * and the named files on Linux in the container CI's own image. A K test ran
 * on both because each gate here has an answer on each system (the box is
 * sandbox-exec on one and bwrap on the other, and a second device is a disk
 * image on one and /dev/shm on the other). That round had no real Linux box,
 * and the one test a container cannot pass is recorded as failed.
 */
const INVENTORY: Row[] = [
  {
    requirement: "ROLL-19",
    observation: "a typed command lands one job with its whole envelope, the report returns only on the pinned route with the job's own arrival, the five refusals each with a control, the spoke's wait and reconnect, and an open job past its threshold is a finding",
    bound: [
      { seam: "A", file: "test/dispatch-store.test.ts", gates: [], runs: BOTH, tests: [
        "the report function is owned by the role that writes the table it inserts into",
        "the report is built from the job row and takes the job's own time",
        "an unprojected report or job wakes its door, and nothing else on that channel does",
      ] },
      { seam: "A", file: "test/dispatch-command.test.ts", gates: [], runs: BOTH, tests: [
        "one typed command lands one job row and the whole envelope",
        "an agent's own text creates nothing",
        "there is no dispatch verb on the command line",
      ] },
      { seam: "A", file: "test/dispatch-digest.test.ts", gates: [], runs: BOTH, tests: [
        "a task rewritten before projection is refused by name and never fed",
        "is refused as unapproved",
        "the report rides the settle, no chunk is written, and no clock is armed",
        "a model that names a destination changes nothing about where the report goes",
      ] },
      { seam: "A", file: "test/dispatch-refusals.test.ts", gates: [], runs: BOTH, tests: [
        "a denied sender's dispatch saves nothing at all, and an allowed one lands a job",
        "the four door refusals and the two good dispatches, in one run",
      ] },
      { seam: "A", file: "test/dispatch-report.test.ts", gates: [], runs: BOTH, tests: [
        "a report is fed before the message that arrived while its job ran",
        "a running door projects a report on its own channel",
        "a job is projected by the door that serves its target",
      ] },
      { seam: "A", file: "test/dispatch-clock.test.ts", gates: [], runs: BOTH, tests: [
        "a report's three clocks are measured from the moment it landed",
        "the door says nothing about a report whose job ran for an hour",
      ] },
      { seam: "A", file: "test/dispatch-spoke.test.ts", gates: [], runs: BOTH, tests: [
        "a job for a stopped runner waits unclaimed, is claimed when it starts",
        "a runner whose listening connection is cut from the server's side hears the next job anyway",
        "a spoke killed between the turn's end and the settle, started again, reports exactly once",
      ] },
      { seam: "A", file: "test/dispatch-stale.test.ts", gates: [], runs: BOTH, tests: [
        "an open job past its person's threshold plus the grace is a finding named by its row",
      ] },
    ],
    owner: [{
      what: "one real /dispatch typed from a phone into the owner's lair chat, with the report answered in that same chat",
      step: "16a",
      notSatisfiedBy: ["a /dispatch delivered through the fake platform", "a report settled by the scripted adapter"],
    }],
  },
  {
    requirement: "ROLL-27",
    observation: "the zone table and its marked checkouts, the loader's refusals and the household rule, the install stage, the core's own move inside the box with two syncs against a local remote, the other person's read and the private read denied, and the four findings",
    bound: [
      { seam: "A", file: "test/registry-zone.test.ts", gates: [], runs: BOTH, tests: [
        "a [zone] table with no mount and one with no remote each refuse the file",
        "a marked repository whose remote is not the zone's refuses the file",
        "the whole shape loads and reads back, one zone for the household",
      ] },
      { seam: "A", file: "test/zone-household.test.ts", gates: [], runs: BOTH, tests: [
        "a declared zone and a vault-holding person with no checkout refuses the file at THAT person's own line",
        "a household with no [zone] table has no household rule at all",
      ] },
      { seam: "A", file: "test/zone-install.test.ts", gates: [], runs: BOTH, tests: [
        "install zone clones every declared checkout that is absent, and a second run clones nothing",
        "a checkout that is not the zone's is refused and left exactly as it was",
      ] },
      { seam: "A", file: "test/zone-findings.test.ts", gates: [], runs: BOTH, tests: [
        "a declared checkout that is absent is one finding naming the person",
        "a checkout whose real remote is not the zone's is one finding naming both urls",
        "a vault that does not declare the mount is one finding",
        "a household that declares no zone is told once per machine",
        "check reads files and the registry for the zone, opens no store row and reaches nothing",
      ] },
      { seam: "A", file: "test/zone-move.test.ts", gates: [], runs: BOTH, tests: [
        "the core refuses a note whose source points into private raw/",
        "a harvest is read-only on the person's tree on BOTH flavours",
        "no file under src/ implements a move, a link rewrite or a seam finding",
      ] },
      { seam: "K", file: "test/zone-move.test.ts", gates: ["box"], runs: BOTH, tests: [
        "the owner's agent shares a note with the core's own verb inside its box",
        "the same from the second person's side, on a scene of its own",
        "the harvester's box cannot move a note",
      ] },
      { seam: "A", file: "test/box-zone.test.ts", gates: [], runs: BOTH, tests: [
        "the box carries no zone of its own",
      ] },
    ],
    owner: [{
      what: "the first real note moved by an agent into the mount, committed on both sides, and read by the second person's agent after both syncs",
      step: "16a",
      notSatisfiedBy: ["a move between two scratch vaults on one machine", "two sync entries against a local bare remote"],
    }],
  },
  {
    requirement: "ROLL-28",
    observation: "the resolution seam with its retries and its three refusals, the one guild listing per adopt and never on a tick, the Telegram memo and its one-agent-per-bot refusal, the registry writer's three edits and their diffs, the control lifecycle, and the four things a repair keeps",
    bound: [
      { seam: "A", file: "test/registry-edit.test.ts", gates: [], runs: BOTH, tests: [
        "appendEntry adds one block at the end of the file and changes no other byte",
        "setKey replaces one key's line inside a named entry",
        "removeEntry takes a middle entry's block",
        "a hand edit that lands between the read and the rename is detected and refused",
      ] },
      { seam: "A", file: "test/agent-admin-seam.test.ts", gates: [], runs: BOTH, tests: [
        "the four answers a resolution can give",
        "a Discord name is resolved by ONE guild channel listing",
        "the chat lookup runs once per adopt and never on a tick",
      ] },
      { seam: "A", file: "test/agent-lifecycle.test.ts", gates: [], runs: BOTH, tests: [
        "adopt binds a new agent to a chat the person made",
        "a repair after a deleted channel keeps the id, the history, the watermark and the pending work",
      ] },
      { seam: "A", file: "test/agent-authorization.test.ts", gates: [], runs: BOTH, tests: [
        "a verb against the other person's agent is refused",
        "is refused by the hub with invalid configuration",
        "each verb is recorded as requested then applied",
      ] },
    ],
    owner: [{
      what: "one throwaway Discord channel made in the app, adopted by name from the lair's chat, renamed in the app while the door keeps reading it, then retired, from a phone",
      step: "16a",
      notSatisfiedBy: ["the fake platform's admin member", "a guild listing served in this process"],
    }],
  },
  {
    requirement: "ROLL-32",
    observation: "the backup entry and its three commands, the timer render, the staging set and its five exclusions, the stamp written only on a matching read-back, the same-device refusal, the two failing controls, a later message and note restored from a copy, and the findings",
    bound: [
      { seam: "A", file: "test/backup-registry.test.ts", gates: [], runs: BOTH, tests: [
        "a backup entry with three argvs, a destination, a schedule and a memory limit loads and reads back by value",
        "a read-back that names {staging} refuses",
        "Linux renders a service at the entry's own memory limit",
        "macOS renders a StartInterval at the schedule's seconds",
      ] },
      { seam: "A", file: "test/backup-copy.test.ts", gates: [], runs: BOTH, tests: [
        "DECLARED FAILING CONTROL: an upload of true exits zero",
        "DECLARED FAILING CONTROL: a destination on the staging directory's own device is refused",
        "every argv is run as argv",
        "no provider is named in the copy's source",
      ] },
      { seam: "K", file: "test/backup-copy.test.ts", gates: ["device"], runs: BOTH, tests: [
        "a copy to another device lands",
        "only a read-back that matches writes the stamp",
        "the five exclusions are absent by path and by content",
      ] },
      { seam: "K", file: "test/backup-restore.test.ts", gates: ["device", "pg_dump"], runs: BOTH, tests: [
        "a message, a chat line and a vault note added after a copy are ABSENT from it and PRESENT in the next one",
      ] },
      { seam: "K", file: "test/backup-restore.test.ts", gates: ["device"], runs: BOTH, tests: [
        "backup-failed is read from the copy's last failure",
        "check opens no destination",
      ] },
      { seam: "A", file: "test/backup-box.test.ts", gates: [], runs: BOTH, tests: [
        "every agent's box masks the copy's staging directory, on both flavours",
      ] },
      { seam: "K", file: "test/backup-box.test.ts", gates: ["box"], runs: BOTH, tests: [
        "from inside one person's box the staged copy of the other person's draft",
      ] },
    ],
    owner: [
      {
        what: "the first real copy to the second machine, read back byte-equal and stamped",
        step: "14a",
        notSatisfiedBy: ["a copy to /dev/shm or a disk image", "cp as the upload command"],
      },
      {
        what: "the owner's restore of a real copy on the second machine, holding the phone messages and the moved note and missing from the copy before them",
        step: "19",
        notSatisfiedBy: ["a restore into a throwaway cluster in this process", "chat logs read back from a scratch destination"],
      },
    ],
  },
  {
    requirement: "ROLL-16, kept",
    observation: "the retired household zone setting is inert, the box carries no zone of its own, and each agent reads its own zone checkout and not the other person's",
    bound: [
      { seam: "A", file: "test/box-zone.test.ts", gates: [], runs: BOTH, tests: [
        "a reader that asks for the retired zone setting fails at run time",
        "check sweeps no zone root of its own",
      ] },
      // FAILED ON LINUX IN THIS ROUND, and recorded as failed rather than as a
      // pass. The only Linux this round had is a container, whose whole process
      // table is single digits, and the probe's unboxed control wants more than
      // fifty. The box half of the probe is not what failed, but a run that
      // failed closes nothing, so this row stays open until a real Linux box
      // runs it.
      { seam: "K", file: "test/box-tenancy.test.ts", gates: ["box"], runs: { macos: "ran", linux: "failed" }, tests: [
        "the tenancy probe with its control, per agent",
      ] },
    ],
    owner: [],
  },
  {
    requirement: "the six protected windows",
    observation: "the six shipped windows byte-unchanged and green against registries carrying every new shape, and each re-opened in the state this phase adds to it",
    bound: [
      { seam: "A", file: "test/rollout-6b-windows.test.ts", gates: [], runs: BOTH, tests: [
        "the six protected windows are byte-unchanged",
        "the six protected windows run unchanged and green against registries carrying",
        "a door holding an open job issues nothing across a typing interval",
        "a restarted door projects three hour-old reports before it is ready",
        "check against every new shape at once fires all four new producers",
      ] },
    ],
    owner: [],
  },
]

/**
 * What this phase could not measure, carried as data so the gate cannot read
 * greener than the phase is. Each stays open until something outside this
 * repository closes it.
 */
const NOT_PROVED: { gap: string; why: string }[] = [
  { gap: "no check in this phase drove a live unit manager, launchd or systemd, for the copy's timer or anything else",
    why: "the timer and the StartInterval are rendered and read back, never installed and started, and the container has no systemd as pid 1" },
  { gap: "the real upload command, the real destination and the owner-reviewed pg_dump command never ran",
    why: "every copy that landed used cp, a disk image on macOS or /dev/shm on Linux, and a pg_dump beside the throwaway cluster" },
  { gap: "a box started before the first copy creates the staging directory does not mask it until that box restarts",
    why: "the box masks a path that exists when it starts and skips one that does not, and this was never measured on a real box" },
  { gap: "a read-back naming the staging directory by its absolute path is not refused",
    why: "only the {staging} placeholder is refused" },
  { gap: "a relative destination skips the same-device refusal, and no command carries a timeout",
    why: "a hung upload is visible only as job-stale an hour later" },
  { gap: "on a real box every hourly dump differs from the last, because it carries the last copy's stamp",
    why: "commit-when-changed is proved on a one-table dump" },
  { gap: "an open job whose target's machine is off is reported by nobody",
    why: "job-stale is reported by the machine that runs the target's runner, as the stamp finding is scoped" },
  { gap: "the board's writer for its enabled and sleeping fields is not wired to the registry writer",
    why: "it would let a tailnet page with no identified person write the live registry, which is the owner's to decide" },
  { gap: "a zone checkout whose remote is the same local path written two ways reads as a mismatch",
    why: "the remote comparison is a string comparison of urls" },
  { gap: "the list of shipped checks this phase edited was measured on one machine only",
    why: "it needs git and the phase's base commit, and the Linux container copies the tree without .git, as a shallow CI clone would lack the base" },
]

/**
 * The rows whose automated half this round could NOT close, and why. Every
 * other row is asserted closed, so a row that goes open without a line here
 * fails, and so does a line here for a row that closed.
 */
const OPEN: Record<string, string> = {
  "ROLL-16, kept": "test/box-tenancy.test.ts failed on linux",
}

/** Every shipped check this phase edited, with the reason in one line. */
const EDITED: Record<string, string> = {
  "live/claude-code-boxed.test.ts": "the retired household zone setting left the live box fixture",
  "live/prove-rollout-runner.ts": "the retired zone field left the live runner proof's box context",
  "test/box-bus.test.ts": "the retired household zone setting left the fixture",
  "test/box-command.test.ts": "the context has no zone key, and the grant reaches a person's own checkout through their tree",
  "test/box-host-readonly.test.ts": "the retired zone field left the box context",
  "test/box-launchd.test.ts": "the retired zone field left the box context",
  "test/box-secrets.test.ts": "the retired household zone setting left the fixture",
  "test/box-tenancy.test.ts": "each agent reads its own zone checkout and not the other person's, symlink included",
  "test/box-worn.test.ts": "the retired household zone setting left the fixture",
  "test/check-credentials.test.ts": "the planted credential copy moved from the retired household root into the two people's checkouts",
  "test/registry-machines.test.ts": "the retired household zone setting left the fixture",
  "test/rollout-rehearsal.test.ts": "the retired zone setting and field left the rehearsal's manifest and box context",
  "test/install-atomic.test.ts": "the highest schema version a fresh install lands on is 6",
  "test/voice-records.test.ts": "the whole version set an upgraded store ends on is 1 through 6",
  "test/voice-acceptance.test.ts": "the runner map names the dispatch gate's new file and carries the digests of the runner files dispatch changed",
  "test/board-acceptance.test.ts": "the door map names every door file dispatch and agent lifecycle changed, each with its reason",
  "test/door-voice.test.ts": "one read became a wait on the projection it asserts, with the bound unchanged",
  "test/door-voice-outage.test.ts": "the control waits for its notice by the notice's own text, the window and both assertions unchanged",
  "test/registry-list.test.ts": "backup left the deferred-kind loop and gained a positive hourly assertion",
  "test/rollout-registry.test.ts": "backup left the deferred-kind loop",
  "test/run-kind-program.test.ts": "backup left the deferred-kind loop",
}

/** The master commit this phase is built on, which is what an edit is measured against. */
const BASE = "050cd7b1bd8c071cefebed739ec67b1b8675d2d8"

// ---------------------------------------------------------------------------
// Reading a check file's tests.
// ---------------------------------------------------------------------------

interface Declared {
  title: string
  /** True when the test sits behind anything but a plain `test(`. */
  gated: boolean
  /** True when a gated title carries its gate's reason, so a skip is printed with it. */
  reasonShown: boolean
}

/** The literal that opens at `at`, quotes and template expressions included. */
function literalAt(text: string, at: number): string | null {
  const quote = text[at]
  if (quote !== '"' && quote !== "'" && quote !== "`") return null
  let depth = 0
  for (let i = at + 1; i < text.length; i++) {
    const c = text[i]
    if (c === "\\") { i++; continue }
    if (quote === "`" && c === "$" && text[i + 1] === "{") { depth++; i++; continue }
    if (quote === "`" && depth > 0 && c === "}") { depth--; continue }
    if (depth === 0 && c === quote) return text.slice(at + 1, i)
  }
  return null
}

/**
 * Every test a file declares, read off its text.
 *
 * A gated file declares its tests through more than `test(`: a `test.skipIf`,
 * or a name bound to `test` or `test.skip` by a gate (`landed`, `restored`,
 * `boxed`). A reader that looked for `test(` alone would read those files as
 * empty and go red for the wrong reason, so every alias is found first.
 */
function declared(relative: string): Declared[] {
  const text = readFileSync(hubPath(relative), "utf8")
  const aliases = [...text.matchAll(/const\s+(\w+)\s*=[^\n;]*\?\s*test\s*:\s*test\.skip\b/g)].map(m => m[1])
  const opener = new RegExp(
    String.raw`(?<![\w.])(test\.skipIf\((?:[^()]|\([^()]*\))*\)|test\.if\((?:[^()]|\([^()]*\))*\)|test` +
      (aliases.length ? `|${aliases.join("|")}` : "") + String.raw`)\(\s*`, "g")
  const out: Declared[] = []
  for (const m of text.matchAll(opener)) {
    const title = literalAt(text, m.index! + m[0].length)
    if (title === null) continue
    const gated = m[1] !== "test"
    out.push({ title, gated, reasonShown: /gateSuffix\(/.test(title) })
  }
  return out
}

/** The gates, asked of THIS machine. */
function gateOf(name: Gate): { ok: boolean; reason: string } {
  if (name === "box") return boxGate()
  if (name === "device") return deviceGate()
  return pgDumpGate()
}

/**
 * Whether a row may be serialized as accepted, and why not when it may not.
 * An owner-only half is never closed by anything here, a run that skipped or
 * failed closes nothing, and an automated or kernel row owes both systems.
 */
function accepted(row: Row): { ok: boolean; because: string } {
  if (row.owner.length > 0) {
    return { ok: false, because: "an owner-only half is the owner's to record and nothing here closes it" }
  }
  for (const one of row.bound) {
    for (const os of ["macos", "linux"] as const) {
      const said = one.runs[os]
      if (said === "failed") return { ok: false, because: `${one.file} failed on ${os}` }
      if (said !== "ran") return { ok: false, because: `${one.file} ${said} on ${os}, and a skip never closes a gate` }
    }
  }
  return { ok: true, because: "" }
}

/** Whether the automated half of a row is closed, owner-only half aside. */
function automatedClosed(row: Row): { ok: boolean; because: string } {
  return accepted({ ...row, owner: [] })
}

/** What an owner-only item answers when a script offers to close it. */
function closedBy(item: OwnerOnly, by: string): { ok: boolean; because: string } {
  if (item.notSatisfiedBy.includes(by)) return { ok: false, because: `${by} is not ${item.what}` }
  return { ok: false, because: "an owner-only item is the owner's to record and nothing here closes it" }
}

// ---------------------------------------------------------------------------
// The assertions.
// ---------------------------------------------------------------------------

test("ROLL-19 ROLL-27 ROLL-28 ROLL-32 every automated row points at a check that exists and still declares each test the row leans on", () => {
  for (const requirement of ["ROLL-19", "ROLL-27", "ROLL-28", "ROLL-32", "ROLL-16, kept", "the six protected windows"]) {
    expect(INVENTORY.some(row => row.requirement === requirement), `${requirement} has a row`).toBe(true)
  }
  for (const row of INVENTORY) {
    expect(row.bound.length, `${row.requirement} names a check`).toBeGreaterThan(0)
    for (const one of row.bound) {
      expect(existsSync(hubPath(one.file)), `${row.requirement} names ${one.file}`).toBe(true)
      const titles = declared(one.file)
      expect(titles.length, `${one.file} declares tests`).toBeGreaterThan(0)
      expect(one.tests.length, `${row.requirement} names the tests it leans on in ${one.file}`).toBeGreaterThan(0)
      for (const words of one.tests) {
        const found = titles.filter(t => t.title.includes(words))
        expect(found.length, `${one.file} declares a test titled with "${words}"`).toBeGreaterThan(0)
      }
    }
  }
})

test("ROLL-19 ROLL-27 ROLL-28 ROLL-32 an automated row is gated by nothing, a kernel row is gated and shows its reason in its name, and this machine's gates are printed", () => {
  for (const row of INVENTORY) {
    for (const one of row.bound) {
      const titles = declared(one.file)
      for (const words of one.tests) {
        for (const t of titles.filter(t => t.title.includes(words))) {
          if (one.seam === "A") {
            // An automated row that gated itself is a row nobody is running.
            expect(t.gated, `${one.file}: "${words}" is an automated row and sits behind a gate`).toBe(false)
            expect(one.gates, `${one.file}: an automated row names no gate`).toEqual([])
          } else {
            expect(t.gated, `${one.file}: "${words}" is a kernel row and sits behind no gate`).toBe(true)
            expect(t.reasonShown, `${one.file}: "${words}" skips without its reason in its name`).toBe(true)
            expect(one.gates.length, `${one.file}: a kernel row names its gate`).toBeGreaterThan(0)
          }
        }
      }
      // What THIS machine did with the row, printed so a phase closed on a
      // machine that skipped half of it says so. A shut gate is a gate still
      // open, never a pass.
      const shut = one.gates.map(gateOf).filter(gate => !gate.ok)
      process.stderr.write(`[6b-inventory] ${row.requirement} ${one.seam} ${one.file}: ` +
        (shut.length === 0 ? "ran here" : `SKIPPED here, a gate still open: ${shut.map(g => g.reason).join("; ")}`) + "\n")
    }
  }
  for (const one of NOT_PROVED) process.stderr.write(`[6b-inventory] NOT PROVED: ${one.gap}\n`)
})

test("ROLL-19 ROLL-27 ROLL-28 ROLL-32 a row with a skip, a failure or no run is refused, an owner-only row is closed by nothing here, and every stand-in is refused by name", () => {
  const withOwner = INVENTORY.filter(row => row.owner.length > 0)
  expect(withOwner.map(row => row.requirement).sort()).toEqual(["ROLL-19", "ROLL-27", "ROLL-28", "ROLL-32"])
  for (const row of withOwner) {
    expect(accepted(row).ok, `${row.requirement} is closed with its owner-only half open`).toBe(false)
    for (const item of row.owner) {
      expect(item.what.length).toBeGreaterThan(0)
      expect(item.notSatisfiedBy.length, `${item.what} names what does not satisfy it`).toBeGreaterThan(0)
      for (const standIn of item.notSatisfiedBy) {
        expect(closedBy(item, standIn).ok, `${standIn} closed ${item.what}`).toBe(false)
      }
      expect(closedBy(item, "an automated run that passed").ok).toBe(false)
    }
  }

  // Skipped, failed and absent, each refused on its own row.
  const sample = INVENTORY.find(row => row.requirement === "ROLL-16, kept")!
  const one = sample.bound[0]
  expect(accepted({ ...sample, bound: [{ ...one, runs: { macos: "ran", linux: "skipped" } }] }).ok).toBe(false)
  expect(accepted({ ...sample, bound: [{ ...one, runs: { macos: "failed", linux: "ran" } }] }).ok).toBe(false)
  expect(accepted({ ...sample, bound: [{ ...one, runs: { macos: "ran" } as Bound["runs"] }] }).ok).toBe(false)

  // THE CONTROL, so a validator that refused everything fails: every row with
  // no owner-only half is accepted as the round ran it, and every row with one
  // has its automated half closed, except the rows named open, each for the
  // reason named beside it.
  for (const row of INVENTORY) {
    const open = OPEN[row.requirement]
    if (open !== undefined) {
      expect(automatedClosed(row).ok, `${row.requirement} is named open and closed`).toBe(false)
      expect(automatedClosed(row).because).toContain(open)
      continue
    }
    if (row.owner.length === 0) expect(accepted(row), row.requirement).toEqual({ ok: true, because: "" })
    expect(automatedClosed(row), row.requirement).toEqual({ ok: true, because: "" })
  }
  for (const requirement of Object.keys(OPEN)) {
    expect(INVENTORY.some(row => row.requirement === requirement), `${requirement} is named open and has no row`).toBe(true)
  }
})

test("ROLL-19 ROLL-27 ROLL-28 ROLL-32 each owner-only item is matched to a step of the owner's procedure, and nothing under test/ or live/ claims one", () => {
  // The steps the owner's cutover procedure carries for this phase: after step
  // 14 the first copy, after step 16 the three phone observations, and inside
  // step 19 the restore.
  const steps = new Set(["14a", "16a", "19"])
  const items = INVENTORY.flatMap(row => row.owner)
  expect(items.length).toBe(5)
  for (const item of items) expect(steps.has(item.step), `${item.what} names a step the procedure has`).toBe(true)
  expect(new Set(items.map(item => item.step))).toEqual(steps)

  // A live check would be the only thing here that could claim a real one, and
  // none drives the command, the move, the adopt or the copy.
  const live = readdirSync(hubPath("live")).filter(name => /\.(ts|mjs|js)$/.test(name))
  expect(live.length).toBeGreaterThan(0)
  for (const name of live) {
    const text = readFileSync(hubPath(join("live", name)), "utf8")
    for (const word of ["/dispatch", "/agent", "vault move", "backup"]) {
      expect(text.includes(word), `live/${name} mentions ${word}, so it may claim an owner-only observation`).toBe(false)
    }
  }
})

test("ROLL-19 ROLL-27 ROLL-32 the six new finding codes are each produced, and job-stale has two producers keyed differently", () => {
  const now = new Date("2026-09-21T12:00:00.000Z")
  const zone = (over: Partial<ZoneCheckState["people"][number]>, declaredZone = true): ZoneCheckState => ({
    declared: declaredZone, mount: declaredZone ? "shared" : null, url: declaredZone ? "file:///zone.git" : null,
    machine: "pi", registryFile: "/registry.toml",
    people: declaredZone ? [{ person: "p1", id: "p1-zone", path: "/v/p1/vault/shared", exists: true,
      remote: "file:///zone.git", mounted: true, foldersFile: "/v/p1/vault/_folders.md", ...over }] : [],
  })
  const kinds = (findings: { kind: string }[]) => findings.map(one => one.kind)
  expect(kinds(zoneFindings(zone({}, false)))).toEqual(["zone-undeclared"])
  expect(kinds(zoneFindings(zone({ exists: false, remote: null })))).toContain("zone-missing")
  expect(kinds(zoneFindings(zone({ remote: "file:///elsewhere.git" })))).toContain("zone-remote-mismatch")
  expect(kinds(zoneFindings(zone({ mounted: false })))).toContain("zone-unmounted")
  // The control: a declared, present, mounted checkout on the right remote is nothing.
  expect(zoneFindings(zone({}))).toEqual([])

  const backup = { id: "backup-hourly", kind: "backup", schedule: "hourly", machine: "pi" } as unknown as RunEntry
  expect(kinds(backupFindings([{ id: "backup-hourly", data: { status: "failed", cause: "copy does not match" } }], "pi", [backup])))
    .toEqual(["backup-failed"])
  expect(backupFindings([{ id: "backup-hourly", data: { status: "landed" } }], "pi", [backup])).toEqual([])

  // job-stale from a dispatched job, keyed on the job's row.
  const jobId = "job:fake:1000000001:100"
  const fromJob = staleDispatchJobs({
    jobs: [{ id: jobId, agent: "p1-batch", person: "p1", received_at: new Date(now.getTime() - 7200_000) }],
    thresholds: () => ({ acked_seconds: 30, started_seconds: 60, answered_seconds: 900, delivered_seconds: 60 }),
    runnerOf: () => "runner-mac", graceSeconds: 600, machine: "mac", now,
  } as Parameters<typeof staleDispatchJobs>[0])
  // job-stale from a scheduled entry, keyed on the entry.
  const fromEntry = staleJobs({
    entries: [backup],
    stamps: [{ id: "backup-hourly", data: { at: new Date(now.getTime() - 7200_000).toISOString(), machine: "pi" } }],
    graceSeconds: 600, now,
  })
  expect(kinds(fromJob)).toEqual(["job-stale"])
  expect(kinds(fromEntry)).toEqual(["job-stale"])
  expect(fromJob[0].subject).toBe(jobId)
  expect(fromEntry[0].subject).toBe("backup-hourly")
  expect(fromJob[0].id).not.toBe(fromEntry[0].id)
  expect(fromJob[0].id.endsWith(jobId)).toBe(true)
  expect(fromEntry[0].id.endsWith("backup-hourly")).toBe(true)

  // And each code is asserted by at least one check this phase wrote.
  const phase = INVENTORY.flatMap(row => row.bound.map(one => one.file))
  const corpus = [...new Set(phase)].map(file => readFileSync(hubPath(file), "utf8")).join("\n")
  for (const code of ["job-stale", "zone-undeclared", "zone-missing", "zone-remote-mismatch", "zone-unmounted", "backup-failed"]) {
    expect(corpus.includes(code), `a check of this phase asserts ${code}`).toBe(true)
  }
})

test("ROLL-19 ROLL-28 every new sentence a person reads is pinned whole, in both languages, by a check", () => {
  // The ten sentences, written out here, and the one check that compares each
  // one whole against what the door renders. A sentence added and never pinned
  // is what this catches.
  const TEN: [string, string, string][] = [
    ["dispatchAccepted", "[door] dispatched to {agent}. I will say when the report is back.", "[дверь] задача передана {agent}. Сообщу, когда придёт отчёт."],
    ["dispatchRefused", "[door] dispatch to {agent} refused: {cause}.", "[дверь] передача {agent} отклонена: {cause}."],
    ["dispatchUsage", "[door] use /dispatch followed by an agent ID and the task.", "[дверь] напишите /передать, идентификатор агента и задачу."],
    ["jobRefused", "[door] the job for {agent} was refused: {cause}. Nothing was run.", "[дверь] задача для {agent} отклонена: {cause}. Ничего не выполнено."],
    ["agentAccepted", "[door] {operation} requested for {agent}.", "[дверь] запрошено: {operation} для {agent}."],
    ["agentAdopted", "[door] {agent} now answers in this chat.", "[дверь] {agent} теперь отвечает в этом чате."],
    ["agentBound", "[door] {agent} now answers in {name}.", "[дверь] {agent} теперь отвечает в чате {name}."],
    ["agentRetired", "[door] {agent} is retired. Its history is kept.", "[дверь] {agent} отключён. История сохранена."],
    ["agentRefused", "[door] {operation} for {agent} refused: {cause}.", "[дверь] {operation} для {agent} отклонено: {cause}."],
    ["agentUsage", "[door] use /agent adopt followed by an agent ID and the chat's name or ID, or /agent retire followed by an agent ID.", "[дверь] напишите /агент принять, идентификатор агента и название или номер чата, либо /агент отключить и идентификатор агента."],
  ]
  const pinned = readFileSync(hubPath("test/dispatch-lines.test.ts"), "utf8").split("\n")
    .filter(line => !line.trim().startsWith("//")).join("\n")
  for (const [key, en, ru] of TEN) {
    expect(pinned.includes(JSON.stringify(key)), `${key} is named`).toBe(true)
    expect(pinned.includes(JSON.stringify(en)), `${key} is pinned whole in English`).toBe(true)
    expect(pinned.includes(JSON.stringify(ru)), `${key} is pinned whole in Russian`).toBe(true)
  }
})

test("ROLL-19 ROLL-27 ROLL-28 ROLL-32 no check of this phase drives a real unit manager, so the service rule holds with nothing to clean up", () => {
  // The rule every service check keeps is a random suffix on each unit id, the
  // unit removed in `finally`, and never a unit the owner runs. It holds here
  // with NO unit to apply it to: the copy's timer and StartInterval are rendered
  // and read back, and nothing installs or starts one through the machine's own
  // manager. The day one does, it has to meet the rule, and this is where that
  // becomes visible.
  const files = [...new Set(INVENTORY.flatMap(row => row.bound.map(one => one.file)))]
  for (const file of files) {
    const text = readFileSync(hubPath(file), "utf8")
    for (const word of ["osGate(", "launchctl", "systemctl", "manager-shim"]) {
      expect(text.includes(word), `${file} reaches a unit manager through ${word}`).toBe(false)
    }
  }
  expect(NOT_PROVED.some(one => one.gap.includes("live unit manager"))).toBe(true)
})

test("ROLL-19 ROLL-27 ROLL-28 ROLL-32 what the phase could not measure stays listed and is claimed by no row", () => {
  expect(NOT_PROVED.length).toBeGreaterThan(0)
  const claimed = INVENTORY.flatMap(row => [row.observation, ...row.bound.flatMap(one => one.tests)]).join("\n")
  for (const one of NOT_PROVED) {
    expect(one.gap.length).toBeGreaterThan(0)
    expect(one.why.length).toBeGreaterThan(0)
    expect(claimed.includes(one.gap), `a row claims what was not proved: ${one.gap}`).toBe(false)
  }
})

/**
 * Whether the edit list can be measured here: git, this phase's base, and a
 * branch not yet merged, because once it is merged the base is behind master
 * and every later phase's edits would read as this one's.
 */
function editGate(): { ok: boolean; reason: string; root: string } {
  const git = (args: string[]) => {
    try {
      const done = Bun.spawnSync(["git", ...args], { cwd: hubPath("."), stdout: "pipe", stderr: "pipe" })
      return { code: done.exitCode ?? 1, out: (done.stdout?.toString() ?? "").trim() }
    } catch {
      return { code: 127, out: "" }
    }
  }
  const root = git(["rev-parse", "--show-toplevel"])
  if (root.code !== 0) return { ok: false, reason: "no git repository here", root: "" }
  if (git(["cat-file", "-e", `${BASE}^{commit}`]).code !== 0) {
    return { ok: false, reason: "this phase's base commit is not in this clone", root: root.out }
  }
  if (git(["merge-base", "--is-ancestor", BASE, "HEAD"]).code !== 0) {
    return { ok: false, reason: "HEAD does not descend from this phase's base", root: root.out }
  }
  if (git(["rev-parse", "--verify", "--quiet", "origin/master"]).code !== 0) {
    return { ok: false, reason: "no origin/master to tell whether this phase has merged", root: root.out }
  }
  if (git(["cat-file", "-e", "origin/master:packages/plugin-hub/test/rollout-6b-acceptance.test.ts"]).code === 0) {
    return { ok: false, reason: "this phase has merged, and the list was measured on its branch before it did", root: root.out }
  }
  return { ok: true, reason: "", root: root.out }
}

const EDIT_GATE = editGate()

test.skipIf(!EDIT_GATE.ok)(`ROLL-19 ROLL-27 ROLL-28 ROLL-32 the shipped checks this phase edited are exactly the ones listed with a reason, and the six windows are not among them${EDIT_GATE.ok ? "" : ` [skipped: ${EDIT_GATE.reason}]`}`, () => {
  // Files that existed at the base and differ now, working tree included, so
  // an edit is caught before it is committed as well as after.
  const done = Bun.spawnSync(["git", "diff", "--name-only", "--diff-filter=M", BASE, "--",
    "packages/plugin-hub/test", "packages/plugin-hub/live"], { cwd: EDIT_GATE.root, stdout: "pipe", stderr: "pipe" })
  expect(done.exitCode).toBe(0)
  const changed = (done.stdout?.toString() ?? "").split("\n").map(line => line.trim()).filter(Boolean)
    .map(line => line.replace(/^packages\/plugin-hub\//, ""))
  // Helpers are fixtures, each declared in the commit that changed it. What is
  // fenced here is a shipped CHECK.
  const checks = changed.filter(file => !file.startsWith("test/helpers/") && !file.startsWith("test/fixtures/"))
  expect(checks.sort()).toEqual(Object.keys(EDITED).sort())
  for (const window of ["test/door-typing.test.ts", "test/door-outbox.test.ts", "test/door-clock.test.ts",
    "test/runner-drain.test.ts", "test/wait-idle.test.ts", "test/check-silence.test.ts"]) {
    expect(checks, `${window} is a protected window and was edited`).not.toContain(window)
  }
  for (const [file, why] of Object.entries(EDITED)) expect(why.length, `${file} says why`).toBeGreaterThan(0)
})
