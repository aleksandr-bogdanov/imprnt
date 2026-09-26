// The Sentry morning digest: a watcher with no hands. (SPEC §5, §6)
//
// One GET with a bearer token, a comparison with the sheet from the day
// before, one notice through the door. The wire is a fake `fetch` handed in,
// so nothing here dials out, and the store is the throwaway cluster opened as
// the hub's own role, so the policies a real sweep meets are the ones met here.
//
// WHAT IS ASSERTED, in the order the brief lists it: the first sweep posts the
// digest with the right lines and writes the state; the same day again posts
// nothing and changes nothing; the next day with a grown count posts a grew
// line and forgets a resolved issue; an issue open past the reminder gets one
// reminder and never a second; a refused key posts nothing, leaves the sheet
// and the stamp alone, and the program exits 1 with the finding; an empty
// sweep posts nothing and still stamps success. The key never reaches a row.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hubPath, startCluster, type Cluster } from "./helpers/cluster.ts";
import { CHAT, stageHub, type StagedHub } from "./helpers/hub-fixture.ts";
import type { RunSpec } from "./helpers/registry.ts";
import { loadRegistry, type Registry, type RunEntry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import { programForKind } from "../src/hub/program.ts";
import { staleJobs } from "../src/check/schedule.ts";
import { finding } from "../src/door/lines.ts";
import { classify, renderDigest, runSentryWatch, type SentryIssue } from "../src/watch/sentry.ts";
import { WatchRefused } from "../src/watch/run.ts";

const SLOW = 120_000;
const HERE = process.platform === "darwin" ? "mac" : "pi";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const ENTRY = "sentry-digest";
const ORG = "example-org";
/** A synthetic key. It must appear in one request header and in no row. */
const TOKEN = "synthetic-sentry-key-0123456789abcdef";

let cluster: Cluster;
const scratch: string[] = [];

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  try {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  } finally {
    await cluster?.stop();
  }
});

function scratchDir(what: string): string {
  const dir = mkdtempSync(join(tmpdir(), what));
  scratch.push(dir);
  return dir;
}

const DOOR_ENTRY: RunSpec = {
  id: "door-fake", kind: "door", machine: HERE, platform: "fake", person: "p1",
  token_file: "/dev/null", schedule: "always", memory_limit_mb: 192,
};
const RUNNER_ENTRY: RunSpec = {
  id: "runner-test", kind: "runner", machine: HERE, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048,
};
const WATCH_ENTRY: RunSpec = {
  id: ENTRY, kind: "watch", source: "sentry", machine: HERE, schedule: "daily at 07:00",
  person: "p1", agent: "p1-lair", credential: "sentry", org: ORG,
  min_events: 1, notify_events: 10, reminder_days: 7, memory_limit_mb: 128,
};

/** One issue as Sentry's API answers it, `count` a string the way the API sends it. */
function issue(over: Partial<{ id: string; count: number; userCount: number; project: string; title: string; culprit: string; shortId: string }>) {
  const id = over.id ?? "1";
  return {
    id,
    shortId: over.shortId ?? `EX-${id}`,
    title: over.title ?? `TypeError: Cannot read properties of undefined (reading 'id') ${id}`,
    culprit: over.culprit ?? "app/handler in run",
    permalink: `https://example-org.sentry.io/issues/${id}/`,
    project: { slug: over.project ?? "whenful-api", id: "10" },
    count: String(over.count ?? 1),
    userCount: over.userCount ?? 1,
    firstSeen: "2026-09-20T06:00:00Z",
    lastSeen: "2026-09-26T06:00:00Z",
  };
}

interface Asked { url: string; authorization: string | null }

/** A fake Sentry: scripted pages, every request written down, nothing dialled. */
function fakeSentry(pages: unknown[][] | { status: number; body?: string }): { fetch: typeof fetch; asked: Asked[] } {
  const asked: Asked[] = [];
  const send = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    asked.push({ url, authorization: headers.get("authorization") });
    if (!Array.isArray(pages)) {
      return new Response(pages.body ?? "", { status: pages.status, headers: { "content-type": "application/json" } });
    }
    const nth = asked.length - 1;
    const page = pages[nth] ?? [];
    const more = nth + 1 < pages.length;
    const next = new URL(url);
    next.searchParams.set("cursor", `page-${nth + 1}`);
    return new Response(JSON.stringify(page), {
      status: 200,
      headers: {
        "content-type": "application/json",
        link: `<${url}>; rel="previous"; results="false"; cursor="0:0:1", <${next.toString()}>; rel="next"; results="${more}"; cursor="0:${nth + 1}:0"`,
      },
    });
  };
  return { fetch: send as typeof fetch, asked };
}

interface Staged {
  it: StagedHub;
  registry: Registry;
  entry: RunEntry;
  tokenFile: string;
  stop(): Promise<void>;
}

async function stage(options: { token?: string | null } = {}): Promise<Staged> {
  const dir = scratchDir("hub-watch-");
  const tokenFile = join(dir, "sentry.token");
  if (options.token !== null) writeFileSync(tokenFile, `${options.token ?? TOKEN}\n`, { mode: 0o600 });
  const it = await stageHub(cluster, {
    machines: [{ id: HERE, os: HERE_OS }],
    people: [{ id: "p1", tree: join(dir, "p1") }],
    credentials: [{ id: "sentry", kind: "api-key", file: tokenFile, owner: "p1" }],
    run: [DOOR_ENTRY, RUNNER_ENTRY, WATCH_ENTRY],
  });
  const registry = loadRegistry(it.registryFile, { machine: HERE });
  const entry = listRunEntries(registry).find((one) => one.id === ENTRY)!;
  expect(entry).toBeDefined();
  return { it, registry, entry, tokenFile, stop: () => it.stop() };
}

/** A sweep at one moment, with the store opened the way the entry point opens it. */
async function sweep(staged: Staged, at: Date, sentry: ReturnType<typeof fakeSentry>) {
  return await runSentryWatch(staged.entry, staged.registry, { fetch: sentry.fetch, now: () => at });
}

async function stateRows(staged: Staged) {
  return await staged.it.read.sheet(`watch:${ENTRY}`);
}

async function stampOf(staged: Staged) {
  return (await staged.it.read.sheet("job_success")).find((row) => row.id === ENTRY) ?? null;
}

/** Every byte the store holds about this sweep, for the assertion that the key is in none of it. */
async function everything(staged: Staged): Promise<string> {
  const ledger = await staged.it.read.ledger();
  const notices = await staged.it.read.noticeRows();
  const rows = await staged.it.read.sql("select sheet, id, data from state_row");
  return JSON.stringify({ ledger, notices, rows });
}

const DAY0 = new Date("2026-09-26T07:00:00.000Z");
const day = (n: number) => new Date(DAY0.getTime() + n * 86_400_000);

test(
  "the first sweep asks Sentry with the key, follows the next page, posts one digest with a line per new issue and writes every issue down",
  async () => {
    const staged = await stage();
    try {
      const sentry = fakeSentry([
        [
          issue({ id: "42", count: 42, userCount: 3, project: "whenful-api" }),
          issue({ id: "130", count: 130, userCount: 12, project: "whenful-web", title: "ReferenceError: window is not defined" }),
          issue({ id: "5", count: 5 }),
          issue({ id: "0", count: 0 }),
        ],
        [issue({ id: "12", count: 12, userCount: 1, project: "whenful-web", title: "a title with a\nnewline and a \u0007 bell in it" })],
      ]);
      const result = await sweep(staged, DAY0, sentry);

      // Two requests, the second the page the first pointed at, both carrying
      // the key as a bearer token and nothing else of it anywhere.
      expect(sentry.asked).toHaveLength(2);
      const first = new URL(sentry.asked[0].url);
      expect(first.origin + first.pathname).toBe(`https://sentry.io/api/0/organizations/${ORG}/issues/`);
      expect(first.searchParams.get("query")).toBe("is:unresolved");
      expect(first.searchParams.get("limit")).toBe("100");
      // No window on the request: measured against the real endpoint, a
      // window filters the set and makes `count` the count inside it, and the
      // digest is built on every unresolved issue with its lifetime count.
      expect(first.searchParams.has("statsPeriod")).toBe(false);
      expect(new URL(sentry.asked[1].url).searchParams.get("cursor")).toBe("page-1");
      for (const one of sentry.asked) expect(one.authorization).toBe(`Bearer ${TOKEN}`);

      // The digest: three new, one under the floor, one ignored, in the shape
      // the brief draws, links bare inside angle brackets.
      expect(result.posted).toBe(true);
      expect(result.digest).not.toBeNull();
      const lines = result.digest!.split("\n");
      expect(lines[0]).toBe("Sentry, Saturday 26 September: 3 new. 1 more under 10 events.");
      expect(lines[1]).toBe("**new** whenful-api: TypeError: Cannot read properties of undefined (reading 'id') 42 (42 events, 3 users) <https://example-org.sentry.io/issues/42/>");
      expect(lines[2]).toBe("**new** whenful-web: ReferenceError: window is not defined (130 events, 12 users) <https://example-org.sentry.io/issues/130/>");
      // Control characters and newlines are gone from a title before it is a line.
      expect(lines[3]).toBe("**new** whenful-web: a title with a newline and a bell in it (12 events, 1 user) <https://example-org.sentry.io/issues/12/>");
      expect(lines).toHaveLength(4);

      // ONE notice, on the agent's own door and chat, keyed on the day.
      const notices = await staged.it.read.noticeRows();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ kind: "notice", person: "p1", agent: "p1-lair", notice_key: `sentry-digest:${ENTRY}:2026-09-26`, body: result.digest });
      const [route] = await staged.it.read.sql("select route from outbox where kind = 'notice'");
      expect(route.route).toEqual({ door: "door-fake", chat: CHAT });

      // The state: one row per issue the sweep held, the counted and the
      // ignored included, so tomorrow they are seen.
      const rows = await stateRows(staged);
      expect(rows.map((row) => row.id).sort()).toEqual(["0", "12", "130", "42", "5"]);
      const at = DAY0.toISOString();
      expect(rows.find((row) => row.id === "42")!.data).toEqual({ first_seen: at, last_seen: at, bucket: 1, events: 42, reminded: false });
      expect(rows.find((row) => row.id === "130")!.data).toMatchObject({ bucket: 2, events: 130 });
      expect(rows.find((row) => row.id === "5")!.data).toMatchObject({ bucket: 0, events: 5 });
      expect(rows.find((row) => row.id === "0")!.data).toMatchObject({ bucket: 0, events: 0 });

      // The stamp, in the same transaction, says ran AND landed.
      expect((await stampOf(staged))?.data).toMatchObject({ at, machine: HERE });

      // The diary line carries the counts and never a title.
      const swept = await staged.it.read.ledger({ stream: "machine", subject: ENTRY });
      expect(swept).toHaveLength(1);
      expect(swept[0]).toMatchObject({ kind: "watch.swept", actor: "hub" });
      expect(swept[0].detail).toMatchObject({ watch: ENTRY, seen: 5, new: 3, changed: 0, still_open: 0, under: 1, ignored: 1, removed: 0, posted: true });
      expect(JSON.stringify(swept[0].detail)).not.toContain("TypeError");

      // The key reached one request header and no row of any kind.
      expect(await everything(staged)).not.toContain(TOKEN);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "the same day again posts nothing and changes nothing, and the next day a grown count is one grew line while a resolved issue is forgotten",
  async () => {
    const staged = await stage();
    try {
      const morning = [issue({ id: "42", count: 42, userCount: 3 }), issue({ id: "130", count: 130, project: "whenful-web" }), issue({ id: "7", count: 7 })];
      await sweep(staged, DAY0, fakeSentry([morning]));
      const before = await stateRows(staged);

      // The same day: the state is written again, which moves `last_seen` and
      // nothing else, and the notice key is the day's, so nothing is posted
      // twice.
      const later = new Date(DAY0.getTime() + 3_600_000);
      const again = await sweep(staged, later, fakeSentry([morning]));
      expect(again.posted).toBe(false);
      expect(again.digest).toBeNull();
      expect(await staged.it.read.noticeRows()).toHaveLength(1);
      const after = await stateRows(staged);
      const except = (rows: typeof after) => rows.map((row) => ({ id: row.id, ...row.data, last_seen: undefined }));
      expect(except(after)).toEqual(except(before));
      for (const row of after) expect(row.data.last_seen).toBe(later.toISOString());

      // The same day once more, with forty new issues, which is a digest long
      // enough to split into parts: still one row, because the day's key
      // decides for every part and not only the first.
      const busy = [...morning, ...Array.from({ length: 40 }, (_, n) => issue({ id: `busy-${n}`, count: 20 + n, project: "whenful-web" }))];
      const split = await sweep(staged, new Date(DAY0.getTime() + 7_200_000), fakeSentry([busy]));
      expect(split.posted).toBe(false);
      expect(split.digest!.length).toBeGreaterThan(2000);
      expect(await staged.it.read.noticeRows()).toHaveLength(1);
      expect((await stateRows(staged)).length).toBe(morning.length + 40);

      // The next day: 130 became 1300, which is a bucket up; 42 stayed; 7
      // resolved, so its row goes; a fresh 3-event issue is counted.
      const next = await sweep(staged, day(1), fakeSentry([[
        issue({ id: "42", count: 45, userCount: 3 }),
        issue({ id: "130", count: 1300, project: "whenful-web" }),
        issue({ id: "3", count: 3 }),
      ]]));
      expect(next.posted).toBe(true);
      expect(next.digest!.split("\n")).toEqual([
        "Sentry, Sunday 27 September: 1 changed. 1 more under 10 events.",
        "**grew** whenful-web: TypeError: Cannot read properties of undefined (reading 'id') 130 (from 130 to 1300 events) <https://example-org.sentry.io/issues/130/>",
      ]);
      const rows = await stateRows(staged);
      expect(rows.map((row) => row.id).sort()).toEqual(["130", "3", "42"]);
      expect(rows.find((row) => row.id === "130")!.data).toMatchObject({ bucket: 3, events: 1300, first_seen: DAY0.toISOString(), last_seen: day(1).toISOString() });
      expect(rows.find((row) => row.id === "42")!.data).toMatchObject({ bucket: 1, events: 45 });
      const notices = await staged.it.read.noticeRows();
      expect(notices.map((row) => row.notice_key)).toEqual([`sentry-digest:${ENTRY}:2026-09-26`, `sentry-digest:${ENTRY}:2026-09-27`]);

      // And a fall is the other word.
      const fell = await sweep(staged, day(2), fakeSentry([[
        issue({ id: "42", count: 45, userCount: 3 }),
        issue({ id: "130", count: 900, project: "whenful-web" }),
        issue({ id: "3", count: 3 }),
      ]]));
      expect(fell.digest!.split("\n")[1]).toBe("**fell** whenful-web: TypeError: Cannot read properties of undefined (reading 'id') 130 (from 1300 to 900 events) <https://example-org.sentry.io/issues/130/>");
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "an issue still open past the reminder gets one still-open line, once, and an issue the digest never showed gets none",
  async () => {
    const staged = await stage();
    try {
      const open = [issue({ id: "42", count: 42, userCount: 3 }), issue({ id: "5", count: 5 })];
      await sweep(staged, DAY0, fakeSentry([open]));
      // Six days on: not yet.
      const early = await sweep(staged, day(6), fakeSentry([open]));
      expect(early.digest).toBeNull();
      // A week on: one line, and the row remembers it.
      const week = await sweep(staged, day(7), fakeSentry([open]));
      expect(week.digest!.split("\n")).toEqual([
        "Sentry, Saturday 3 October: 1 still open after a week.",
        "**still open** since 26 September: whenful-api: TypeError: Cannot read properties of undefined (reading 'id') 42 (42 events) <https://example-org.sentry.io/issues/42/>",
      ]);
      const rows = await stateRows(staged);
      expect(rows.find((row) => row.id === "42")!.data).toMatchObject({ reminded: true });
      // The 5-event issue is a week old too and was never shown, so it is not
      // said to be still open.
      expect(rows.find((row) => row.id === "5")!.data).toMatchObject({ reminded: false });
      // The day after, and every day after that: nothing, and the stamp still lands.
      const later = await sweep(staged, day(8), fakeSentry([open]));
      expect(later.digest).toBeNull();
      expect(later.posted).toBe(false);
      expect(await staged.it.read.noticeRows()).toHaveLength(2);
      expect((await stampOf(staged))?.data).toMatchObject({ at: day(8).toISOString() });
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "a refused key, a broken answer and a missing key file post nothing, leave the sheet and the stamp alone, and the program exits 1 with the finding",
  async () => {
    const staged = await stage();
    try {
      // A sweep that landed, so there is a sheet to leave alone.
      await sweep(staged, DAY0, fakeSentry([[issue({ id: "42", count: 42 })]]));
      const before = { rows: await stateRows(staged), stamp: await stampOf(staged) };

      for (const [answer, reason] of [
        [{ status: 401, body: '{"detail":"Invalid token"}' }, "login refused"],
        [{ status: 403, body: '{"detail":"no"}' }, "access denied"],
        [{ status: 500, body: "" }, "operation failed"],
        [{ status: 200, body: "this is not json" }, "operation failed"],
        [{ status: 200, body: '{"detail":"not a list"}' }, "operation failed"],
      ] as [{ status: number; body: string }, string][]) {
        let caught: unknown;
        try {
          await sweep(staged, day(1), fakeSentry(answer));
        } catch (error) {
          caught = error;
        }
        expect(caught, JSON.stringify(answer)).toBeInstanceOf(WatchRefused);
        expect((caught as WatchRefused).reason, JSON.stringify(answer)).toBe(reason);
        expect(String((caught as Error).message)).not.toContain(TOKEN);
      }
      expect(await staged.it.read.noticeRows()).toHaveLength(1);
      expect(await stateRows(staged)).toEqual(before.rows);
      expect(await stampOf(staged)).toEqual(before.stamp);
      // Each failure is one diary line naming the step, and none names the key.
      const failed = await staged.it.read.ledger({ stream: "machine", subject: ENTRY, kind: "failed" });
      expect(failed.map((row) => (row.detail as { code: string }).code)).toEqual(["watch-fetch", "watch-fetch", "watch-fetch", "watch-parse", "watch-parse"]);
      expect(await everything(staged)).not.toContain(TOKEN);

      // The PROGRAM, as the service manager runs it, against a key file that
      // is not there: no request is made, and the exit and the line are the
      // ones an operator reads in the journal.
      const program = programForKind("watch");
      expect(program).toBe(hubPath("src/entry/watch.ts"));
      expect(existsSync(program)).toBe(true);
      rmSync(staged.tokenFile);
      const proc = Bun.spawn([process.execPath, "run", program, staged.it.registryFile, ENTRY], {
        cwd: hubPath("."),
        env: { ...process.env, BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING: "1" },
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      });
      const said = await new Response(proc.stderr).text();
      expect(await proc.exited).toBe(1);
      expect(said).toContain(finding("en", { code: "watch-failed", target: ENTRY, cause: "invalid configuration" }));
      expect(said).not.toContain(TOKEN);
      expect(await stampOf(staged)).toEqual(before.stamp);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "an empty sweep on an empty sheet posts nothing and still stamps success, an empty answer where the sheet holds rows is a failure that keeps the sheet, and a stale stamp is what check reports once a day has passed",
  async () => {
    const staged = await stage();
    try {
      const result = await sweep(staged, DAY0, fakeSentry([[]]));
      expect(result.digest).toBeNull();
      expect(result.posted).toBe(false);
      expect(await staged.it.read.noticeRows()).toEqual([]);
      expect(await stateRows(staged)).toEqual([]);
      expect((await stampOf(staged))?.data).toMatchObject({ at: DAY0.toISOString(), machine: HERE });

      // Never an empty market: once the sheet holds rows, a 2xx with zero
      // issues is a query that matched nothing or an answer that is wrong.
      // The rows stay, the stamp stays where it was, one failed line lands,
      // and nothing is posted.
      await sweep(staged, day(1), fakeSentry([[issue({ id: "42", count: 42 }), issue({ id: "5", count: 5 })]]));
      const kept = { rows: await stateRows(staged), stamp: await stampOf(staged) };
      let caught: unknown;
      try {
        await sweep(staged, day(2), fakeSentry([[]]));
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WatchRefused);
      expect((caught as WatchRefused).reason).toBe("operation failed");
      expect((caught as WatchRefused).code).toBe("empty");
      expect(await stateRows(staged)).toEqual(kept.rows);
      expect(await stampOf(staged)).toEqual(kept.stamp);
      // The one notice is the day before's digest, and the failure added none.
      expect((await staged.it.read.noticeRows()).map((row) => row.notice_key)).toEqual([`sentry-digest:${ENTRY}:2026-09-27`]);
      const failed = await staged.it.read.ledger({ stream: "machine", subject: ENTRY, kind: "failed" });
      expect(failed.map((row) => (row.detail as { code: string }).code)).toEqual(["watch-empty"]);

      // The day on the clock schedule is what `job-stale` measures against:
      // fine at a day plus the grace, late one second past it.
      const stamps = [{ id: ENTRY, data: (await stampOf(staged))!.data }];
      const stamped = Date.parse(String(stamps[0].data.at));
      expect(stamped).toBe(day(1).getTime());
      const entries = [staged.entry];
      expect(staleJobs({ entries, stamps, graceSeconds: 300, now: new Date(stamped + 86_700_000) })).toEqual([]);
      const late = staleJobs({ entries, stamps, graceSeconds: 300, now: new Date(stamped + 86_701_000) });
      expect(late.map((one) => one.kind)).toEqual(["job-stale"]);
      expect(staleJobs({ entries, stamps: [], graceSeconds: 300, now: DAY0 }).map((one) => one.kind)).toEqual(["job-no-stamp"]);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "a sweep cut at the page cap removes nothing from the sheet and says it was partial, and a whole sweep afterwards removes what resolved",
  async () => {
    const staged = await stage();
    try {
      // A whole sweep first: two issues on the sheet.
      await sweep(staged, DAY0, fakeSentry([[issue({ id: "42", count: 42 }), issue({ id: "beyond", count: 30 })]]));
      // Six pages of a hundred, the cap at five: `beyond` sits on the sixth
      // and is never read, so it must not be taken as resolved.
      const pages = Array.from({ length: 6 }, (_, page) =>
        Array.from({ length: 100 }, (_, n) => issue({ id: page === 5 && n === 0 ? "beyond" : `p${page}-${n}`, count: 1 })));
      pages[0][0] = issue({ id: "42", count: 42 });
      const capped = fakeSentry(pages);
      const partial = await sweep(staged, day(1), capped);
      expect(capped.asked).toHaveLength(5);
      expect(partial.counts).toMatchObject({ seen: 500, removed: 0, partial: true });
      const rows = await stateRows(staged);
      expect(rows.length).toBe(501);
      expect(rows.find((row) => row.id === "beyond")!.data).toMatchObject({ first_seen: DAY0.toISOString(), last_seen: DAY0.toISOString() });
      const swept = await staged.it.read.ledger({ stream: "machine", subject: ENTRY, kind: "watch.swept" });
      expect(swept[swept.length - 1].detail).toMatchObject({ partial: true, removed: 0 });

      // A whole sweep the next day, `beyond` really gone: its row goes now.
      const whole = await sweep(staged, day(2), fakeSentry([[issue({ id: "42", count: 42 })]]));
      expect(whole.counts).toMatchObject({ removed: 500, partial: false });
      expect((await stateRows(staged)).map((row) => row.id)).toEqual(["42"]);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test("the digest is cut at thirty lines with the tail saying how many more, and every string from Sentry is closed before it is a line", () => {
  const settings = { min_events: 1, notify_events: 10, reminder_days: 7 };
  const many: SentryIssue[] = Array.from({ length: 40 }, (_, n) => ({
    id: String(n), shortId: `EX-${n}`, title: `issue ${n}`, culprit: "", permalink: `https://example-org.sentry.io/issues/${n}/`,
    project: "whenful-api", events: 10 + n, users: 1, firstSeen: "", lastSeen: "",
  }));
  const sweep = classify({ issues: many, state: {}, settings, now: DAY0 });
  const lines = renderDigest(sweep, { now: DAY0, settings })!.split("\n");
  expect(lines).toHaveLength(30);
  expect(lines[0]).toBe("Sentry, Saturday 26 September: 40 new.");
  expect(lines[29]).toBe("and 12 more");
  expect(lines[28]).toBe("**new** whenful-api: issue 27 (37 events, 1 user) <https://example-org.sentry.io/issues/27/>");

  // A title longer than the cap is cut at it, a link that is not https is
  // dropped rather than printed, and a repeated id is one issue.
  const long = "x".repeat(400);
  const odd = classify({
    issues: [
      { ...many[0], title: long, permalink: "javascript:alert(1)" },
      { ...many[0] },
    ],
    state: {}, settings, now: DAY0,
  });
  const said = renderDigest(odd, { now: DAY0, settings })!.split("\n");
  expect(said).toHaveLength(2);
  expect(said[1].length).toBeLessThan(400);
  expect(said[1]).not.toContain("javascript:");
  expect(said[1]).not.toContain("<");
  expect(odd.next["0"]).toMatchObject({ events: 10 });

  // Markdown and mentions inside a title are inert in the line: a ping does
  // not fire, a masked link does not render, and a bold does not run on.
  const loud = classify({
    issues: [{ ...many[0], title: "@everyone see [x](https://e) and **this** `that` <@&1>", project: "web_app" }],
    state: {}, settings, now: DAY0,
  });
  const shouted = renderDigest(loud, { now: DAY0, settings })!.split("\n")[1];
  expect(shouted).toContain("@\u200beveryone");
  expect(shouted).toContain("\\[x\\](https://e)");
  expect(shouted).toContain("\\*\\*this\\*\\*");
  expect(shouted).toContain("\\`that\\`");
  expect(shouted).toContain("<@\u200b&1>");
  expect(shouted).toContain("web\\_app:");
  expect(shouted).not.toContain("@everyone");
  expect(shouted).not.toContain("[x](");
  expect(shouted.startsWith("**new** ")).toBe(true);

  // A day with only issues under the floor is a day with nothing to say.
  const quiet = classify({ issues: [{ ...many[0], events: 3 }], state: {}, settings, now: DAY0 });
  expect(quiet.under).toBe(1);
  expect(renderDigest(quiet, { now: DAY0, settings })).toBeNull();
});
