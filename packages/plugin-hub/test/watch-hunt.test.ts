// A hunt: spec files, a fake wire, the throwaway store, and everything a tick
// lands. (SPEC section 5)
//
// WHAT IS ASSERTED: the first tick over three specs lands the state, the
// audit file, the audit notice, the notify notice and ONE admissible job row
// for the triage master; a tick with nothing new posts nothing to the chat and
// still writes the file; a settled report becomes verdicts, a tell notice and
// audit rows and clears the pending list; a price fall re-enters; every spec
// dark lands nothing and stamps nothing while one spec dark lands the rest as
// a partial sweep that removes nothing; a refused spec is audited; the audit
// and owner lines are marked as a watcher's and are in neither tail.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCluster, until, type Cluster } from "./helpers/cluster.ts";
import { CHAT, chatLogLines, stageHub, superStore, type StagedHub } from "./helpers/hub-fixture.ts";
import type { RunSpec } from "./helpers/registry.ts";
import { runDoor } from "../src/door/run.ts";
import { readTail } from "../src/chatlog.ts";
import { deriveTail } from "../src/chatlog/derive.ts";
import { taskDigest } from "../src/door/dispatch.ts";
import { loadRegistry, type Registry, type RunEntry } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import { admitJob } from "../src/runner/job.ts";
import { runWatch, WatchRefused } from "../src/watch/run.ts";
import { runHuntWatch, auditDirOf, specsDirOf } from "../src/watch/hunt.ts";
import { TRIAGE_INSTRUCTION } from "../src/watch/triage.ts";
import { runCheck, type Finding } from "../src/check/run.ts";
import { fakeProber } from "./helpers/prober.ts";

const SLOW = 120_000;
const HERE = process.platform === "darwin" ? "mac" : "pi";
const HERE_OS = process.platform === "darwin" ? "macos" : "linux";
const ENTRY = "watch-kleinanzeigen";
const TRIAGE = "p1-triage";
const AUDIT_CHAT = "watch-audit-chat";
const FIXTURES = join(import.meta.dir, "fixtures", "watch");
const fixture = (source: string, name: string) => readFileSync(join(FIXTURES, source, name), "utf8");

let cluster: Cluster;

beforeAll(async () => {
  cluster = await startCluster();
});

afterAll(async () => {
  await cluster?.stop();
});

const DOOR_ENTRY: RunSpec = {
  id: "door-fake", kind: "door", machine: HERE, platform: "fake", person: "p1",
  token_file: "/dev/null", schedule: "always", memory_limit_mb: 192,
};
const RUNNER_ENTRY: RunSpec = {
  id: "runner-test", kind: "runner", machine: HERE, schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048,
};

/** A second classic page: two graphics cards, one under a hundred. */
const GPU_PAGE = `<html><body><div id="srchrslt-adtable">
<article class="aditem" data-adid="620001" data-href="/s-anzeige/wolkenkarte-8gb/620001-225-1000">
<div class="aditem-main--top--left">12345 Musterstadt (2 km)</div><div class="aditem-main--top--right">Heute, 09:00</div>
<h2>Wolkenkarte GPU 8GB</h2><p class="aditem-main--middle--price-shipping--price">90 €</p></article>
<article class="aditem" data-adid="620002" data-href="/s-anzeige/wolkenkarte-16gb/620002-225-1000">
<div class="aditem-main--top--left">12345 Musterstadt (2 km)</div><div class="aditem-main--top--right">Heute, 09:00</div>
<h2>Wolkenkarte GPU 16GB</h2><p class="aditem-main--middle--price-shipping--price">400 €</p></article>
</div></body></html>`;

/** A third classic page: three monitors, for a spec with no notify block. */
const monitorPage = (prices: [number, number, number]) => `<html><body><div id="srchrslt-adtable">
<article class="aditem" data-adid="730001" data-href="/s-anzeige/klarblick-27/730001-225-1000">
<div class="aditem-main--top--left">12345 Musterstadt (4 km)</div><div class="aditem-main--top--right">Heute, 08:00</div>
<h2>Klarblick Monitor 27 Zoll</h2><p class="aditem-main--middle--price-shipping--price">${prices[0]} €</p></article>
<article class="aditem" data-adid="730002" data-href="/s-anzeige/klarblick-32/730002-225-1000">
<div class="aditem-main--top--left">12345 Musterstadt (4 km)</div><div class="aditem-main--top--right">Heute, 08:00</div>
<h2>Klarblick Monitor 32 Zoll</h2><p class="aditem-main--middle--price-shipping--price">${prices[1]} €</p></article>
<article class="aditem" data-adid="730003" data-href="/s-anzeige/klarblick-24/730003-225-1000">
<div class="aditem-main--top--left">12345 Musterstadt (4 km)</div><div class="aditem-main--top--right">Heute, 08:00</div>
<h2>Klarblick Monitor 24 Zoll</h2><p class="aditem-main--middle--price-shipping--price">${prices[2]} €</p></article>
</div></body></html>`;

const URLS = {
  ddr5: "https://www.kleinanzeigen.de/s-ddr5-6000/k0",
  gpu: "https://www.kleinanzeigen.de/s-grafikkarte/k0",
  monitor: "https://www.kleinanzeigen.de/s-monitor/k0",
};

const DDR5_SPEC = {
  id: "de__ddr5", source: "kleinanzeigen", owner: "p1-lair", lane: "digest",
  target: { query: "ddr5 6000" },
  hard: { max_price: 260, exclude: ["laptop"], wanted_ad: false, rental_ad: false, radius_km: 50 },
  notify: { price_at_or_under: 150 },
  soft: ["a 2x16 kit only, not 1x32"], note: "the build wants 32GB at 6000",
  added: "2026-07-14T21:27:53.667Z",
};
const GPU_SPEC = {
  id: "de__gpu", source: "kleinanzeigen", owner: "p1-lair", lane: "tripwire",
  target: { query: "grafikkarte" }, hard: {}, notify: { price_at_or_under: 100 },
};
const MONITOR_SPEC = {
  id: "de__monitor", source: "kleinanzeigen", owner: "p1-lair", lane: "digest",
  target: { query: "monitor" }, hard: { max_price: 300 }, soft: ["27 inch or bigger"],
};

interface Asked { url: string }

/** A fake site: a page per URL, every request written down, nothing dialled. */
function wire(pages: Record<string, string | number>): { fetch: typeof fetch; asked: Asked[] } {
  const asked: Asked[] = [];
  const send = async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    asked.push({ url });
    const page = pages[url];
    if (page === undefined) return new Response("nothing here", { status: 404 });
    if (typeof page === "number") return new Response("", { status: page });
    return new Response(page, { status: 200 });
  };
  return { fetch: send as typeof fetch, asked };
}

const ALL_PAGES = { [URLS.ddr5]: fixture("kleinanzeigen", "search-classic.html"), [URLS.gpu]: GPU_PAGE, [URLS.monitor]: monitorPage([120, 200, 80]) };

interface Staged {
  it: StagedHub;
  registry: Registry;
  entry: RunEntry;
  specsDir: string;
  stop(): Promise<void>;
}

async function stage(options: { triage?: boolean; specs?: Record<string, unknown>[]; lane?: string; hub?: Record<string, number> } = {}): Promise<Staged> {
  const watch: RunSpec = {
    id: ENTRY, kind: "watch", source: "kleinanzeigen", machine: HERE, schedule: "every 30m",
    person: "p1", audit: TRIAGE, ...(options.triage === false ? {} : { triage: TRIAGE }), ...(options.lane ? { lane: options.lane } : {}), memory_limit_mb: 192,
  };
  const dir = mkdtempSync(join(tmpdir(), "hub-hunt-"));
  const it = await stageHub(cluster, {
    hub: { tick_seconds: 1, ...(options.hub ?? {}) },
    machines: [{ id: HERE, os: HERE_OS }],
    people: [{ id: "p1", tree: join(dir, "p1") }],
    agents: [{ id: TRIAGE, person: "p1", preset: "daily", chat: AUDIT_CHAT, door: "door-fake", runner: "runner-test", role: "triage" }],
    run: [DOOR_ENTRY, RUNNER_ENTRY, watch],
  });
  const registry = loadRegistry(it.registryFile, { machine: HERE });
  const entry = listRunEntries(registry).find((one) => one.id === ENTRY)!;
  expect(entry).toBeDefined();
  const specsDir = specsDirOf(registry, entry);
  mkdirSync(specsDir, { recursive: true });
  for (const spec of options.specs ?? [DDR5_SPEC, GPU_SPEC, MONITOR_SPEC]) writeFileSync(join(specsDir, `${spec.id}.json`), JSON.stringify(spec, null, 2));
  return { it, registry, entry, specsDir, stop: async () => { await it.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

const T0 = new Date("2026-09-26T07:00:00.000Z");
const later = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

async function tick(staged: Staged, at: Date, pages: Record<string, string | number> = ALL_PAGES) {
  const site = wire(pages);
  const result = await runHuntWatch(staged.entry, staged.registry, { fetch: site.fetch, now: () => at, pauseMs: 0 });
  return { ...result, asked: site.asked };
}

const stateRows = (staged: Staged) => staged.it.read.sheet(`watch:${ENTRY}`);
const pendingRows = (staged: Staged) => staged.it.read.sheet(`watch-jobs:${ENTRY}`);
const stampOf = async (staged: Staged) => (await staged.it.read.sheet("job_success")).find((row) => row.id === ENTRY) ?? null;
const auditFile = (staged: Staged, day: string) => join(auditDirOf(staged.registry, staged.entry), `${day}.jsonl`);
const auditRows = (staged: Staged, day: string) =>
  existsSync(auditFile(staged, day)) ? readFileSync(auditFile(staged, day), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
const noticesOf = async (staged: Staged) =>
  (await staged.it.read.sql("select agent, notice_key, body, route from outbox where kind = 'notice' order by id")) as { agent: string; notice_key: string; body: string; route: Record<string, string> }[];

/** What the runner writes when the master's turn settles: the report row and the answered stamp. */
async function settle(staged: Staged, jobId: string, report: string) {
  await staged.it.read.sql("select hub_report($1, $2)", [jobId, report]);
  await staged.it.read.sql("insert into ledger_event (stream, subject, kind, actor) values ('inbound', $1, 'answered', 'runner')", [jobId]);
}

test(
  "the first tick lands the state, the audit file and notice, one notify notice and one admissible job for the triage master; the next tick with nothing new posts nothing and still writes the file",
  async () => {
    const staged = await stage();
    try {
      const first = await tick(staged, T0);
      // Three requests, one per spec, page one of each query.
      expect(first.asked.map((one) => one.url)).toEqual([URLS.ddr5, URLS.gpu, URLS.monitor]);
      expect(first.counts).toMatchObject({ specs: 3, refused: 0, failed: 0, listings: 11, notified: 1, triage: 4, dropped: 6, seen: 0, verdicts: 0, removed: 0, partial: false });
      expect(first.posted).toEqual({ audit: true, notices: 1 });
      expect(first.job).toBe(`watch:${ENTRY}:${T0.toISOString()}`);

      // The state: one row per listing, the announced ones marked at their price.
      const rows = await stateRows(staged);
      expect(rows.map((row) => row.id).sort()).toEqual(["410001", "410002", "410003", "410004", "410005", "410006", "620001", "620002", "730001", "730002", "730003"]);
      const at = T0.toISOString();
      expect(rows.find((row) => row.id === "410001")!.data).toEqual({
        spec: "de__ddr5", first_seen: at, last_seen: at, price: 180, announced_price: 180, announced_at: at, outcome: "triage", reason: "no-target (price_at_or_under by +30)",
      });
      expect(rows.find((row) => row.id === "620001")!.data).toMatchObject({ spec: "de__gpu", price: 90, announced_price: 90, announced_at: at, outcome: "notify", reason: "hit" });
      expect(rows.find((row) => row.id === "410002")!.data).toMatchObject({ price: 310, announced_price: null, announced_at: null, outcome: "drop", reason: "max_price by +50 (max 260)" });
      expect(rows.find((row) => row.id === "410003")!.data).toMatchObject({ outcome: "drop", reason: "wanted_ad (wanted ad)" });
      expect(rows.find((row) => row.id === "410004")!.data).toMatchObject({ outcome: "drop", reason: "exclude (laptop)" });
      expect(rows.find((row) => row.id === "410005")!.data).toMatchObject({ outcome: "drop", reason: "rental_ad (rental ad)" });
      expect(rows.find((row) => row.id === "410006")!.data).toMatchObject({ outcome: "drop", reason: "max_price by +950.5 (max 260)" });
      expect(rows.find((row) => row.id === "620002")!.data).toMatchObject({ outcome: "drop", reason: "price_at_or_under by +300 (price_at_or_under 100)" });
      expect(rows.find((row) => row.id === "730001")!.data).toMatchObject({ outcome: "triage", reason: "no-target", announced_price: 120 });

      // The audit file: one JSON row per listing, the same fields as the chat line.
      const filed = auditRows(staged, "2026-09-26");
      expect(filed).toHaveLength(11);
      expect(filed.find((row) => row.id === "620001")).toEqual({
        at, entry: ENTRY, source: "kleinanzeigen", watch: "de__gpu", id: "620001", title: "Wolkenkarte GPU 8GB", price: 90, currency: "EUR",
        url: "https://www.kleinanzeigen.de/s-anzeige/wolkenkarte-8gb/620001-225-1000", outcome: "notify", reason: "hit", reached: "notified p1-lair",
      });
      expect(filed.find((row) => row.id === "410001")).toMatchObject({ outcome: "triage", reason: "no-target (price_at_or_under by +30)", reached: `triage ${TRIAGE}` });
      expect(filed.find((row) => row.id === "410004")).toMatchObject({ outcome: "drop", reason: "exclude (laptop)", reached: "nothing" });

      // The notices: the audit notice on the master's chat and the notify on
      // the owner's, both pinned as a watcher's.
      const notices = await noticesOf(staged);
      expect(notices.map((one) => one.notice_key)).toEqual([`watch-notify:${ENTRY}:620001:90`, `watch-audit:${ENTRY}:${at}`]);
      expect(notices[0]).toMatchObject({ agent: "p1-lair", body: "de\\_\\_gpu: Wolkenkarte GPU 8GB - 90 EUR <https://www.kleinanzeigen.de/s-anzeige/wolkenkarte-8gb/620001-225-1000>", route: { door: "door-fake", chat: CHAT, origin: "watcher" } });
      expect(notices[1]).toMatchObject({ agent: TRIAGE, route: { door: "door-fake", chat: AUDIT_CHAT, origin: "watcher" } });
      const audit = notices[1].body.split("\n");
      expect(audit[0]).toBe("kleinanzeigen 2026-09-26 07:00: 11 listings, 1 notified, 4 to triage, 6 dropped");
      expect(audit).toHaveLength(12);
      expect(audit).toContain("07:00 · de\\_\\_gpu · Wolkenkarte GPU 8GB (90 EUR) · notify · hit · notified p1-lair");
      expect(audit).toContain("07:00 · de\\_\\_ddr5 · Meridian Vale DDR5 6000 32GB 2x16 (180 EUR) · triage · no-target (price\\_at\\_or\\_under by +30) · triage p1-triage");
      expect(audit).toContain("07:00 · de\\_\\_ddr5 · Gaming Laptop 32GB DDR5 6000 (140 EUR) · drop · exclude (laptop) · nothing");
      expect(audit).toContain("07:00 · de\\_\\_ddr5 · Suche DDR5 6000 32GB Kit (no price) · drop · wanted\\_ad (wanted ad) · nothing");

      // ONE job row for the master, in the door's own shape, admissible.
      const jobs = (await staged.it.read.inbound()).filter((row) => row.kind === "job");
      expect(jobs).toHaveLength(1);
      const job = jobs[0] as unknown as { id: string; person: string; agent: string; body: string; kind: string; log_ready: boolean; state: string; source: Record<string, unknown> };
      expect(job).toMatchObject({ id: first.job, person: "p1", agent: TRIAGE, kind: "job", log_ready: false, state: "received" });
      expect(admitJob({ body: job.body, source: job.source as never })).toBeNull();
      expect(job.source).toMatchObject({
        log_id: first.job, at, door: "door-fake", chat: AUDIT_CHAT, from: "p1",
        dispatch: { dispatcher: TRIAGE, target: TRIAGE, approved: { by: `watch:${ENTRY}`, at, digest: taskDigest(job.body), source: "watch" }, return: { agent: TRIAGE, door: "door-fake", chat: AUDIT_CHAT } },
      });
      // The body: every triage listing with the owner's own words, then the fixed instruction and nothing else.
      expect(job.body.endsWith(TRIAGE_INSTRUCTION)).toBe(true);
      for (const id of ["410001", "730001", "730002", "730003"]) expect(job.body).toContain(`id: ${id}\n`);
      expect(job.body).not.toContain("id: 620001");
      expect(job.body).toContain("owner says: a 2x16 kit only, not 1x32");
      expect(job.body).toContain("owner's note: the build wants 32GB at 6000");
      expect(job.body).toContain("owner says: 27 inch or bigger");
      expect(job.body).toContain("why here: no-target (price_at_or_under by +30)");
      expect((await pendingRows(staged)).map((row) => row.id)).toEqual([first.job!]);
      const control = await staged.it.read.ledger({ stream: "control", subject: first.job! });
      expect(control.map((row) => row.kind)).toEqual(["dispatch.requested"]);
      expect(control[0].actor).toBe("hub");

      // The stamp and the diary line, counts only, in the same transaction.
      expect((await stampOf(staged))?.data).toMatchObject({ at, machine: HERE });
      const swept = await staged.it.read.ledger({ stream: "machine", subject: ENTRY, kind: "watch.swept" });
      expect(swept).toHaveLength(1);
      expect(swept[0].detail).toMatchObject({ watch: ENTRY, source: "kleinanzeigen", listings: 11, notified: 1, triage: 4, dropped: 6, job: true, posted: true, notices: 1 });
      expect(JSON.stringify(swept[0].detail)).not.toContain("Wolkenkarte");

      // Half an hour on, the same pages, the job still open: every announced
      // or declined listing is `seen` (the tripwire's predicate drop counts as
      // declined), every hard-rule drop is a repeat, the file gets the rows,
      // the chat gets nothing, and there is no second job.
      const again = await tick(staged, later(30));
      expect(again.counts).toMatchObject({ listings: 11, seen: 6, dropped: 11, notified: 0, triage: 0, verdicts: 0 });
      expect(again.posted).toEqual({ audit: false, notices: 0 });
      expect(again.job).toBeNull();
      expect(auditRows(staged, "2026-09-26")).toHaveLength(22);
      const second = auditRows(staged, "2026-09-26").filter((row) => row.at === later(30).toISOString());
      expect(second.map((row) => row.reason).filter((one) => one.startsWith("seen"))).toHaveLength(6);
      expect(second.filter((row) => row.repeat === true).map((row) => row.id).sort()).toEqual(["410002", "410003", "410004", "410005", "410006"]);
      expect((await noticesOf(staged)).length).toBe(2);
      expect((await pendingRows(staged)).map((row) => row.id)).toEqual([first.job!]);
      expect((await stateRows(staged)).find((row) => row.id === "410001")!.data).toMatchObject({ last_seen: later(30).toISOString(), announced_price: 180, outcome: "drop", reason: "seen by 0 (announced before)" });
      expect((await stampOf(staged))?.data).toMatchObject({ at: later(30).toISOString() });
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "a settled report becomes verdicts: a tell reaches the owner, an ignore and a draft are stored and audited, an unreadable line is a verdict too, the job leaves the list, and a price fall re-enters",
  async () => {
    const staged = await stage();
    try {
      const first = await tick(staged, T0);
      await settle(staged, first.job!, [
        "410001 | tell | a clean 2x16 kit well under the going rate",
        "730001 | ignore | 27 inch at 120 is the ordinary price",
        "730002 | draft | Hallo, ist der Monitor noch zu haben und wann kann ich ihn abholen?",
        "999999 | tell | an id that was never in the batch",
        "this line is not a verdict at all",
      ].join("\n"));

      const second = await tick(staged, later(30));
      expect(second.counts).toMatchObject({ verdicts: 4, told: 1, listings: 11, seen: 6, notified: 0, triage: 0 });
      expect(second.posted).toEqual({ audit: true, notices: 1 });
      expect(second.job).toBeNull();
      expect(await pendingRows(staged)).toEqual([]);

      // The rows: the verdict written into each listing's row, and the two
      // declined ones re-enter only on a price change.
      const rows = await stateRows(staged);
      expect(rows.find((row) => row.id === "410001")!.data).toMatchObject({ verdict: "tell", announced_price: 180, outcome: "drop", reason: "seen by 0 (announced before)" });
      expect(rows.find((row) => row.id === "730001")!.data).toMatchObject({ verdict: "ignore", announced_price: null, announced_at: null, reason: "seen (declined before, unchanged)" });
      expect(rows.find((row) => row.id === "730002")!.data).toMatchObject({ verdict: "draft", draft: "Hallo, ist der Monitor noch zu haben und wann kann ich ihn abholen?", announced_price: 200 });
      expect(rows.find((row) => row.id === "730003")!.data).toMatchObject({ verdict: "unreadable", announced_price: null, announced_at: null });

      // The tell: one notice on the owner's chat, marked as a watcher's. The
      // draft and the ignore post nothing anywhere.
      const notices = await noticesOf(staged);
      const tell = notices.find((one) => one.notice_key === `watch-tell:${ENTRY}:410001`)!;
      expect(tell).toMatchObject({ agent: "p1-lair", route: { door: "door-fake", chat: CHAT, origin: "watcher" } });
      expect(tell.body).toBe("de\\_\\_ddr5: a clean 2x16 kit well under the going rate - Meridian Vale DDR5 6000 32GB 2x16 180 EUR <https://www.kleinanzeigen.de/s-anzeige/meridian-vale-ddr5-6000-32gb/410001-225-1000>");
      expect(notices.filter((one) => one.body.includes("Hallo, ist der Monitor"))).toHaveLength(1);
      expect(notices.find((one) => one.body.includes("Hallo, ist der Monitor"))!.agent).toBe(TRIAGE);

      // The audit: one verdict row per listing of the batch, the draft printed
      // in it, and the chat line says what reached the person.
      const filed = auditRows(staged, "2026-09-26").filter((row) => row.outcome === "verdict");
      expect(filed.map((row) => [row.id, row.verdict, row.reached])).toEqual([
        ["410001", "tell", "told p1-lair"], ["730001", "ignore", "nothing"], ["730002", "draft", "nothing"], ["730003", "unreadable", "nothing"],
      ]);
      expect(filed[2]).toMatchObject({ reason: "draft", draft: "Hallo, ist der Monitor noch zu haben und wann kann ich ihn abholen?" });
      expect(filed[3].reason).toBe("the report carries no line for this id");
      const audit = notices.find((one) => one.notice_key === `watch-audit:${ENTRY}:${later(30).toISOString()}`)!.body.split("\n");
      expect(audit[0]).toBe("kleinanzeigen 2026-09-26 07:30: 11 listings, 0 notified, 0 to triage, 11 dropped, 4 verdicts");
      expect(audit).toContain("07:30 · de\\_\\_ddr5 · Meridian Vale DDR5 6000 32GB 2x16 (180 EUR) · verdict tell · a clean 2x16 kit well under the going rate · told p1-lair");
      expect(audit).toContain("07:30 · de\\_\\_monitor · Klarblick Monitor 32 Zoll (200 EUR) · verdict draft · draft · draft: Hallo, ist der Monitor noch zu haben und wann kann ich ihn abholen? · nothing");
      // The seen drops are in the file and not in the chat.
      expect(audit.filter((line) => line.includes("· drop ·"))).toHaveLength(0);
      expect(audit).toHaveLength(5);

      // A price fall: the told kit falls from 180 to 150, which crosses the
      // spec's line, so it is a notify carrying the old price; the ignored
      // monitor moves to 110, which re-enters a declined listing as a triage
      // `price changed` and a new job; the draft one stays seen.
      const third = await tick(staged, later(60), {
        [URLS.ddr5]: fixture("kleinanzeigen", "search-classic.html").replace(">180 €<", ">150 €<"),
        [URLS.gpu]: GPU_PAGE,
        [URLS.monitor]: monitorPage([110, 200, 80]),
      });
      expect(third.counts).toMatchObject({ notified: 1, triage: 1, seen: 4, verdicts: 0 });
      expect(third.job).toBe(`watch:${ENTRY}:${later(60).toISOString()}`);
      const fell = (await noticesOf(staged)).find((one) => one.notice_key === `watch-notify:${ENTRY}:410001:150`)!;
      expect(fell.body).toBe("de\\_\\_ddr5: Meridian Vale DDR5 6000 32GB 2x16 - 150 EUR (was 180) <https://www.kleinanzeigen.de/s-anzeige/meridian-vale-ddr5-6000-32gb/410001-225-1000>");
      expect((await stateRows(staged)).find((row) => row.id === "410001")!.data).toMatchObject({ announced_price: 150, outcome: "notify", reason: "price fell" });
      const moved = auditRows(staged, "2026-09-26").find((row) => row.id === "730001" && row.at === later(60).toISOString())!;
      expect(moved).toMatchObject({ outcome: "triage", reason: "price changed", old_price: 120, price: 110, reached: `triage ${TRIAGE}` });
      const jobs = (await staged.it.read.inbound()).filter((row) => row.kind === "job");
      expect(jobs).toHaveLength(2);
      expect(jobs[1].body).toContain("id: 730001\n");
      expect(jobs[1].body).toContain("price: 110 EUR (was 120)");
      expect(jobs[1].body).not.toContain("id: 410001");
      expect((await pendingRows(staged)).map((row) => row.id)).toEqual([third.job!]);

      // A job the runner refused is audited once as failed and leaves the list.
      await staged.it.read.sql("insert into ledger_event (stream, subject, kind, actor, detail) values ('control', $1, 'dispatch.refused', 'runner', $2::jsonb)", [third.job, { cause: "not approved" }]);
      await staged.it.read.sql("insert into ledger_event (stream, subject, kind, actor) values ('inbound', $1, 'answered', 'runner')", [third.job]);
      const fourth = await tick(staged, later(90), {
        [URLS.ddr5]: fixture("kleinanzeigen", "search-classic.html").replace(">180 €<", ">150 €<"),
        [URLS.gpu]: GPU_PAGE,
        [URLS.monitor]: monitorPage([110, 200, 80]),
      });
      expect(fourth.counts).toMatchObject({ verdicts: 0, seen: 6 });
      expect(await pendingRows(staged)).toEqual([]);
      const failedRow = auditRows(staged, "2026-09-26").find((row) => row.outcome === "triage failed")!;
      expect(failedRow).toMatchObject({ id: third.job, reason: "refused: not approved", title: "1 listing(s)" });
      expect(fourth.posted.audit).toBe(true);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "every spec dark lands nothing and stamps nothing; one spec dark lands the rest as a partial sweep that removes nothing; a complete sweep removes a listing absent for two weeks",
  async () => {
    const staged = await stage({ triage: false });
    try {
      await tick(staged, T0);
      const before = { rows: await stateRows(staged), stamp: await stampOf(staged), notices: (await noticesOf(staged)).length };
      // With no triage master, a triage hit is a look line to the owner, zero model turns.
      expect((await noticesOf(staged)).map((one) => one.notice_key).filter((key) => key.startsWith("watch-look:"))).toEqual([
        `watch-look:${ENTRY}:410001:180`, `watch-look:${ENTRY}:730001:120`, `watch-look:${ENTRY}:730002:200`, `watch-look:${ENTRY}:730003:80`,
      ]);
      expect((await noticesOf(staged)).find((one) => one.notice_key === `watch-look:${ENTRY}:410001:180`)!.body)
        .toBe("de\\_\\_ddr5: look - Meridian Vale DDR5 6000 32GB 2x16 - 180 EUR <https://www.kleinanzeigen.de/s-anzeige/meridian-vale-ddr5-6000-32gb/410001-225-1000> (no-target (price\\_at\\_or\\_under by +30))");
      expect((await staged.it.read.inbound()).filter((row) => row.kind === "job")).toEqual([]);

      // Every page walled: the tick refuses, and nothing moved.
      let caught: unknown;
      try {
        await tick(staged, later(30), { [URLS.ddr5]: 503, [URLS.gpu]: 503, [URLS.monitor]: 503 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WatchRefused);
      expect((caught as WatchRefused).code).toBe("fetch");
      expect((caught as WatchRefused).reason).toBe("operation failed");
      expect(await stateRows(staged)).toEqual(before.rows);
      expect(await stampOf(staged)).toEqual(before.stamp);
      expect((await noticesOf(staged)).length).toBe(before.notices);
      expect(auditRows(staged, "2026-09-26")).toHaveLength(11);
      const failed = await staged.it.read.ledger({ stream: "machine", subject: ENTRY, kind: "failed" });
      expect(failed.map((row) => (row.detail as { code: string }).code)).toEqual(["watch-fetch"]);

      // A wall on one page and ad cards that parse to none on another are
      // the same refusal, and so is zero listings on a board the sheet holds.
      for (const [pages, code] of [
        [{ ...ALL_PAGES, [URLS.ddr5]: fixture("kleinanzeigen", "search-wall.html"), [URLS.gpu]: 500, [URLS.monitor]: 500 }, "watch-parse"],
        [{ ...ALL_PAGES, [URLS.ddr5]: fixture("kleinanzeigen", "search-unknown-markup.html"), [URLS.gpu]: 500, [URLS.monitor]: 500 }, "watch-empty"],
        [{ ...ALL_PAGES, [URLS.ddr5]: fixture("kleinanzeigen", "search-empty.html"), [URLS.gpu]: 500, [URLS.monitor]: 500 }, "watch-empty"],
      ] as [Record<string, string | number>, string][]) {
        let refused: unknown;
        try { await tick(staged, later(30), pages); } catch (error) { refused = error; }
        expect(refused, code).toBeInstanceOf(WatchRefused);
        expect(`watch-${(refused as WatchRefused).code}`).toBe(code);
      }
      expect(await stampOf(staged)).toEqual(before.stamp);

      // One spec dark of three: the other two land, the failure is audited by
      // name, the sweep is partial, and a row twenty days stale is kept.
      await staged.it.read.sql(
        "insert into state_row (sheet, id, data) values ($1, 'stale-1', $2::jsonb)",
        [`watch:${ENTRY}`, { spec: "de__gpu", first_seen: "2026-09-01T00:00:00.000Z", last_seen: "2026-09-06T00:00:00.000Z", price: 1, announced_price: null, announced_at: null, outcome: "drop", reason: "seen" }],
      );
      const partial = await tick(staged, later(30), { ...ALL_PAGES, [URLS.gpu]: 503 });
      expect(partial.counts).toMatchObject({ specs: 3, failed: 1, partial: true, listings: 9, removed: 0 });
      expect((await stampOf(staged))?.data).toMatchObject({ at: later(30).toISOString() });
      expect((await stateRows(staged)).some((row) => row.id === "stale-1")).toBe(true);
      const said = auditRows(staged, "2026-09-26").find((row) => row.outcome === "spec failed")!;
      expect(said).toMatchObject({ watch: "de__gpu", reason: "operation failed: www.kleinanzeigen.de answered 503", reached: "nothing" });
      const audit = (await noticesOf(staged)).find((one) => one.notice_key === `watch-audit:${ENTRY}:${later(30).toISOString()}`)!;
      expect(audit.body.split("\n")[0]).toBe("kleinanzeigen 2026-09-26 07:30: 9 listings, 0 notified, 0 to triage, 9 dropped, 1 spec failed");
      expect(audit.body).toContain("· de\\_\\_gpu · de\\_\\_gpu · spec failed · operation failed: www.kleinanzeigen.de answered 503 · nothing");
      const swept = await staged.it.read.ledger({ stream: "machine", subject: ENTRY, kind: "watch.swept" });
      expect(swept[swept.length - 1].detail).toMatchObject({ partial: true, failed: 1, removed: 0 });

      // A complete sweep: the stale row goes, and the ones seen today stay.
      const whole = await tick(staged, later(60));
      expect(whole.counts).toMatchObject({ partial: false, removed: 1 });
      expect((await stateRows(staged)).some((row) => row.id === "stale-1")).toBe(false);
      expect((await stateRows(staged)).length).toBe(11);
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "a refused spec never runs and is audited every tick, a paused one is skipped in silence, the lane filters, and a tick with no specs posts nothing and writes no file",
  async () => {
    const staged = await stage({ specs: [] });
    try {
      const quiet = await tick(staged, T0, {});
      expect(quiet.counts).toMatchObject({ specs: 0, listings: 0 });
      expect(quiet.posted).toEqual({ audit: false, notices: 0 });
      expect(quiet.asked).toEqual([]);
      expect(existsSync(auditFile(staged, "2026-09-26"))).toBe(false);
      expect((await stampOf(staged))?.data).toMatchObject({ at: T0.toISOString() });

      writeFileSync(join(staged.specsDir, "de__gpu.json"), JSON.stringify(GPU_SPEC));
      writeFileSync(join(staged.specsDir, "de__broken.json"), JSON.stringify({ ...DDR5_SPEC, id: "de__broken", hard: { max_price: "260", colour: "red" }, owner: "p2-lair" }));
      writeFileSync(join(staged.specsDir, "de__paused.json"), JSON.stringify({ ...MONITOR_SPEC, id: "de__paused", paused: true }));
      const result = await tick(staged, later(30));
      expect(result.asked.map((one) => one.url)).toEqual([URLS.gpu]);
      expect(result.counts).toMatchObject({ specs: 1, refused: 1, listings: 2, notified: 1 });
      const refused = auditRows(staged, "2026-09-26").find((row) => row.outcome === "spec refused")!;
      expect(refused).toMatchObject({
        watch: "de__broken.json", id: "de__broken.json",
        reason: 'owner "p2-lair" is not an agent of p1 with a door and a chat; hard.max_price must be a finite number; hard.colour is not a rule: the closed set is max_price, min_price, radius_km, exclude, seller_kind, min_temperature, wanted_ad, rental_ad. A constraint that is not one of these is judgment, and judgment is a soft rule',
        reached: "nothing",
      });
      const audit = (await noticesOf(staged)).find((one) => one.notice_key === `watch-audit:${ENTRY}:${later(30).toISOString()}`)!.body.split("\n");
      expect(audit[0]).toBe("kleinanzeigen 2026-09-26 07:30: 2 listings, 1 notified, 0 to triage, 1 dropped, 1 spec refused");
      expect(audit.some((line) => line.startsWith("07:30 · de\\_\\_broken.json · de\\_\\_broken.json · spec refused · owner \"p2-lair\" is not an agent"))).toBe(true);
      // The same again next tick, once per tick, while the file is wrong.
      const again = await tick(staged, later(60));
      expect(again.counts).toMatchObject({ refused: 1, seen: 2 });
      expect(again.posted.audit).toBe(true);
      expect(auditRows(staged, "2026-09-26").filter((row) => row.outcome === "spec refused")).toHaveLength(2);

      // The lane: a tripwire entry runs the tripwire spec alone, and `runWatch` routes by source.
      const laned = await stage({ lane: "digest", specs: [DDR5_SPEC, GPU_SPEC] });
      try {
        const site = wire(ALL_PAGES);
        const result = await runWatch(laned.entry, laned.registry, { fetch: site.fetch, now: () => T0, pauseMs: 0 });
        expect(site.asked.map((one) => one.url)).toEqual([URLS.ddr5]);
        expect(result.counts).toMatchObject({ specs: 1, listings: 6 });
      } finally {
        await laned.stop();
      }
    } finally {
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "the door delivers the notify and the audit lines into their chats, both marked as a watcher's, and neither tail a session is fed carries a word of them",
  async () => {
    const staged = await stage({ triage: false, specs: [GPU_SPEC] });
    const { it, registry } = staged;
    let door: { stop(): Promise<void> } | null = null;
    let store: Awaited<ReturnType<typeof superStore>> | null = null;
    try {
      const result = await tick(staged, T0);
      expect(result.posted).toEqual({ audit: true, notices: 1 });
      const notices = await noticesOf(staged);
      const notify = notices.find((one) => one.notice_key.startsWith("watch-notify:"))!;
      const audit = notices.find((one) => one.notice_key.startsWith("watch-audit:"))!;
      expect(notify.route).toEqual({ door: "door-fake", chat: CHAT, origin: "watcher" });
      expect(audit.route).toEqual({ door: "door-fake", chat: AUDIT_CHAT, origin: "watcher" });

      door = await runDoor({ door: "door-fake", registryFile: it.registryFile, platform: it.fake.platform });
      await until("the door posted both", async () => [notify.body, audit.body].every((text) => it.fake.posts().some((post) => post.text === text)), 30_000);
      await until("the door wrote both into the logs", async () =>
        chatLogLines(it.stateDir, "p1", "p1-lair").some((line) => line.text === notify.body) &&
        chatLogLines(it.stateDir, "p1", TRIAGE).some((line) => line.text === audit.body), 30_000);
      const owned = chatLogLines(it.stateDir, "p1", "p1-lair").find((line) => line.text === notify.body) as { origin?: string; from: string };
      const audited = chatLogLines(it.stateDir, "p1", TRIAGE).find((line) => line.text === audit.body) as { origin?: string; from: string };
      expect(owned.origin).toBe("watcher");
      expect(audited.origin).toBe("watcher");
      expect(owned.from).toBe("door-fake");

      store = await superStore(cluster, it.db);
      const now = new Date();
      for (const agent of ["p1-lair", TRIAGE]) {
        const where = { person: "p1", agent, now, hours: 24, tokens: 8000 };
        for (const tail of [await readTail({ stateDir: it.stateDir, ...where }), await deriveTail(store, { registry, ...where })]) {
          expect(tail).not.toContain("Wolkenkarte");
          expect(tail).not.toContain("kleinanzeigen 2026");
        }
      }
    } finally {
      await door?.stop();
      await store?.close();
      await staged.stop();
    }
  },
  SLOW,
);

test(
  "check reports a refused spec file with its problems as the fix, and a triage job the master has not answered past the interval plus the grace",
  async () => {
    const staged = await stage({ specs: [DDR5_SPEC], hub: { job_grace_seconds: 60 } });
    let store: Awaited<ReturnType<typeof superStore>> | null = null;
    try {
      store = await superStore(cluster, staged.it.db);
      const check = async (now: Date) => (await runCheck({
        machine: HERE, registryFile: staged.it.registryFile, store: store!, os: null, kernel: null, credentials: fakeProber({}), now,
      })) as Finding[];
      const about = (found: Finding[]) => found.filter((one) => one.kind.startsWith("watch-"));

      // The controls: a sound folder and no pending job is no finding.
      expect(about(await check(T0))).toEqual([]);

      writeFileSync(join(staged.specsDir, "de__broken.json"), JSON.stringify({ ...GPU_SPEC, id: "de__broken", lane: "tripwire", notify: undefined, hard: { colour: "red" } }));
      const refused = about(await check(T0));
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        id: `${HERE}/watch-spec-refused:${ENTRY}/de__broken.json`, kind: "watch-spec-refused", subject: `${ENTRY}/de__broken.json`, machine: HERE,
        fix: "hard.colour is not a rule: the closed set is max_price, min_price, radius_km, exclude, seller_kind, min_temperature, wanted_ad, rental_ad. A constraint that is not one of these is judgment, and judgment is a soft rule; a tripwire spec needs a notify block: the tripwire lane may only notify, and with nothing to notify on it could only ever triage",
      });
      expect(refused[0].says).toContain("de__broken.json");
      expect(refused[0].says).toContain("(and 1 more)");
      rmSync(join(staged.specsDir, "de__broken.json"));
      expect(about(await check(T0))).toEqual([]);

      // A job handed to the master at T0: fine at the interval plus the
      // grace, overdue one second past it, and cleared once the verdict is read.
      const first = await tick(staged, T0);
      expect(first.job).not.toBeNull();
      expect(about(await check(later(30)))).toEqual([]);
      expect(about(await check(new Date(T0.getTime() + 31 * 60_000)))).toEqual([]);
      const overdue = about(await check(new Date(T0.getTime() + 31 * 60_000 + 1000)));
      expect(overdue).toHaveLength(1);
      expect(overdue[0]).toMatchObject({ kind: "watch-triage-overdue", subject: first.job!, machine: HERE, fix: `read the runner log for ${TRIAGE}` });
      expect(overdue[0].says).toContain(`${ENTRY} handed ${first.job} to ${TRIAGE}`);
      expect(overdue[0].says).toContain("past its 1800 second interval plus the 60 second grace");
      await settle(staged, first.job!, "410001 | ignore | ordinary price");
      await tick(staged, later(60));
      expect(about(await check(new Date(T0.getTime() + 90 * 60_000)))).toEqual([]);
    } finally {
      await store?.close();
      await staged.stop();
    }
  },
  SLOW,
);
