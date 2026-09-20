// A job that has been open too long is a finding that names it, and it clears
// the moment the job is answered.
//
// L13 rules that a job with no success stamp is forbidden, and an open job past
// its threshold is the reading of that for work nobody has stamped yet. The
// threshold is the job's PERSON's own answered threshold plus the household's
// one grace setting, `hub.job_grace_seconds`, the same grace the scheduled jobs
// already use. Nothing anywhere holds a clock line for a job in a chat: the job
// sits on another agent's queue, and this finding is how an operator hears
// about one that never came back.
//
// ONE FINDING CODE, TWO PRODUCERS, AND NO SHARED CODE. The shipped producer
// reads a scheduled entry's own success stamp and is keyed on the entry's id.
// This one reads the queue and is keyed on the job row's id. They share the
// word an operator greps, and the check asserts both alive in the same run
// with different ids.
//
// Red reason: behaviour absent. `runCheck` reads no open jobs at all
// (`src/check/run.ts`), so a job that never came back is reported by nothing.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { startCluster, type Cluster } from "./helpers/cluster.ts"
import { rolloutStage, DISPATCH_TARGET, DISPATCH_TARGET_RU } from "./helpers/rollout-stage.ts"
import { superStore } from "./helpers/hub-fixture.ts"
import { fakeProber } from "./helpers/prober.ts"
import { runCheck, CHECK_SHEET } from "../src/check/run.ts"
import { recordJobSuccess } from "../src/check/schedule.ts"
import type { Finding } from "../src/check/finding.ts"
import { finding } from "../src/door/lines.ts"

let cluster: Cluster
beforeAll(async () => { cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

/** The one grace setting this household has, and the two people's own thresholds. */
const GRACE = 50
const P1_ANSWERED = 100
const P2_ANSWERED = 1000

test("D-213 an open job past its person's threshold plus the grace is a finding named by its row, and answering it clears the row", async () => {
  const it = await rolloutStage(cluster, "telegram", {
    dispatch: true,
    hub: { job_grace_seconds: GRACE },
    people: [
      { id: "p1", language: "en", answered_seconds: P1_ANSWERED },
      { id: "p2", language: "ru", answered_seconds: P2_ANSWERED },
    ],
    // Two scheduled entries on this machine, so the shipped producer has
    // something to say in the same run: one that never stamped and one whose
    // stamp is old.
    registry: spec => ({
      ...spec,
      run: [
        ...spec.run!,
        { id: "watch-ledger", kind: "runner", child_memory_limit_mb: 2048, machine: "pi", schedule: "every 30m", memory_limit_mb: 128 },
        { id: "backup", kind: "runner", child_memory_limit_mb: 2048, machine: "pi", schedule: "hourly", memory_limit_mb: 256 },
      ],
    }),
  })
  const store = await superStore(cluster, it.db)
  const now = new Date()
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000).toISOString()
  const check = async () => (await runCheck({ machine: "pi", registryFile: it.registryFile, store,
    os: null, kernel: null, credentials: fakeProber({}), now })) as Finding[]
  const plant = async (id: string, agent: string, person: string, seconds: number) => {
    await it.read.sql(
      `insert into inbound (id, person, agent, body, kind, received_at, log_ready)
       values ($1, $2, $3, 'a synthetic task', 'job', $4, true)`, [id, person, agent, ago(seconds)])
  }
  const jobFindings = (found: Finding[]) => found.filter(one => one.kind === "job-stale" && one.subject.startsWith("job:"))
  try {
    // --- The controls first: no job rows at all, then one well inside its
    //     threshold. Without these a build that reported every job passes.
    expect(jobFindings(await check())).toEqual([])
    await plant("job:young", DISPATCH_TARGET, "p1", 10)
    expect(jobFindings(await check())).toEqual([])

    // --- 3. The boundary, against the shipped grace: exactly the threshold
    //     plus the grace is not late, and a second past it is.
    await plant("job:edge", DISPATCH_TARGET, "p1", P1_ANSWERED + GRACE)
    await plant("job:late", DISPATCH_TARGET, "p1", P1_ANSWERED + GRACE + 1)
    // --- 2. The same age for the second person, whose own threshold is ten
    //     times longer, so it is not reported.
    await plant("job:patient", DISPATCH_TARGET_RU, "p2", P1_ANSWERED + GRACE + 1)
    // --- 5. A refused job is settled answered with no report, so it must not
    //     be reported as stale: a refusal that left a permanent finding would be
    //     worse than the refusal.
    await plant("job:refused", DISPATCH_TARGET, "p1", 10 * (P1_ANSWERED + GRACE))
    await it.read.sql(`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'job:refused', 'answered', 'runner')`)
    // --- 6. The shipped producer's two cases.
    await recordJobSuccess(store, { entry: "backup", machine: "pi", at: ago(3600 + GRACE + 120) })

    const beforeRows = await it.read.sql(`select sheet, id, data from state_row where sheet <> $1 order by sheet, id`, [CHECK_SHEET])
    const beforeDiary = await it.read.sql(`select seq from ledger_event order by seq`)
    const found = await check()

    // --- 1. Exactly one, field by field.
    const late = jobFindings(found)
    expect(late).toHaveLength(1)
    const [one] = late
    expect(one.id).toBe("pi/job-stale:job:late")
    expect(one.kind).toBe("job-stale")
    expect(one.subject).toBe("job:late")
    expect(one.machine).toBe("pi")
    expect(one.says).toContain(DISPATCH_TARGET)
    expect(one.says).toContain(String(P1_ANSWERED + GRACE + 1))
    expect(typeof one.fix).toBe("string")
    expect(one.fix.length).toBeGreaterThan(0)

    // --- 6. The shipped producer is alive in the same run, keyed on entries.
    const byId = new Map(found.map(f => [f.id, f]))
    expect(byId.get("pi/job-no-stamp:watch-ledger")?.subject).toBe("watch-ledger")
    expect(byId.get("pi/job-stale:backup")?.subject).toBe("backup")
    expect(new Set([one.id, "pi/job-stale:backup", "pi/job-no-stamp:watch-ledger"]).size).toBe(3)

    // --- 7. `check` wrote only its own sheet: every other state row and the
    //     whole diary are as they were before the run.
    expect(await it.read.sql(`select sheet, id, data from state_row where sheet <> $1 order by sheet, id`, [CHECK_SHEET]))
      .toEqual(beforeRows)
    expect(await it.read.sql(`select seq from ledger_event order by seq`)).toEqual(beforeDiary)
    const sheet = (await it.read.sheet(CHECK_SHEET)).map(row => row.id)
    expect(sheet).toContain("pi/job-stale:job:late")

    // --- 8. The code is machine vocabulary, the same in a Russian line.
    expect(finding("ru", { code: one.kind, target: one.subject, cause: one.says }).startsWith("job-stale: job:late: ")).toBe(true)

    // --- 4. Answered, it clears, and the sheet row is GONE rather than left
    //     behind, which is how every shipped finding clears.
    await it.read.sql(`insert into ledger_event (stream, subject, kind, actor) values ('inbound', 'job:late', 'answered', 'runner')`)
    expect(jobFindings(await check())).toEqual([])
    expect((await it.read.sheet(CHECK_SHEET)).map(row => row.id)).not.toContain("pi/job-stale:job:late")
    // The entry-keyed ones are still standing, because only the job moved.
    expect((await it.read.sheet(CHECK_SHEET)).map(row => row.id)).toContain("pi/job-stale:backup")
  } finally { await store.close(); await it.stop() }
}, 90_000)
