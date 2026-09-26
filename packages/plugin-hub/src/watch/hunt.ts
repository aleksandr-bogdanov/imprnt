import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { recordJobSuccess } from "../check/schedule.ts";
import { recordOperationFailure } from "../diagnostics.ts";
import { taskDigest } from "../door/dispatch.ts";
import { appendEntry } from "../records/diary.ts";
import { putRow, readSheet, removeRow } from "../records/statesheet.ts";
import { listAgents, noticeRoute } from "../registry/entries.ts";
import { HUNT_SOURCES, readSetting, type Registry, type RunEntry } from "../registry/load.ts";
import { openStore, type StoreLike } from "../store/connect.ts";
import type { DispatchEnvelope, JobSource } from "../store/inbound.ts";
import { storeUrlFor } from "../store/secrets.ts";
import { evaluate, type Listing, type ListingState, type Verdict, type WatchSpec } from "./evaluate.ts";
import { field, inert, postNotice, WatchRefused, type NoticeTarget } from "./record.ts";
import { loadSpecs, type OwnerRule } from "./spec.ts";
import { POLITE_PAUSE_MS, sleep } from "./sources/html.ts";
import { sourceFor, type Fetch, type FetchContext } from "./sources/index.ts";
import { parseVerdicts, triageBody, VERDICT_TEXT_MAX, type TriageVerdict } from "./triage.ts";

/**
 * A hunt: one source's spec files, every tick, in code (SPEC section 5).
 *
 * NOTHING HERE HAS HANDS. Fetch, compare with the sheet from the tick before,
 * sort every listing with `evaluate`, and land everything in one transaction:
 * the state rows, the notices the door delivers, the one job row for the
 * triage master, the diary line and the success stamp. No model reads what
 * was fetched except the triage master, which has no tools, and its answer is
 * read back the next tick as a verdict and never as an instruction.
 *
 * THE AUDIT carries every listing of every tick, one row each, into a file
 * under the person's own folder and, when the tick had anything but `seen`
 * drops to say, into the audit chat as one notice. The file carries
 * everything, the chat carries change.
 */

/** How long a listing may be absent from a complete sweep before its row goes. Chosen: two weeks is sold. */
export const GONE_AFTER_DAYS = 14;

export type Outcome = "drop" | "notify" | "triage" | "verdict" | "spec refused" | "spec failed" | "triage failed";

/** One audit row, the same fields in the file and in the chat line. */
export interface AuditRow {
  at: string;
  entry: string;
  source: string;
  /** The spec's id, or the file's name for a refused spec. */
  watch: string;
  id: string;
  title: string;
  price: number | null;
  currency: string;
  old_price?: number | null;
  url: string;
  outcome: Outcome;
  reason: string;
  verdict?: string;
  draft?: string;
  /** A drop identical to the row's last one: the same rule at the same price. In the file, out of the chat. */
  repeat?: true;
  /** What reached the person, in words: `notified p1-lair`, `told p1-lair`, `triage p1-triage`, `nothing`. */
  reached: string;
}

/** One listing as the pending job remembers it, so a verdict can be told without the page. */
interface Snapshot {
  id: string;
  spec: string;
  owner: string;
  title: string;
  price: number | null;
  currency: string;
  url: string;
}

interface PendingJob {
  at: string;
  listings: Snapshot[];
}

export interface HuntWatchOptions {
  fetch?: Fetch;
  now?: () => Date;
  /** The pause between two requests of the source. Absent means the polite default; a check passes zero. */
  pauseMs?: number;
}

export interface HuntWatchResult {
  rows: AuditRow[];
  posted: { audit: boolean; notices: number };
  counts: Record<string, number | boolean>;
  /** The id of the triage job this tick wrote, or null. */
  job: string | null;
}

export function sheetOf(entryId: string): string {
  return `watch:${entryId}`;
}

export function jobsSheetOf(entryId: string): string {
  return `watch-jobs:${entryId}`;
}

/** The folder this entry reads its spec files from: the file's, or the shipped place under the person's state. */
export function specsDirOf(registry: Registry, entry: RunEntry): string {
  if (entry.specs !== undefined) return String(entry.specs);
  const stateDir = String(readSetting(registry, "hub.state_dir") ?? "");
  return join(stateDir, String(entry.person), "watch", "specs", String(entry.source));
}

/** The audit folder sits beside the specs: `<specs>/../../audit/<source>/`. */
export function auditDirOf(registry: Registry, entry: RunEntry): string {
  return resolve(specsDirOf(registry, entry), "..", "..", "audit", String(entry.source));
}

/** Who may own a spec of this person: an agent of theirs with a door and a chat. */
export function ownerRuleOf(registry: Registry, person: string): OwnerRule {
  const owners = new Set(listAgents(registry).filter((one) => one.person === person && one.door !== undefined && one.chat !== undefined).map((one) => one.id));
  return (owner) => (owners.has(owner) ? null : `owner "${owner}" is not an agent of ${person} with a door and a chat`);
}

function priceText(price: number | null, currency: string): string {
  return price === null ? "no price" : `${price} ${currency}`;
}

function bare(url: string): string {
  return url === "" ? "" : ` <${url}>`;
}

function reasonOf(verdict: Verdict): string {
  if (verdict.bin === "drop") return `${verdict.rule}${verdict.margin === undefined ? "" : ` by ${verdict.margin > 0 ? "+" : ""}${verdict.margin}`}${verdict.value ? ` (${verdict.value})` : ""}`;
  if (verdict.bin === "notify") return verdict.entry === "price-changed" ? "price fell" : "hit";
  return verdict.reason === "price changed" ? `price changed${verdict.rule ? `, ${verdict.rule}${verdict.margin === undefined ? "" : ` by +${verdict.margin}`}` : ""}` : `no-target${verdict.rule ? ` (${verdict.rule}${verdict.margin === undefined ? "" : ` by +${verdict.margin}`})` : ""}`;
}

/** The chat line of one audit row, every string from the wire made inert. */
export function auditLine(row: AuditRow): string {
  const when = row.at.slice(11, 16);
  const price = row.price === null && row.outcome !== "drop" && row.outcome !== "notify" && row.outcome !== "triage" && row.outcome !== "verdict"
    ? "" : ` (${priceText(row.price, row.currency)}${row.old_price == null ? "" : `, was ${row.old_price}`})`;
  const what = row.outcome === "verdict" ? `verdict ${row.verdict ?? ""}` : row.outcome;
  const draft = row.draft === undefined ? "" : ` · draft: ${inert(row.draft)}`;
  return `${when} · ${inert(row.watch)} · ${inert(row.title)}${price} · ${what} · ${inert(row.reason)}${draft} · ${inert(row.reached)}`;
}

const snapshotOf = (listing: Listing, spec: WatchSpec): Snapshot => ({
  id: listing.id, spec: spec.id, owner: spec.owner, title: listing.title, price: listing.price, currency: listing.currency ?? "EUR", url: listing.url,
});

interface Notice {
  target: NoticeTarget;
  body: string;
}

/**
 * The verdicts of the jobs written on earlier ticks: read from each settled
 * job's report, applied to the listings' rows and to the audit, and the job
 * taken off the pending list. A job still open stays. A job refused or given
 * up is audited once as `triage failed` and leaves the list.
 */
async function readVerdicts(store: StoreLike, args: {
  entry: RunEntry;
  pending: { id: string; data: PendingJob }[];
  state: Record<string, ListingState>;
  owners: Map<string, NoticeTarget>;
  at: string;
}): Promise<{ rows: AuditRow[]; notices: Notice[]; done: string[]; told: number; verdicts: number }> {
  const rows: AuditRow[] = [];
  const notices: Notice[] = [];
  const done: string[] = [];
  let told = 0;
  let verdicts = 0;
  const source = String(args.entry.source);
  const base = { at: args.at, entry: args.entry.id, source };
  for (const job of args.pending) {
    const [row] = (await store.sql`select state from inbound where id = ${job.id}`) as unknown as { state: string }[];
    let failed: string | null = null;
    let report: string | null = null;
    if (!row) failed = "the job row is gone";
    else if (row.state !== "answered" && row.state !== "delivered") continue;
    else {
      const [said] = (await store.sql`select body from inbound where id = ${`report:${job.id}`}`) as unknown as { body: string }[];
      if (said) report = said.body;
      else {
        const [refusal] = (await store.sql`select detail from ledger_event where subject = ${job.id} and kind = 'dispatch.refused' order by seq desc limit 1`) as unknown as { detail: { cause?: string } }[];
        failed = refusal ? `refused: ${field(refusal.detail?.cause, 80)}` : "settled with no report";
      }
    }
    done.push(job.id);
    if (failed !== null) {
      rows.push({ ...base, watch: job.id, id: job.id, title: `${job.data.listings.length} listing(s)`, price: null, currency: "EUR", url: "", outcome: "triage failed", reason: failed, reached: "nothing" });
      continue;
    }
    const answers = parseVerdicts(report ?? "", job.data.listings.map((one) => one.id));
    for (const listing of job.data.listings) {
      const answer = answers.get(listing.id) as TriageVerdict;
      verdicts += 1;
      const held = args.state[listing.id];
      if (held) {
        const next: ListingState = { ...held, verdict: answer.verdict };
        delete next.draft;
        if (answer.verdict === "draft") next.draft = answer.text;
        // Declined at its numbers: it re-enters only on a price change.
        if (answer.verdict === "ignore" || answer.verdict === "unreadable") { next.announced_at = null; next.announced_price = null; }
        args.state[listing.id] = next;
      }
      let reached = "nothing";
      if (answer.verdict === "tell") {
        const owner = args.owners.get(listing.owner);
        if (owner) {
          notices.push({
            target: { ...owner, key: `watch-tell:${args.entry.id}:${listing.id}` },
            body: `${inert(listing.spec)}: ${inert(answer.text)} - ${inert(listing.title)} ${priceText(listing.price, listing.currency)}${bare(listing.url)}`,
          });
          reached = `told ${listing.owner}`;
          told += 1;
        } else reached = `nothing: ${listing.owner} is no longer an agent with a chat`;
      }
      rows.push({
        ...base, watch: listing.spec, id: listing.id, title: listing.title, price: listing.price, currency: listing.currency, url: listing.url,
        outcome: "verdict", reason: answer.verdict === "draft" ? "draft" : answer.text, verdict: answer.verdict,
        ...(answer.verdict === "draft" ? { draft: answer.text } : {}), reached,
      });
    }
  }
  return { rows, notices, done, told, verdicts };
}

/**
 * One tick, as the entry point runs it.
 *
 * A failure before the landing leaves the state untouched and the stamp
 * unwritten, writes one diary line about the failure, and throws: the entry
 * exits 1 with the cause and `check` reports the job stale once its interval
 * plus the grace has passed with nothing landing. One spec failing among
 * several is not that: the tick lands what the others found, audits the
 * failure by name, and removes nothing, because a partial sweep cannot say
 * what is gone.
 */
export async function runHuntWatch(entry: RunEntry, registry: Registry, options: HuntWatchOptions = {}): Promise<HuntWatchResult> {
  if (entry.kind !== "watch" || !(HUNT_SOURCES as readonly string[]).includes(String(entry.source))) throw new Error("watch-entry-unknown");
  const source = sourceFor(String(entry.source));
  if (source === null) throw new Error("watch-entry-unknown");
  const now = options.now ?? (() => new Date());
  const send: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const pauseMs = options.pauseMs ?? POLITE_PAUSE_MS;
  const person = String(entry.person);
  const auditWhere = noticeRoute(registry, String(entry.audit));
  if (auditWhere === null) throw new WatchRefused("route", "invalid configuration", `${entry.audit} answers in no chat`);
  const triageWhere = entry.triage === undefined ? null : noticeRoute(registry, String(entry.triage));
  if (entry.triage !== undefined && triageWhere === null) throw new WatchRefused("route", "invalid configuration", `${entry.triage} answers in no chat`);
  // Every notice a hunt writes is marked as a watcher's, so both model tails leave it out.
  const target = (where: NonNullable<ReturnType<typeof noticeRoute>>, agent: string, key: string): NoticeTarget =>
    ({ person, agent, route: { ...where.route, origin: "watcher" }, platform: where.platform, language: where.language, key });
  const owners = new Map<string, NoticeTarget>();
  for (const agent of listAgents(registry)) {
    if (agent.person !== person) continue;
    const where = noticeRoute(registry, agent.id);
    if (where !== null) owners.set(agent.id, target(where, agent.id, ""));
  }
  const specsDir = specsDirOf(registry, entry);
  const auditDir = auditDirOf(registry, entry);
  const loaded = loadSpecs(specsDir, source.source, { lane: entry.lane ?? null, owner: ownerRuleOf(registry, person) });

  const store = await openStore({ url: storeUrlFor(registry, "hub_hub", entry.id) });
  try {
    const at = now();
    const atIso = at.toISOString();
    const state: Record<string, ListingState> = {};
    for (const row of await readSheet(store, sheetOf(entry.id))) state[row.id] = row.data as unknown as ListingState;
    const pending = (await readSheet(store, jobsSheetOf(entry.id))).map((row) => ({ id: row.id, data: row.data as unknown as PendingJob }));

    // The verdicts first, so a listing declined this tick is `seen` below.
    const settled = await readVerdicts(store, { entry, pending, state, owners, at: atIso });
    const rows: AuditRow[] = [...settled.rows];
    const notices: Notice[] = [...settled.notices];
    const base = { at: atIso, entry: entry.id, source: source.source };
    for (const refused of loaded.refused) {
      rows.push({ ...base, watch: refused.file, id: refused.file, title: refused.file, price: null, currency: "EUR", url: "", outcome: "spec refused", reason: refused.problems.join("; "), reached: "nothing" });
    }

    // The wire, one spec after another with the polite pause between.
    const ctx: FetchContext = { fetch: send, now, pauseMs, memo: new Map() };
    const results: { spec: WatchSpec; listings: Listing[] }[] = [];
    const failed: { spec: WatchSpec; cause: WatchRefused }[] = [];
    let complete = true;
    for (const [nth, spec] of loaded.ok.entries()) {
      if (nth > 0) await sleep(pauseMs);
      try {
        const got = await source.fetch(spec, ctx);
        const listings = source.parse(got.raw, spec);
        // Never an empty market: a page that carries listing markers and
        // parses to none is a markup change, and zero on a board where the
        // sheet still holds this spec's rows is a wall or a wrong answer.
        const held = Object.values(state).filter((row) => row.spec === spec.id).length;
        if (listings.length === 0 && source.pageLooksLikeResults(got.raw)) {
          throw new WatchRefused("empty", "operation failed", `${spec.id}: the page carries listing markers and parsed to none`);
        }
        if (listings.length === 0 && source.board && held > 0) {
          throw new WatchRefused("empty", "operation failed", `${spec.id}: zero listings where the sheet held ${held}`);
        }
        if (!got.complete) complete = false;
        results.push({ spec, listings });
      } catch (error) {
        const cause = error instanceof WatchRefused ? error : new WatchRefused("sweep", "operation failed", field((error as Error).message, 120));
        failed.push({ spec, cause });
      }
    }
    // Every spec dark is a tick that did not happen: nothing lands, nothing is
    // stamped, and the diary says why. A verdict read above waits for the next tick.
    if (loaded.ok.length > 0 && failed.length === loaded.ok.length) throw failed[0].cause;
    if (failed.length > 0) complete = false;
    for (const { spec, cause } of failed) {
      rows.push({ ...base, watch: spec.id, id: spec.id, title: spec.id, price: null, currency: "EUR", url: "", outcome: "spec failed", reason: `${cause.reason}: ${cause.detail}`, reached: "nothing" });
    }

    // The sort. A listing two specs both see is evaluated once, under the first.
    const writes: Record<string, ListingState> = {};
    for (const id of settled.done.length > 0 ? Object.keys(state) : []) {
      if (settled.rows.some((row) => row.id === id && row.outcome === "verdict")) writes[id] = state[id];
    }
    const triage: { listing: Listing; spec: WatchSpec; from?: number | null; reason: string }[] = [];
    const seen = new Set<string>();
    const counts = { listings: 0, dropped: 0, seen: 0, notified: 0, triage: 0, looked: 0 };
    for (const { spec, listings } of results) {
      for (const listing of listings) {
        if (seen.has(listing.id)) continue;
        seen.add(listing.id);
        counts.listings += 1;
        const prior = state[listing.id] ?? null;
        const verdict = evaluate(listing, spec, prior);
        const row: ListingState = {
          spec: spec.id, first_seen: prior?.first_seen ?? atIso, last_seen: atIso, price: listing.price,
          announced_price: prior?.announced_price ?? null, announced_at: prior?.announced_at ?? null,
          outcome: verdict.bin, reason: reasonOf(verdict),
          ...(prior?.verdict === undefined ? {} : { verdict: prior.verdict }),
          ...(prior?.draft === undefined ? {} : { draft: prior.draft }),
        };
        const currency = listing.currency ?? "EUR";
        const from = verdict.bin === "drop" ? undefined : verdict.from;
        // The same drop as last tick is not news: on a half-hour timer an ad
        // over the ceiling would otherwise be forty-eight identical chat lines
        // a day. The file keeps every one.
        const repeat = verdict.bin === "drop" && prior?.outcome === "drop" && prior.reason === row.reason;
        let reached = "nothing";
        if (verdict.bin === "drop") {
          counts.dropped += 1;
          if (verdict.rule === "seen") counts.seen += 1;
        } else {
          row.announced_price = listing.price;
          row.announced_at = atIso;
          delete row.verdict;
          delete row.draft;
          const owner = owners.get(spec.owner);
          if (verdict.bin === "notify") {
            counts.notified += 1;
            if (owner) {
              notices.push({
                target: { ...owner, key: `watch-notify:${entry.id}:${listing.id}:${listing.price ?? "np"}` },
                body: `${inert(spec.id)}: ${inert(listing.title)} - ${priceText(listing.price, currency)}${from == null ? "" : ` (was ${from})`}${bare(listing.url)}`,
              });
              reached = `notified ${spec.owner}`;
            }
          } else if (triageWhere !== null) {
            counts.triage += 1;
            triage.push({ listing, spec, from, reason: reasonOf(verdict) });
            reached = `triage ${entry.triage}`;
          } else if (owner) {
            // No master named: the look goes to the owner, zero model turns.
            counts.looked += 1;
            notices.push({
              target: { ...owner, key: `watch-look:${entry.id}:${listing.id}:${listing.price ?? "np"}` },
              body: `${inert(spec.id)}: look - ${inert(listing.title)} - ${priceText(listing.price, currency)}${from == null ? "" : ` (was ${from})`}${bare(listing.url)} (${inert(reasonOf(verdict))})`,
            });
            reached = `look ${spec.owner}`;
          }
        }
        writes[listing.id] = row;
        rows.push({
          ...base, watch: spec.id, id: listing.id, title: listing.title, price: listing.price, currency,
          ...(from === undefined ? {} : { old_price: from }), url: listing.url, outcome: verdict.bin, reason: reasonOf(verdict), ...(repeat ? { repeat: true } : {}), reached,
        });
      }
    }

    // Gone: absent from a COMPLETE sweep for two weeks. A partial sweep, or a
    // spec that failed, cannot say what is gone, so it removes nothing.
    const removed = !complete ? [] : Object.entries(state)
      .filter(([id, row]) => !seen.has(id) && at.getTime() - Date.parse(row.last_seen) >= GONE_AFTER_DAYS * 86_400_000)
      .map(([id]) => id);

    // The triage batch: ONE job row for the master, shaped the way the door
    // shapes a dispatched job, so the runner's own gate admits it and its
    // report comes back on the master's chat, which is the audit chat.
    let job: { id: string; body: string; source: JobSource; pending: PendingJob } | null = null;
    if (triage.length > 0 && triageWhere !== null) {
      const id = `watch:${entry.id}:${atIso}`;
      const body = triageBody(triage);
      const envelope: DispatchEnvelope = {
        dispatcher: String(entry.audit), target: String(entry.triage),
        approved: { by: `watch:${entry.id}`, at: atIso, digest: taskDigest(body), source: "watch" },
        return: { agent: String(entry.triage), door: triageWhere.route.door, chat: triageWhere.route.chat },
      };
      job = {
        id, body,
        source: { log_id: id, at: atIso, door: triageWhere.route.door, chat: triageWhere.route.chat, from: person, text: body, dispatch: envelope },
        pending: { at: atIso, listings: triage.map(({ listing, spec }) => snapshotOf(listing, spec)) },
      };
    }

    // The chat carries change: every row but a `seen` drop and a repeated
    // drop. The file below carries every row.
    const chatRows = rows.filter((row) => !(row.outcome === "drop" && (row.repeat === true || row.reason.startsWith("seen"))));
    const header = `${source.source} ${atIso.slice(0, 16).replace("T", " ")}: ${counts.listings} listing${counts.listings === 1 ? "" : "s"}, ${counts.notified} notified, ${counts.triage + counts.looked} to triage, ${counts.dropped} dropped` +
      `${settled.verdicts > 0 ? `, ${settled.verdicts} verdict${settled.verdicts === 1 ? "" : "s"}` : ""}${loaded.refused.length > 0 ? `, ${loaded.refused.length} spec${loaded.refused.length === 1 ? "" : "s"} refused` : ""}${failed.length > 0 ? `, ${failed.length} spec${failed.length === 1 ? "" : "s"} failed` : ""}`;
    const auditBody = chatRows.length === 0 ? null : [header, ...chatRows.map(auditLine)].join("\n");

    let postedAudit = false;
    let postedNotices = 0;
    await store.sql.begin(async (sql) => {
      const inside = { sql, url: store.url } as StoreLike;
      const tx = sql as unknown as StoreLike["sql"];
      for (const id of removed) await removeRow(inside, sheetOf(entry.id), id);
      for (const [id, data] of Object.entries(writes)) await putRow(inside, sheetOf(entry.id), id, data as unknown as Record<string, unknown>);
      for (const notice of notices) if (await postNotice(tx, notice.target, notice.body)) postedNotices += 1;
      if (auditBody !== null) postedAudit = await postNotice(tx, target(auditWhere, String(entry.audit), `watch-audit:${entry.id}:${atIso}`), auditBody);
      if (job !== null) {
        // The master has a chat, so its row is written unprojected with its
        // door and chat, which is what the projection sweep keys on, and the
        // door is told to run it.
        const [written] = (await tx`select hub_watch_job(${job.id}, ${person}, ${String(entry.triage)}, ${job.body}, ${job.source as unknown as Record<string, unknown>}::jsonb) as fresh`) as unknown as { fresh: boolean }[];
        if (written?.fresh) {
          await appendEntry(inside, {
            stream: "control", subject: job.id, kind: "dispatch.requested", actor: "hub",
            detail: { by: `watch:${entry.id}`, dispatcher: String(entry.audit), target: String(entry.triage), at: atIso },
          });
        }
        await putRow(inside, jobsSheetOf(entry.id), job.id, job.pending as unknown as Record<string, unknown>);
      }
      for (const id of settled.done) await removeRow(inside, jobsSheetOf(entry.id), id);
      // The counts and never the text: a title is a string a stranger wrote,
      // and the diary is what a household reads.
      await appendEntry(inside, {
        stream: "machine", subject: entry.id, kind: "watch.swept", actor: "hub",
        detail: {
          watch: entry.id, source: source.source, specs: loaded.ok.length, refused: loaded.refused.length, failed: failed.length, paused: loaded.paused.length,
          ...counts, verdicts: settled.verdicts, told: settled.told, removed: removed.length, partial: !complete,
          job: job !== null, posted: postedAudit, notices: postedNotices, at: atIso,
        },
      });
      await recordJobSuccess(inside, { entry: entry.id, machine: entry.machine, at: atIso });
    });

    // The file, after the commit: one JSON object per row, the day's file.
    if (rows.length > 0) {
      mkdirSync(auditDir, { recursive: true, mode: 0o700 });
      appendFileSync(join(auditDir, `${atIso.slice(0, 10)}.jsonl`), rows.map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    }
    return {
      rows,
      posted: { audit: postedAudit, notices: postedNotices },
      counts: { specs: loaded.ok.length, refused: loaded.refused.length, failed: failed.length, ...counts, verdicts: settled.verdicts, told: settled.told, removed: removed.length, partial: !complete },
      job: job?.id ?? null,
    };
  } catch (error) {
    const refused = error instanceof WatchRefused ? error : new WatchRefused("sweep", "operation failed", field((error as Error).message, 120));
    try {
      await recordOperationFailure(store, { operation: "watch", target: entry.id,
        error: { code: `watch-${refused.code}`, message: refused.detail === "" ? refused.reason : `${refused.reason}: ${refused.detail}` } });
    } catch { /* the failure is thrown whether or not it could be recorded */ }
    throw refused;
  } finally {
    await store.close();
  }
}

export { VERDICT_TEXT_MAX };
