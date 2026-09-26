import { readFileSync } from "node:fs";
import { recordOperationFailure } from "../diagnostics.ts";
import { readSheet } from "../records/statesheet.ts";
import { credentialFor, noticeRoute } from "../registry/entries.ts";
import { WATCH_DEFAULTS, type Registry, type RunEntry } from "../registry/load.ts";
import { openStore } from "../store/connect.ts";
import { storeUrlFor } from "../store/secrets.ts";
import { field, landSweep, link, WatchRefused } from "./record.ts";

/**
 * The Sentry morning digest: what is going on, once a day, in one message.
 *
 * NOTHING HERE HAS HANDS. One GET with a bearer token, a comparison with the
 * sheet from the day before, one notice through the door. No model reads the
 * issues, no shell runs, and every string Sentry sent is capped and stripped
 * before it reaches a record or a line.
 *
 * THE ARITHMETIC IS PURE and separated from the wire: `classify` and
 * `renderDigest` take values and return values, so the rules are readable and
 * checkable without a store or a network, and `fetchIssues` takes its `fetch`
 * as a parameter so a check hands in a fake and nothing ever dials out.
 */

/** How many pages one sweep follows before it stops. Chosen: five hundred issues is a digest nobody reads. */
const MAX_PAGES = 5;

/** How long one page may take. This runtime's `fetch` has no deadline of its own. */
const PAGE_TIMEOUT_MS = 30_000;

/** The caps SPEC section 5 asks of a watcher record, one per field. */
const TITLE_MAX = 160;
const CULPRIT_MAX = 120;
const PROJECT_MAX = 60;
const SHORT_ID_MAX = 40;

/** The digest is cut at this many lines, the header included, and the tail says how many more. */
const DIGEST_LINES = 30;

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** One issue as the digest reads it, every string already closed. */
export interface SentryIssue {
  id: string;
  shortId: string;
  title: string;
  culprit: string;
  permalink: string;
  project: string;
  events: number;
  users: number;
  firstSeen: string;
  lastSeen: string;
}

/** One row of the `watch:<entry>` sheet: what the watch knows about an issue. */
export interface IssueState {
  /** When THIS WATCH first saw it, which is what the reminder counts from. */
  first_seen: string;
  last_seen: string;
  /** `floor(log10(events))`, the scale the digest notices a change on. */
  bucket: number;
  /** The count itself, kept so a change can say from what to what. */
  events: number;
  reminded: boolean;
}

export interface WatchSettings {
  min_events: number;
  notify_events: number;
  reminder_days: number;
}

export interface DigestLine {
  kind: "new" | "grew" | "fell" | "still open";
  issue: SentryIssue;
  /** The count the day before, on a change. */
  from?: number;
  /** When the watch first saw it, on a reminder. */
  since?: string;
}

export interface Sweep {
  lines: DigestLine[];
  /** Unseen issues at or over the floor and under the notify count: counted, not shown. */
  under: number;
  /** Unseen issues under the floor: written down as seen and nothing else. */
  ignored: number;
  next: Record<string, IssueState>;
  removed: string[];
}

/** The scale a count is compared on: 1, 10, 100 and 1000 events are four buckets. */
export function bucketOf(events: number): number {
  return Math.floor(Math.log10(Math.max(events, 1)));
}

/**
 * One issue out of Sentry's answer, or null for a record with no id.
 *
 * `count` is a STRING in Sentry's API and is parsed as one, and it is the
 * one field the comparison stands on, so a count that is missing or not a
 * whole number refuses the sweep: read as zero it would say a 42-event issue
 * fell to nothing and write that down. Every other field is display, and the
 * digest says less about an issue the answer said less about.
 */
function countOf(raw: unknown, id: string): number {
  const text = typeof raw === "number" ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) {
    throw new WatchRefused("parse", "operation failed", `the count of issue ${id} is not a whole number`);
  }
  return Number(text);
}

function issueOf(raw: unknown): SentryIssue | null {
  if (raw === null || typeof raw !== "object") return null;
  const it = raw as Record<string, unknown>;
  const id = field(it.id, 64);
  if (id === "") return null;
  const events = countOf(it.count, id);
  const users = Number(it.userCount);
  const project = it.project !== null && typeof it.project === "object" ? (it.project as Record<string, unknown>).slug : "";
  return {
    id,
    shortId: field(it.shortId, SHORT_ID_MAX),
    title: field(it.title, TITLE_MAX),
    culprit: field(it.culprit, CULPRIT_MAX),
    permalink: link(it.permalink),
    project: field(project, PROJECT_MAX),
    events,
    users: Number.isFinite(users) && users >= 0 ? Math.floor(users) : 0,
    firstSeen: field(it.firstSeen, 40),
    lastSeen: field(it.lastSeen, 40),
  };
}

/** Sentry's own `Link` header: the `next` URL while it says there is one. */
export function nextPage(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    if (!/rel="next"/.test(part) || !/results="true"/.test(part)) continue;
    const found = /<([^>]+)>/.exec(part);
    if (found) return found[1];
  }
  return null;
}

function reasonOf(status: number): string {
  if (status === 401) return "login refused";
  if (status === 403) return "access denied";
  return "operation failed";
}

/**
 * Every unresolved issue the organisation has, up to `MAX_PAGES` pages, and
 * whether that was all of them.
 *
 * A non-2xx answer and a body that is not a list are both refusals: nothing is
 * posted and the state is as the last sweep left it, because an empty answer
 * from a refused key is not an empty organisation. The only page followed is
 * one on the same host the first request went to, so a `Link` header cannot
 * send the key anywhere else. A sweep that stopped at the cap with a page
 * left says so, because a partial list is not the set and an issue past the
 * cut has not resolved.
 */
export async function fetchIssues(args: {
  fetch: Fetch;
  org: string;
  query: string;
  token: string;
}): Promise<{ issues: SentryIssue[]; complete: boolean }> {
  const first = new URL(`https://sentry.io/api/0/organizations/${encodeURIComponent(args.org)}/issues/`);
  // NO statsPeriod. MEASURED against the real endpoint: a window filters the
  // result set to issues with an event inside it AND makes `count` the count
  // inside it (24h answered 2 of 21 unresolved issues, each with count 1),
  // while no window answers every unresolved issue with its lifetime count,
  // which is what the buckets and the reminder are built on.
  first.search = new URLSearchParams({ query: args.query, limit: "100" }).toString();
  const issues: SentryIssue[] = [];
  let url: string | null = first.toString();
  for (let page = 0; url !== null && page < MAX_PAGES; page += 1) {
    let answer: Response;
    try {
      answer = await args.fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${args.token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      });
    } catch (error) {
      throw new WatchRefused("fetch", "operation failed", `sentry could not be asked: ${field((error as Error).message, 120)}`);
    }
    if (!answer.ok) throw new WatchRefused("fetch", reasonOf(answer.status), `sentry answered ${answer.status}`);
    let body: unknown;
    try {
      body = await answer.json();
    } catch {
      throw new WatchRefused("parse", "operation failed", "the answer is not JSON");
    }
    if (!Array.isArray(body)) throw new WatchRefused("parse", "operation failed", "the answer is not a list of issues");
    for (const raw of body) {
      const issue = issueOf(raw);
      if (issue !== null) issues.push(issue);
    }
    const next = nextPage(answer.headers.get("link"));
    // A continuation that is not on the host the first request went to is
    // never followed, and never read as no continuation either: the sweep
    // would then be a partial set taken for the whole.
    if (next !== null && !next.startsWith(`${first.protocol}//${first.host}/`)) {
      throw new WatchRefused("fetch", "operation failed", "the next page is not on the host that was asked");
    }
    url = next;
  }
  return { issues, complete: url === null };
}

/**
 * The comparison, pure. Each issue in the sweep against what the sheet says:
 *
 * - unseen and at or over the notify count: a `new` line.
 * - unseen and under it: counted under the floor, or ignored below it, and
 *   written down as seen either way.
 * - seen and its bucket moved: a `grew` or `fell` line.
 * - seen, first seen longer ago than `reminder_days` and never reminded: one
 *   `still open` line, once. Only for an issue at or over the notify count:
 *   one the digest never showed is not one it can say is still open.
 *
 * One line per issue per day. A change outranks a reminder, and the reminder
 * then waits for the next sweep. An issue the sheet holds and the sweep does
 * not has resolved and its row goes, but only when the sweep was the whole
 * set: a sweep cut at the page cap removes nothing, because an issue past the
 * cut is still open.
 */
export function classify(args: {
  issues: SentryIssue[];
  state: Record<string, IssueState>;
  settings: WatchSettings;
  now: Date;
  complete?: boolean;
}): Sweep {
  const at = args.now.toISOString();
  const reminderMs = args.settings.reminder_days * 86_400_000;
  const sweep: Sweep = { lines: [], under: 0, ignored: 0, next: {}, removed: [] };
  const seen = new Set<string>();
  for (const issue of args.issues) {
    if (seen.has(issue.id)) continue;
    seen.add(issue.id);
    const bucket = bucketOf(issue.events);
    const prior = args.state[issue.id];
    if (prior === undefined) {
      sweep.next[issue.id] = { first_seen: at, last_seen: at, bucket, events: issue.events, reminded: false };
      if (issue.events >= args.settings.notify_events) sweep.lines.push({ kind: "new", issue });
      else if (issue.events >= args.settings.min_events) sweep.under += 1;
      else sweep.ignored += 1;
      continue;
    }
    const row: IssueState = { ...prior, last_seen: at, bucket, events: issue.events };
    if (bucket !== prior.bucket) {
      sweep.lines.push({ kind: bucket > prior.bucket ? "grew" : "fell", issue, from: prior.events });
    } else if (
      !prior.reminded &&
      issue.events >= args.settings.notify_events &&
      args.now.getTime() - Date.parse(prior.first_seen) >= reminderMs
    ) {
      row.reminded = true;
      sweep.lines.push({ kind: "still open", issue, since: prior.first_seen });
    }
    sweep.next[issue.id] = row;
  }
  sweep.removed = args.complete === false ? [] : Object.keys(args.state).filter((id) => !seen.has(id));
  return sweep;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `26 September`, in UTC, which is the day the notice key names. */
function dayWords(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]}`;
}

function plural(n: number, one: string): string {
  return `${n} ${one}${n === 1 ? "" : "s"}`;
}

/**
 * A string from Sentry as inert chat text: every Discord markdown character
 * escaped and every mention broken.
 *
 * A title is whatever the app threw, and an exception message can carry
 * request input, so `**`, a masked link or `@everyone` inside one would be
 * markup the chat honours and a ping the bot may fire. The backslash is
 * Discord's own escape. A mention has no escape, so the `@` is followed by a
 * zero-width space, which breaks `@everyone`, `@here` and `<@id>` alike and
 * reads as the same characters.
 */
export function inert(text: string): string {
  return text.replace(/[\\*_`~|[\]]/g, (one) => `\\${one}`).replace(/@/g, "@\u200b");
}

function lineOf(line: DigestLine): string {
  // Closed again on the way into the line, whichever way the issue arrived,
  // and made inert for the chat: the cap and the escape are the line's own
  // rule and not the reader's promise.
  const issue = {
    ...line.issue,
    title: inert(field(line.issue.title, TITLE_MAX)),
    project: inert(field(line.issue.project, PROJECT_MAX)),
    shortId: inert(field(line.issue.shortId, SHORT_ID_MAX)),
    permalink: link(line.issue.permalink),
  };
  const where = issue.project === "" ? "" : `${issue.project}: `;
  const title = issue.title === "" ? issue.shortId || issue.id : issue.title;
  // Bare inside angle brackets, so Discord does not unfurl every link.
  const at = issue.permalink === "" ? "" : ` <${issue.permalink}>`;
  switch (line.kind) {
    case "new":
      return `**new** ${where}${title} (${plural(issue.events, "event")}, ${plural(issue.users, "user")})${at}`;
    case "grew":
    case "fell":
      return `**${line.kind}** ${where}${title} (from ${line.from ?? 0} to ${issue.events} events)${at}`;
    case "still open":
      return `**still open** since ${dayWords(new Date(line.since ?? 0))}: ${where}${title} (${plural(issue.events, "event")})${at}`;
  }
}

/**
 * The digest, or null when the day has nothing to say: an empty sweep, or
 * one whose only news is under the floor, posts nothing at all.
 *
 * Plain English, Discord markdown, one header line and one line per issue,
 * new first, then changed, then still open, cut at `DIGEST_LINES` with the
 * tail saying how many more.
 */
export function renderDigest(sweep: Sweep, args: { now: Date; settings: WatchSettings }): string | null {
  if (sweep.lines.length === 0) return null;
  const fresh = sweep.lines.filter((line) => line.kind === "new");
  const changed = sweep.lines.filter((line) => line.kind === "grew" || line.kind === "fell");
  const open = sweep.lines.filter((line) => line.kind === "still open");
  const after = args.settings.reminder_days === 7 ? "a week" : `${args.settings.reminder_days} days`;
  const said = [
    fresh.length > 0 ? `${fresh.length} new` : "",
    changed.length > 0 ? `${changed.length} changed` : "",
    open.length > 0 ? `${open.length} still open after ${after}` : "",
  ].filter((one) => one !== "");
  const under = sweep.under > 0 ? ` ${sweep.under} more under ${args.settings.notify_events} events.` : "";
  const header = `Sentry, ${WEEKDAYS[args.now.getUTCDay()]} ${dayWords(args.now)}: ${said.join(", ")}.${under}`;
  const lines = [...fresh, ...changed, ...open].map(lineOf);
  if (lines.length + 1 <= DIGEST_LINES) return [header, ...lines].join("\n");
  const shown = lines.slice(0, DIGEST_LINES - 2);
  return [header, ...shown, `and ${lines.length - shown.length} more`].join("\n");
}

/** The sheet this entry's rows live on. */
export function sheetOf(entryId: string): string {
  return `watch:${entryId}`;
}

/** The key that makes one morning one notice. */
export function digestKey(entryId: string, at: Date): string {
  return `sentry-digest:${entryId}:${at.toISOString().slice(0, 10)}`;
}

/** The entry's counts, the file's over the shipped defaults. */
export function settingsOf(entry: RunEntry): WatchSettings & { query: string } {
  return {
    query: entry.query ?? WATCH_DEFAULTS.query,
    min_events: entry.min_events ?? WATCH_DEFAULTS.min_events,
    notify_events: entry.notify_events ?? WATCH_DEFAULTS.notify_events,
    reminder_days: entry.reminder_days ?? WATCH_DEFAULTS.reminder_days,
  };
}

/**
 * The key, read from the credential's file for this machine and trimmed. It
 * goes into one request header and nowhere else: never a diary detail, never
 * an error, never a line.
 */
function tokenOf(registry: Registry, credentialId: string): string {
  const credential = credentialFor(registry, credentialId);
  if (credential === null) throw new WatchRefused("credential", "invalid configuration", `${credentialId} is not a credential of this file`);
  let text: string;
  try {
    text = readFileSync(credential.file, "utf8");
  } catch {
    throw new WatchRefused("credential", "invalid configuration", `${credential.file} cannot be read`);
  }
  const token = text.trim();
  if (token === "") throw new WatchRefused("credential", "invalid configuration", `${credential.file} holds no token`);
  return token;
}

export interface SentryWatchOptions {
  fetch?: Fetch;
  now?: () => Date;
}

export interface SentryWatchResult {
  digest: string | null;
  posted: boolean;
  counts: Record<string, number | boolean>;
}

/**
 * One sweep, as the entry point runs it: the state read, the issues fetched,
 * the comparison made, and everything landed in one transaction.
 *
 * A failure before the landing leaves the state untouched and the stamp
 * unwritten, writes one diary line about the failure, and throws: the entry
 * exits 1 with the cause, and `check` reports the job stale once a day has
 * passed with nothing landing.
 */
export async function runSentryWatch(entry: RunEntry, registry: Registry, options: SentryWatchOptions = {}): Promise<SentryWatchResult> {
  if (entry.kind !== "watch" || entry.source !== "sentry") throw new Error("watch-entry-unknown");
  const now = options.now ?? (() => new Date());
  const send: Fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const settings = settingsOf(entry);
  const where = noticeRoute(registry, String(entry.agent));
  if (where === null) throw new WatchRefused("route", "invalid configuration", `${entry.agent} answers in no chat`);
  const store = await openStore({ url: storeUrlFor(registry, "hub_hub", entry.id) });
  try {
    // The key and the fetch come BEFORE the sheet is read, so a refused key
    // costs one request and no statement.
    const token = tokenOf(registry, String(entry.credential));
    const { issues, complete } = await fetchIssues({ fetch: send, org: String(entry.org), query: settings.query, token });
    const at = now();
    const state: Record<string, IssueState> = {};
    for (const row of await readSheet(store, sheetOf(entry.id))) state[row.id] = row.data as unknown as IssueState;
    // Zero issues where the sheet holds some is not an empty organisation, it
    // is a query that matched nothing or an answer that is wrong (SPEC 5:
    // never an empty market). The sheet is kept, nothing is stamped, and the
    // job is stale within a day. A sheet that is empty lands an empty sweep.
    const held = Object.keys(state).length;
    if (issues.length === 0 && held > 0) {
      throw new WatchRefused("empty", "operation failed", `zero issues where the sheet held ${held}`);
    }
    const sweep = classify({ issues, state, settings, now: at, complete });
    const digest = renderDigest(sweep, { now: at, settings });
    const counts = {
      seen: issues.length,
      partial: !complete,
      new: sweep.lines.filter((line) => line.kind === "new").length,
      changed: sweep.lines.filter((line) => line.kind === "grew" || line.kind === "fell").length,
      still_open: sweep.lines.filter((line) => line.kind === "still open").length,
      under: sweep.under,
      ignored: sweep.ignored,
      removed: sweep.removed.length,
    };
    const { posted } = await landSweep(store, {
      entry: entry.id,
      machine: entry.machine,
      sheet: sheetOf(entry.id),
      rows: sweep.next as unknown as Record<string, Record<string, unknown>>,
      removed: sweep.removed,
      digest,
      notice: {
        person: String(entry.person),
        agent: String(entry.agent),
        // Marked as a watcher's, so both model tails leave the line out.
        route: { ...where.route, origin: "watcher" },
        platform: where.platform,
        language: where.language,
        key: digestKey(entry.id, at),
      },
      counts,
      at,
    });
    return { digest, posted, counts };
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
