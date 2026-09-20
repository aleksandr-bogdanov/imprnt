// HARV-02. The watermark moves only after the filing landed.
//
// SPEC §4's Forbidden: "the watermark advanced before the filing landed",
// "deleting an unharvested slice" and "a slice harvested twice". SPEC §2: "an
// agent produces text, delivery is machinery", which is the sentence this whole
// file applies to filing. L19: "a crash means a re-run, never a lost fact."
//
// THE LOOP IS SCRIPTED AND THE FILING IS REAL. The scratch vault was scaffolded
// by the real `imprnt init` with `XDG_CONFIG_HOME` under scratch, `hub.imprnt`
// names a shim that runs the monorepo's own CLI under bun, and every note below
// is a real note that CLI really files or really refuses. That is the split
// this phase is built on: the model's taste is unbound and its output's route
// to the vault is bound completely.
//
// THE FOUR MARKER LINES, measured on 2026-09-16 against that CLI:
//   filed     STDOUT exit 0  "  ✓ filed <folder>/<slug>  (type: ..., domain: ...)"
//   noop      STDOUT exit 0  "  = <folder>/<slug> already filed, identical content (hash <h>) — no-op"
//   conflict  STDERR exit 1  "  ! <folder>/<slug> exists with DIFFERENT content — not overwriting (contradiction discipline)"
//   refused   STDERR exit 1  "  ✗ <file>: no `type:` in frontmatter — can't file a note with no type"
// The em dash and the backticks are the CLI's own bytes, quoted, not this
// file's prose.
//
// Red reasons: check 10 is import missing, `src/harvest/apply.ts`, reached
// through `src/runner/run.ts`. Check 11 is export missing, `settleHarvest`:
// `src/runner/settle.ts` is on disk and does not carry it.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  lockTable,
  seam,
  startCluster,
  until,
  waitForLockWaiter,
  type Cluster,
  type HeldLock,
} from "./helpers/cluster.ts";
import { writeGatedImprntShim, type GatedImprnt } from "./helpers/imprnt-shim.ts";
import {
  plantLine,
  stageHarvest,
  type ChatLine,
  type HarvestStage,
} from "./helpers/harvest-stage.ts";
import { slugOf } from "./helpers/scratch-vault.ts";
import { AGENT, PERSON, RUNNER, insertInbound } from "./helpers/hub-fixture.ts";

let cluster: Cluster;

const SLOW = 120_000;
/** Short, so a refused row's retry lands inside this check's own bound. */
const RETRY_SECONDS = 2;

const FEE_TITLE = "Card fee rises in October";
const LEASE_TITLE = "Lease notice period is two months";

const NOTE_FEE = `---
type: note
domain: finances
kind: reference
summary: The monthly card fee rises from nine to eleven in October.
tags: [banking, fees]
---

# ${FEE_TITLE}

The bank said the monthly card fee goes from nine to eleven in October.`;

/** The same slug, DIFFERENT body bytes. The CLI answers `conflict` on it. */
const NOTE_FEE_DIFFERENT = NOTE_FEE.replace("nine to eleven", "nine to twelve");

const NOTE_LEASE = `---
type: note
domain: life
kind: reference
summary: The lease notice period is two months.
tags: [housing]
---

# ${LEASE_TITLE}

Notice has to be given two months before the renewal date.`;

/** No `type:` at all. The CLI answers `refused` with its own ✗ line, exit 1. */
const NOTE_NO_TYPE = `---
kind: reference
summary: a note the vault will not take
tags: [banking]
---

# A note with no type

The frontmatter carries no type, so nothing can decide which folder it belongs in.`;

function envelope(...notes: string[]): string {
  return notes.map((one) => `=== NOTE ===\n${one}\n=== END ===`).join("\n\n");
}

/** Four person lines, so `notes` and `lines` disagree on purpose. */
function plantSlice(stage: HarvestStage, now: number): ChatLine[] {
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  return [
    plantLine(stage, { at: at(40), direction: "in", from: PERSON, text: "the bank raised the card fee" }),
    plantLine(stage, { at: at(39), direction: "out", from: AGENT, text: "from nine to eleven, in October" }),
    plantLine(stage, { at: at(38), direction: "in", from: PERSON, text: "and the lease notice is two months" }),
    plantLine(stage, { at: at(37), direction: "in", from: PERSON, text: "before the renewal date" }),
  ];
}

async function plantHarvestRow(
  stage: HarvestStage,
  body: { from: string | null; until: string; reason: string; lines: number },
): Promise<string> {
  const id = `harvest:${AGENT}:${body.until}`;
  await insertInbound(cluster, stage.hub.db, {
    id,
    body: JSON.stringify(body),
    kind: "harvest",
  });
  return id;
}

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  if (cluster) await cluster.stop();
});

// ---------------------------------------------------------------------------
// Check 10.
// ---------------------------------------------------------------------------

test(
  "HARV-02 the watermark moves only after the filing landed: one note filed and one refused leaves the first on disk, the watermark absent and the row back on its retry, and the retry re-harvests the whole slice and loses nothing (SPEC §4 Forbidden, L19, D-152, D-153, D-156)",
  async () => {
    const { applyNote, stageDirFor } = await seam("src/harvest/apply.ts");
    expect(typeof applyNote).toBe("function");
    const stagedAt = stageDirFor as (s: string, p: string, r: string) => string;
    const { HARVEST_SHEET } = await seam("src/harvest/sheet.ts");
    const { runRunner } = await seam("src/runner/run.ts");

    // THE SHIM IS GATED for this stage. It announces every apply and waits for
    // this check to let it through, which is the only way from outside to look
    // at the watermark sheet WHILE an apply is in flight.
    const gateDir = await mkdtemp(join(tmpdir(), "hub-harvest-gate-"));
    const gate: GatedImprnt = writeGatedImprntShim(gateDir);

    const stage = await stageHarvest(cluster, {
      hub: { tick_seconds: 2, outage_retry_seconds: RETRY_SECONDS },
      harvest: { quiet_minutes: 600, min_messages: 99, report: false },
      shim: gate.shim,
    });
    const it = stage.hub;
    let runner: { stop(): Promise<void> } | null = null;
    let control: HarvestStage | null = null;
    let controlRunner: { stop(): Promise<void> } | null = null;
    try {
      const now = Date.now();
      const slice = plantSlice(stage, now);
      const lastLine = slice[slice.length - 1];
      const feeSlug = slugOf(FEE_TITLE);
      const leaseSlug = slugOf(LEASE_TITLE);

      // TWO NOTES, IN THIS ORDER. The first files. The second has no `type:`
      // and the real CLI refuses it with its own ✗ line and exit 1.
      it.scripted.setAnswer(() => envelope(NOTE_FEE, NOTE_NO_TYPE));

      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });

      const rowId = await plantHarvestRow(stage, {
        from: null,
        until: new Date(now).toISOString(),
        reason: "quiet",
        lines: slice.length,
      });

      // ---------------------------------------------------------------
      // 0. THE WATERMARK IS NOT THERE WHILE THE APPLY IS RUNNING.
      //
      //    THE FINDING: every other assertion here
      //    reads the sheet AFTER the apply has finished, so a runner that
      //    writes the watermark early, spawns the apply, and restores the row
      //    when a note is refused shows exactly the final state a correct one
      //    shows. Nothing after the fact can tell them apart.
      //
      //    So the gate holds the FIRST apply and this reads the sheet in the
      //    gap. At that moment the loop has answered, both notes are staged on
      //    disk, and the first apply is a running child. There is nothing the
      //    watermark could honestly be recording yet.
      //
      //    WHAT THIS CATCHES AND WHAT IT DOES NOT, said plainly: it catches a
      //    watermark written before or during an apply. It does not catch one
      //    written after every apply and before the settle, because the gate is
      //    already open by then. That shape is a violation of its own and it
      //    is the lock probe that sees it. The two probes together cover
      //    the window and neither covers it alone.
      // ---------------------------------------------------------------
      const staged = stagedAt(it.stateDir, PERSON, rowId);
      const reachedGate = async (nth: number): Promise<void> =>
        until(
          `apply ${nth} reached the gate, so it is in flight right now`,
          () => gate.held() >= nth,
          60_000,
          async () =>
            "NOTHING REACHED THE GATE. Either no apply was spawned at all, or the " +
            "runner filed the note by some route other than the command " +
            "`hub.imprnt` names, which is its own failure and not a gate problem. " +
            `inbound=${JSON.stringify(await it.read.inbound())} seen=${JSON.stringify(gate.seen())}`,
        );

      await reachedGate(1);
      // Both notes were staged before any of them was applied, which is
      // the required order: stage every note, then apply them in order.
      expect(existsSync(join(staged, "1.md"))).toBe(true);
      expect(existsSync(join(staged, "2.md"))).toBe(true);
      // AND THE SHEET IS EMPTY, with a real apply running.
      expect(await it.read.harvestSheet()).toEqual([]);

      // EVERY APPLY IS GATED, not only the first, and the sheet is read while
      // each one is held. THE FINDING: with the gate opened after
      // the first note, a runner is free to advance the watermark BETWEEN the
      // two applies and restore it when the second is refused, and every later
      // assertion still passes. Releasing one ticket at a time closes that.
      gate.release(1);
      await reachedGate(2);
      // The first note really filed while the second is held, so this is the
      // gap between two applies and not the gap before either.
      expect(existsSync(join(stage.vault.vaultDir, "finances", `${feeSlug}.md`))).toBe(true);
      expect(existsSync(join(staged, "1.md"))).toBe(false);
      expect(await it.read.harvestSheet()).toEqual([]);
      gate.release(2);
      // AND THE GATE'S WORK IS DONE HERE. Every assertion that
      // needs an apply held is above, and the shim takes the NEXT ticket for
      // every apply after these two, so the retry stage below would spend its
      // whole bound waiting out the shim's own sixty second give-up twice over.
      // `open()` is the gate's own verb for exactly this: the ones waiting and
      // the ones still to come.
      gate.open();

      // The lower bound for the retry below: the refusal cannot have been
      // written before this moment.
      const refusedAfter = Date.now();
      await until(
        "the refused note refused the harvest row",
        async () =>
          (await it.read.ledger({ stream: "refusal", subject: rowId })).length > 0,
        60_000,
        async () =>
          `inbound=${JSON.stringify(await it.read.inbound())} ledger=${JSON.stringify(
            await it.read.ledger({ subject: rowId }),
          )}`,
      );

      // --- 1. NOTE ONE IS ON DISK. A filing is not a transaction with the
      //     store and pretending it is would be a lie in code.
      const noteOne = join(stage.vault.vaultDir, "finances", `${feeSlug}.md`);
      expect(existsSync(noteOne)).toBe(true);
      const snapshots = join(stage.vault.rawDir, "proposed");
      expect(existsSync(snapshots)).toBe(true);
      expect(readdirSync(snapshots).some((name) => name.startsWith(feeSlug))).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(stage.vault.vaultDir, ".manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(
        Object.keys(manifest).some(
          (key) => key.startsWith("apply:sha256:") && key.endsWith(`finances/${feeSlug}`),
        ),
      ).toBe(true);

      // --- 2. THE WATERMARK DID NOT MOVE. Assertions 1 and 2 together ARE the
      //     ordering (assertion 7): the first note is on disk and the sheet
      //     holds no row, which is only reachable by a build that applies
      //     before it settles. A build that settled first and applied
      //     afterwards has both, and fails here.
      expect(await it.read.sheet(HARVEST_SHEET as string)).toEqual([]);
      expect(await it.read.harvestSheet()).toEqual([]);

      // --- 3. THE ROW IS BACK ON ITS RETRY.
      const heldRow = (await it.read.sql(
        "select id, state, claimed_by, retry_at from inbound where id = $1",
        [rowId],
      ))[0] as Record<string, unknown>;
      expect(heldRow.claimed_by).toBeNull();
      expect(heldRow.state).toBe("received");
      expect(heldRow.retry_at).not.toBeNull();
      // BOUND FROM BOTH SIDES, because an upper bound alone is not one.
      // The rule is `now + hub.outage_retry_seconds` at
      // the moment of refusal, so a retry in the PAST is a row that comes back
      // instantly and spins, and naming that gap does not discharge it. The
      // lower bound is the moment the check started waiting for the refusal,
      // which is before the refusal was written.
      // `new Date(String(<a Date>))` truncates to the SECOND,
      // because `Date.prototype.toString` has no milliseconds, while the column
      // and the diary both carry them. Reading the value rather than its human
      // spelling is what makes the equality below an equality.
      const retryAt = new Date(heldRow.retry_at as string).getTime();
      expect(retryAt).toBeGreaterThan(refusedAfter);
      expect(retryAt).toBeLessThanOrEqual(Date.now() + (RETRY_SECONDS + 30) * 1000);

      // --- 4. THE DIARY SAYS WHY, and it says `refused.harvest` rather than
      //     `refused.outage`: a household reading its own diary can tell a dead
      //     login from a note the vault would not take.
      const refusals = await it.read.ledger({ stream: "refusal", subject: rowId });
      expect(refusals.length).toBe(1);
      expect(refusals[0].kind).toBe("refused.harvest");
      expect(refusals[0].actor).toBe("runner");
      expect(String(refusals[0].detail.said)).toContain("✗");
      expect(refusals[0].detail.agent).toBe(AGENT);
      expect(refusals[0].detail.runner).toBe(RUNNER);
      // AND THE DIARY'S OWN `retry_at` IS THE COLUMN'S. A household reading the
      // diary to find out when a refused harvest comes back is reading a
      // different number from the one `claimNext` honours unless these agree,
      // and `refuseTurn` writes both inside one transaction from one value.
      expect(new Date(String(refusals[0].detail.retry_at)).getTime()).toBe(retryAt);

      // --- 5. THE STAGING DIRECTORY IS LEFT ON DISK, holding the note the CLI
      //     refused and NOT the one it filed, because the CLI deletes what it
      //     files. A human can read what the model wrote, which is the whole
      //     reason it is staged to a file rather than piped.
      expect(existsSync(staged)).toBe(true);
      expect(existsSync(join(staged, "1.md"))).toBe(false);
      expect(existsSync(join(staged, "2.md"))).toBe(true);
      expect(readFileSync(join(staged, "2.md"), "utf8")).toBe(NOTE_NO_TYPE);

      // --- 6. NO OUTAGE WAS OPENED AND NO NOTICE WAS WRITTEN. The
      //     outage notice says "Messages are waiting and nothing is lost", and
      //     that sentence is false when what is waiting is proactive work
      //     nobody asked for.
      expect(await it.read.outageSheet()).toEqual([]);
      expect(await it.read.noticeRows()).toEqual([]);

      // -------------------------------------------------------------
      // Stage two: THE RETRY LANDS AND THE WHOLE SLICE IS RE-HARVESTED.
      // -------------------------------------------------------------
      it.scripted.setAnswer(() => envelope(NOTE_FEE, NOTE_LEASE));
      await until(
        "the retry filed both notes and the watermark moved",
        async () => (await it.read.harvestSheet()).length === 1,
        90_000,
        async () =>
          `inbound=${JSON.stringify(await it.read.inbound())} refusals=${JSON.stringify(
            await it.read.ledger({ stream: "refusal" }),
          )}`,
      );

      // --- 8. note one came back a no-op on identical bytes, note two filed,
      //     and the watermark is the LAST LINE of the slice, computed by the
      //     test from the lines it planted.
      const [watermark] = await it.read.harvestSheet();
      expect(watermark.id).toBe(`${PERSON}/${AGENT}`);
      expect((watermark.data as Record<string, unknown>).at).toBe(lastLine.at);

      // --- 9. THE RE-RUN LOST NOTHING: both notes are on disk and the
      //     manifest carries a row for each.
      expect(existsSync(noteOne)).toBe(true);
      expect(existsSync(join(stage.vault.vaultDir, "life", `${leaseSlug}.md`))).toBe(true);
      const after = JSON.parse(
        readFileSync(join(stage.vault.vaultDir, ".manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(after).some((key) => key.endsWith(`finances/${feeSlug}`))).toBe(true);
      expect(Object.keys(after).some((key) => key.endsWith(`life/${leaseSlug}`))).toBe(true);

      // --- 10. the row reaches `answered` and nothing is left holding it.
      const settled = (await it.read.sql(
        "select id, state, claimed_by from inbound where id = $1",
        [rowId],
      ))[0] as Record<string, unknown>;
      expect(settled.state).toBe("answered");
      expect(settled.claimed_by).toBeNull();

      // -------------------------------------------------------------
      // THE CONTROL: both notes well-formed from the start files both and
      // moves the watermark on the FIRST pass, with no `refused.harvest` row
      // at all. A build that never moved the watermark passes assertions 2 to
      // 6 and fails this.
      // -------------------------------------------------------------
      control = await stageHarvest(cluster, {
        hub: { tick_seconds: 2, outage_retry_seconds: RETRY_SECONDS },
        harvest: { quiet_minutes: 600, min_messages: 99, report: false },
      });
      const controlSlice = plantSlice(control, now);
      control.hub.scripted.setAnswer(() => envelope(NOTE_FEE, NOTE_LEASE));
      controlRunner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: control.hub.registryFile,
        adapters: { [control.hub.adapterName]: control.hub.scripted.adapter },
      });
      const controlRow = await plantHarvestRow(control, {
        from: null,
        until: new Date(now).toISOString(),
        reason: "quiet",
        lines: controlSlice.length,
      });
      await until(
        "the well-formed pair filed and moved the watermark on the first pass",
        async () => (await control!.hub.read.harvestSheet()).length === 1,
        60_000,
        async () => JSON.stringify(await control!.hub.read.inbound()),
      );
      expect(
        await control.hub.read.ledger({ stream: "refusal", subject: controlRow }),
      ).toEqual([]);
      expect(
        existsSync(join(control.vault.vaultDir, "finances", `${feeSlug}.md`)),
      ).toBe(true);
      expect(existsSync(join(control.vault.vaultDir, "life", `${leaseSlug}.md`))).toBe(true);
    } finally {
      // The gate opens whatever happened, so a check that ended early never
      // leaves an apply child spinning out its own bounded wait.
      gate.open();
      if (controlRunner) await controlRunner.stop();
      if (runner) await runner.stop();
      if (control) await control.stop();
      await stage.stop();
      await rm(gateDir, { recursive: true, force: true }).catch(() => {});
    }
  },
  SLOW,
);

// ---------------------------------------------------------------------------
// Check 11.
// ---------------------------------------------------------------------------

test(
  "HARV-01 and HARV-02 two notes file through the real ingest path and the watermark is the last LINE the model was shown, landing inside the settling transaction, and a conflict counts as landed while writing no refusal (SPEC §4, L19, D-141, D-153, D-154)",
  async () => {
    const { settleHarvest, settleTurn, refuseTurn } = await seam("src/runner/settle.ts");
    expect(typeof settleHarvest).toBe("function");
    // `settleTurn`'s signature is untouched, which is what nine shipped checks
    // sit on, and `refuseTurn` is still there beside its new sibling.
    expect(typeof settleTurn).toBe("function");
    expect(typeof refuseTurn).toBe("function");
    const { runRunner } = await seam("src/runner/run.ts");
    const { stageDirFor } = await seam("src/harvest/apply.ts");
    const stagedAt = stageDirFor as (s: string, p: string, r: string) => string;

    // THE SHIM IS GATED here too, and it is what puts the lock in the right
    // place: holding the apply means the runner is past its watermark read and
    // short of its settle, which is the one moment a lock on `state_row` lands
    // in front of the settle alone.
    const gateDir = await mkdtemp(join(tmpdir(), "hub-harvest-gate11-"));
    const gate: GatedImprnt = writeGatedImprntShim(gateDir);

    const stage = await stageHarvest(cluster, {
      hub: { tick_seconds: 2, outage_retry_seconds: RETRY_SECONDS },
      harvest: { quiet_minutes: 600, min_messages: 99, report: false },
      shim: gate.shim,
    });
    const it = stage.hub;
    let runner: { stop(): Promise<void> } | null = null;
    let control: HarvestStage | null = null;
    let controlRunner: { stop(): Promise<void> } | null = null;
    // THE SETTLE IS WATCHED THROUGH A LOCK, so `finally` must release it
    // however this check ends: an ACCESS EXCLUSIVE left on `state_row` outlives
    // the test body and wedges every later file on the same cluster.
    let held: HeldLock | null = null;
    try {
      const now = Date.now();
      const slice = plantSlice(stage, now);
      const lastLine = slice[slice.length - 1];
      const feeSlug = slugOf(FEE_TITLE);
      const leaseSlug = slugOf(LEASE_TITLE);

      it.scripted.setAnswer(() => envelope(NOTE_FEE, NOTE_LEASE));
      runner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: it.registryFile,
        adapters: { [it.adapterName]: it.scripted.adapter },
      });
      // ---------------------------------------------------------------
      // 0. THE SETTLE IS ONE TRANSACTION, observed as one, and the lock is
      //    taken AFTER the runner has read the watermark.
      //
      //    THE ORDER HERE IS EASY TO GET BACKWARDS. An ACCESS EXCLUSIVE lock
      //    blocks READS as well as writes,
      //    and the runner reads the stored watermark BEFORE it
      //    builds the slice. A lock taken before the row existed therefore
      //    caught that read, `waitForLockWaiter` was satisfied by it (it
      //    filters on role and relation and not on what the statement is), and
      //    the check then asserted a filed note that no apply had yet had the
      //    chance to write. A correct runner failed it.
      //
      //    So the GATE is what orders this now. The apply is held at the shim,
      //    which means the watermark read and the slice are already behind the
      //    runner and the settle is still ahead of it. The lock goes on then,
      //    the shim is released, the apply finishes, and the settle's own
      //    `putRow` is the first thing to meet the lock.
      //
      //    While it blocks, all three of the settle's parts must be invisible:
      //    no `answered` stamp, NO WATERMARK ROW, and the row still claimed. A
      //    build that committed the watermark in a transaction of its own
      //    before the settle is caught by the middle one, because that row
      //    would already be there. The sheet is read through a SEPARATE
      //    connection that takes no lock of its own.
      //
      //    WHAT THIS DOES NOT CATCH is stated as a residue: after the release,
      //    three commits a few milliseconds apart look the same as one from
      //    outside. What is bound is that nothing of the settle is visible
      //    while the sheet write waits, and that all three are there after.
      // ---------------------------------------------------------------
      const rowId = await plantHarvestRow(stage, {
        from: null,
        until: new Date(now).toISOString(),
        reason: "quiet",
        lines: slice.length,
      });

      await until(
        "the apply reached the gate, so the watermark read and the slice are done",
        () => gate.held() >= 1,
        60_000,
        async () =>
          "NOTHING REACHED THE GATE. Either no apply was spawned, or the runner " +
          "filed by some route other than the command `hub.imprnt` names. " +
          `inbound=${JSON.stringify(await it.read.inbound())}`,
      );
      // Nothing of the settle has happened yet, which is what makes the lock
      // below land in front of the settle and not in front of the read.
      expect(await it.read.harvestSheet()).toEqual([]);

      // `exclusive` AND NOT `access exclusive`, measured: the
      // stronger mode conflicts with `access share`, which is the lock every
      // `SELECT` takes, so the read of the sheet below would have waited on
      // this check's own lock until the test timed out. `exclusive` still
      // conflicts with the `row exclusive` the settle's own `putRow` takes, so
      // the write still queues and `waitForLockWaiter` still finds it.
      held = await lockTable(cluster, it.db, "state_row", "exclusive");
      gate.open();

      await waitForLockWaiter(cluster, it.db, {
        role: "hub_runner",
        relation: "state_row",
        timeoutMs: 60_000,
      });
      // The apply really ran, so the notes are on disk: what is waiting is the
      // settle and not anything before it.
      expect(existsSync(join(stage.vault.vaultDir, "finances", `${feeSlug}.md`))).toBe(true);
      expect(existsSync(join(stage.vault.vaultDir, "life", `${leaseSlug}.md`))).toBe(true);
      // And NOTHING of the settle is visible while it waits. All three.
      expect(
        (await it.read.ledger({ stream: "inbound", subject: rowId })).map((one) => one.kind),
      ).toEqual(["received"]);
      expect(await it.read.ledger({ stream: "turn", subject: rowId })).toEqual([]);
      expect(await it.read.harvestSheet()).toEqual([]);
      expect(
        (
          (await it.read.sql("select claimed_by from inbound where id = $1", [rowId]))[0] as
            Record<string, unknown>
        ).claimed_by,
      ).toBe(RUNNER);

      await held.release();
      held = null;

      await until(
        "both notes filed and the watermark landed",
        async () => (await it.read.harvestSheet()).length === 1,
        60_000,
        async () => JSON.stringify(await it.read.inbound()),
      );
      // And now all three are there together, which is the other half of "all
      // of it or none of it".
      expect(
        (await it.read.ledger({ stream: "inbound", subject: rowId })).map((one) => one.kind),
      ).toEqual(["received", "answered"]);
      expect((await it.read.ledger({ stream: "turn", subject: rowId })).length).toBe(1);

      // --- 1. both notes are on disk under the folders their `type` and
      //     `domain` imply, both snapshots exist, the manifest carries both
      //     rows, and the staging directory holds no `.md` at all, because the
      //     CLI deletes a staged note it filed.
      expect(existsSync(join(stage.vault.vaultDir, "finances", `${feeSlug}.md`))).toBe(true);
      expect(existsSync(join(stage.vault.vaultDir, "life", `${leaseSlug}.md`))).toBe(true);
      const snapshots = readdirSync(join(stage.vault.rawDir, "proposed"));
      expect(snapshots.some((name) => name.startsWith(feeSlug))).toBe(true);
      expect(snapshots.some((name) => name.startsWith(leaseSlug))).toBe(true);
      const manifest = JSON.parse(
        readFileSync(join(stage.vault.vaultDir, ".manifest.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(Object.keys(manifest).some((key) => key.endsWith(`finances/${feeSlug}`))).toBe(true);
      expect(Object.keys(manifest).some((key) => key.endsWith(`life/${leaseSlug}`))).toBe(true);
      const staged = stagedAt(it.stateDir, PERSON, rowId);
      expect(
        !existsSync(staged) || readdirSync(staged).filter((n) => n.endsWith(".md")).length === 0,
      ).toBe(true);

      // --- 2. THE WATERMARK IS ONE ROW, carrying the LAST SLICE LINE's own
      // `at` and never the row's `until`: an `in` line's clock is
      //     the platform's and an `out` line's is the door's, so a line that
      //     lands a second late must fall into the NEXT slice rather than
      //     vanish.
      const [watermark] = await it.read.harvestSheet();
      expect(watermark.id).toBe(`${PERSON}/${AGENT}`);
      const data = watermark.data as Record<string, unknown>;
      expect(data.at).toBe(lastLine.at);
      expect(data.at).not.toBe(new Date(now).toISOString());
      expect(data.row).toBe(rowId);
      expect(data.notes).toBe(2);
      expect(typeof data.harvested_at).toBe("string");

      // --- 3. `notes` AND `lines` DISAGREE ON PURPOSE here, two notes from
      //     four lines, so a build that wrote one number into both fields
      //     fails.
      expect(data.lines).toBe(slice.length);
      expect(data.notes).not.toBe(data.lines);

      // --- 4. THE SETTLE IS ONE TRANSACTION. The `answered` stamp, the `turn`
      //     ledger line and the watermark row are all present, and the
      //     watermark's `updated_at` sits inside the settle rather than before
      //     it, which is what a build that wrote the sheet in a transaction of
      //     its own would break.
      const stamps = await it.read.ledger({ stream: "inbound", subject: rowId });
      const answered = stamps.find((one) => one.kind === "answered")!;
      expect(answered).toBeDefined();
      const turnLine = (await it.read.ledger({ stream: "turn", subject: rowId }))[0];
      expect(turnLine).toBeDefined();
      const newest = (await it.read.ledger())[(await it.read.ledger()).length - 1];
      expect(new Date(watermark.updated_at).getTime()).toBeGreaterThanOrEqual(
        new Date(answered.at).getTime() - 1000,
      );
      expect(new Date(watermark.updated_at).getTime()).toBeLessThanOrEqual(
        new Date(newest.at).getTime() + 1000,
      );

      // -------------------------------------------------------------
      // THE CONFLICT STAGE: a conflict counts as landed.
      // -------------------------------------------------------------
      const bytesBefore = readFileSync(
        join(stage.vault.vaultDir, "finances", `${feeSlug}.md`),
        "utf8",
      );
      it.scripted.setAnswer(() => envelope(NOTE_FEE_DIFFERENT));
      const later = plantLine(stage, {
        at: new Date(now - 10 * 60_000).toISOString(),
        direction: "in",
        from: PERSON,
        text: "and the fee is twelve after all",
      });
      const conflictRow = await plantHarvestRow(stage, {
        from: lastLine.at,
        until: new Date(now + 1000).toISOString(),
        reason: "quiet",
        lines: 1,
      });
      await until(
        "the conflicting note was applied and the row settled",
        async () =>
          (await it.read.ledger({ stream: "turn", subject: conflictRow })).length > 0,
        60_000,
        async () => JSON.stringify(await it.read.inbound()),
      );

      // --- 5. the CLI answered `conflict` and the note on disk still holds
      //     its ORIGINAL bytes: not overwriting is the contradiction
      //     discipline, and this proves the hub honours it rather than working
      //     around it.
      expect(
        readFileSync(join(stage.vault.vaultDir, "finances", `${feeSlug}.md`), "utf8"),
      ).toBe(bytesBefore);

      // --- 6. `_needs-review.md` gained a line naming that note, which is
      //     where the vault's own workflow records it.
      const review = join(stage.vault.vaultDir, "_needs-review.md");
      expect(existsSync(review)).toBe(true);
      expect(readFileSync(review, "utf8")).toContain(feeSlug);

      // --- 7. THE WATERMARK MOVED ANYWAY, to that slice's last line. A
      //     conflict is neither a crash nor a loss: nothing about the slice
      //     was dropped, the vault recorded the contradiction, and re-running
      //     the model on the same slice produces the same conflict for ever,
      //     so a watermark that stood still would harvest that chat every
      //     quiet period until a human intervened.
      const [moved] = await it.read.harvestSheet();
      expect((moved.data as Record<string, unknown>).at).toBe(later.at);
      expect((moved.data as Record<string, unknown>).row).toBe(conflictRow);

      // --- 8. the row is `answered` and there is NO `refused.harvest` line
      //     for it, which is the assertion that separates a conflict from a
      //     refusal.
      const conflictState = (await it.read.sql(
        "select id, state from inbound where id = $1",
        [conflictRow],
      ))[0] as Record<string, unknown>;
      expect(conflictState.state).toBe("answered");
      expect(await it.read.ledger({ stream: "refusal", subject: conflictRow })).toEqual([]);

      // --- 9. the conflict is visible in the TURN RECORD, which is the first
      //     of the three places a conflict has to appear. Another check binds
      //     the second and the vault's own `_needs-review.md` is the third.
      const conflictTurn = (await it.read.ledger({ stream: "turn", subject: conflictRow }))[0];
      const harvest = conflictTurn.detail.harvest as Record<string, unknown>;
      expect(harvest.conflicts).toEqual([`finances/${feeSlug}`]);
      expect(harvest.notes).toEqual([]);

      // -------------------------------------------------------------
      // THE CONTROL: the same conflicting note staged against a vault where
      // that slug does NOT exist files cleanly and lands in `harvest.notes`,
      // so the conflict is the vault's answer and not a shape this check
      // imagined.
      // -------------------------------------------------------------
      control = await stageHarvest(cluster, {
        hub: { tick_seconds: 2, outage_retry_seconds: RETRY_SECONDS },
        harvest: { quiet_minutes: 600, min_messages: 99, report: false },
      });
      plantSlice(control, now);
      control.hub.scripted.setAnswer(() => envelope(NOTE_FEE_DIFFERENT));
      controlRunner = await (runRunner as Function)({
        runner: RUNNER,
        registryFile: control.hub.registryFile,
        adapters: { [control.hub.adapterName]: control.hub.scripted.adapter },
      });
      const cleanRow = await plantHarvestRow(control, {
        from: null,
        until: new Date(now).toISOString(),
        reason: "quiet",
        lines: 4,
      });
      await until(
        "the same note filed cleanly into a vault that did not hold that slug",
        async () =>
          (await control!.hub.read.ledger({ stream: "turn", subject: cleanRow })).length > 0,
        60_000,
        async () => JSON.stringify(await control!.hub.read.inbound()),
      );
      const cleanTurn = (
        await control.hub.read.ledger({ stream: "turn", subject: cleanRow })
      )[0];
      const cleanHarvest = cleanTurn.detail.harvest as Record<string, unknown>;
      expect(cleanHarvest.notes).toEqual([`finances/${feeSlug}`]);
      expect(cleanHarvest.conflicts).toEqual([]);
      expect(
        existsSync(join(control.vault.vaultDir, "finances", `${feeSlug}.md`)),
      ).toBe(true);
    } finally {
      // The lock first, because everything below waits on the store.
      if (held) await held.release().catch(() => {});
      gate.open();
      if (controlRunner) await controlRunner.stop();
      if (runner) await runner.stop();
      if (control) await control.stop();
      await stage.stop();
      await rm(gateDir, { recursive: true, force: true }).catch(() => {});
    }
  },
  SLOW,
);
