import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { syncFixture, syncChild, observeGit, commitChange, type SyncFixture } from "./helpers/rollout-sync.ts";
import { fixtureGit } from "./helpers/rollout-git.ts";
import { superStore } from "./helpers/hub-fixture.ts";
import { syncLockKey } from "../src/sync/run.ts";
let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });
const state = async (f: SyncFixture) => (await f.read.sheet("sync")).find(row => row.id === f.id)!;
const result = async (f: SyncFixture) => (await state(f)).data.repositories as { id: string; status: string; code?: string; notified_at?: string; failing_since?: string }[];
const mutations = (git: ReturnType<typeof observeGit>, path: string) => git.events().filter(event => event.cwd === realpathSync(path) && event.phase === "start" && event.args.some(arg => ["add", "commit", "fetch", "rebase", "push", "update-ref"].includes(arg)));

for (const race of ["branch-before-add", "head-before-commit", "head-before-rebase", "operation-before-add", "branch-before-push"] as const) {
  test(`sync detects unmanaged ${race}, stops before the next mutation and preserves work`, async () => {
    const f = await syncFixture(cluster);
    try {
      const r = f.repos[0], git = observeGit(f.root);
      writeFileSync(join(r.path, "pending.txt"), "unmanaged writer evidence\n");
      const oldRemote = fixtureGit(f.root, "--git-dir", r.remote, "rev-parse", "main");
      const cases = {
        "branch-before-add": { verb: "status", git: ["switch", "-c", "writer-branch"] },
        "head-before-commit": { verb: "diff", arg: "--cached", commit: true },
        "head-before-rebase": { verb: "fetch", git: ["commit", "--allow-empty", "-m", "unmanaged writer"] },
        "operation-before-add": { verb: "status", write: [".git/MERGE_HEAD", oldRemote + "\n"] as [string, string] },
        "branch-before-push": { verb: "rebase", git: ["switch", "-c", "writer-branch"] },
      };
      git.control({ path: realpathSync(r.path), after: cases[race] });
      expect((await syncChild(f, git.env)).code).toBe(1);
      expect((await result(f))[0]).toMatchObject({ status: "failed", code: race === "operation-before-add" ? "operation" : "changed" });
      const stoppedBefore = { "branch-before-add": "add", "head-before-commit": "commit", "head-before-rebase": "rebase", "operation-before-add": "add", "branch-before-push": "push" }[race];
      expect(mutations(git, r.path).some(event => event.args.includes(stoppedBefore))).toBe(false);
      expect(fixtureGit(f.root, "--git-dir", r.remote, "rev-parse", "main")).toBe(oldRemote);
      expect(readFileSync(join(r.path, "pending.txt"), "utf8")).toBe("unmanaged writer evidence\n");
      expect(fixtureGit(r.path, "stash", "list")).toBe("");
      if (race.startsWith("branch-")) expect(fixtureGit(r.path, "symbolic-ref", "--short", "HEAD")).toBe("writer-branch");
      if (race === "head-before-commit") expect(fixtureGit(r.path, "log", "-1", "--format=%s")).toBe("second writer");
      if (race === "head-before-rebase") expect(fixtureGit(r.path, "log", "-1", "--format=%s")).toBe("unmanaged writer");
      if (race === "operation-before-add") expect(readFileSync(join(r.path, ".git/MERGE_HEAD"), "utf8")).toBe(oldRemote + "\n");
    } finally { await f.stop(); }
  }, 90_000);
}

test("sync integrates the captured fetched commit even when an unrelated fetch overwrites FETCH_HEAD", async () => {
  const f = await syncFixture(cluster);
  try {
    const r = f.repos[0], git = observeGit(f.root);
    const old = fixtureGit(r.path, "rev-parse", "HEAD");
    commitChange(r.path, "local.txt", "local retained\n");
    const fetched = commitChange(r.peer, "peer.txt", "remote retained\n");
    fixtureGit(r.peer, "push", "origin", "main");
    git.control({ path: realpathSync(r.path), after: { verb: "fetch", write: [".git/FETCH_HEAD", `${old}\t\tunrelated fetch\n`] } });
    const done = await syncChild(f, git.env);
    expect(done.code, done.err).toBe(0);
    const rebase = mutations(git, r.path).find(event => event.args.includes("rebase"))!;
    expect(rebase.args.at(-1)).toBe(fetched);
    expect(rebase.args).not.toContain("FETCH_HEAD");
    expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "main:local.txt")).toBe("local retained");
    expect(fixtureGit(f.root, "--git-dir", r.remote, "show", "main:peer.txt")).toBe("remote retained");
  } finally { await f.stop(); }
}, 90_000);

test("a pre-existing stopped rebase leaves HEAD, refs, index, conflict bytes and stash untouched", async () => {
  const f = await syncFixture(cluster);
  try {
    const r = f.repos[0], git = observeGit(f.root);
    writeFileSync(join(r.path, "saved.txt"), "owner saved work\n");
    fixtureGit(r.path, "stash", "push", "--include-untracked", "-m", "owner evidence");
    commitChange(r.path, "base.txt", "local conflict\n");
    commitChange(r.peer, "base.txt", "remote conflict\n");
    fixtureGit(r.peer, "push", "origin", "main");
    fixtureGit(r.path, "fetch", "origin");
    expect(() => fixtureGit(r.path, "rebase", "origin/main")).toThrow();
    const before = { head: fixtureGit(r.path, "rev-parse", "HEAD"), refs: fixtureGit(r.path, "show-ref"), index: readFileSync(join(r.path, ".git/index")), conflict: readFileSync(join(r.path, "base.txt")), stash: fixtureGit(r.path, "stash", "list"), original: readFileSync(join(r.path, ".git/rebase-merge/orig-head")) };
    expect((await syncChild(f, git.env)).code).toBe(1);
    expect((await result(f))[0].code).toBe("operation");
    expect(mutations(git, r.path)).toEqual([]);
    expect(fixtureGit(r.path, "rev-parse", "HEAD")).toBe(before.head);
    expect(fixtureGit(r.path, "show-ref")).toBe(before.refs);
    expect(readFileSync(join(r.path, ".git/index"))).toEqual(before.index);
    expect(readFileSync(join(r.path, "base.txt"))).toEqual(before.conflict);
    expect(fixtureGit(r.path, "stash", "list")).toBe(before.stash);
    expect(readFileSync(join(r.path, ".git/rebase-merge/orig-head"))).toEqual(before.original);
  } finally { await f.stop(); }
}, 90_000);

test("entry and movement-compatible repository ownership last through result publication; a competing tick writes nothing", async () => {
  const f = await syncFixture(cluster);
  const store = await superStore(cluster, f.db);
  const blocker = await store.sql.reserve();
  let running: Promise<Awaited<ReturnType<typeof syncChild>>> | undefined;
  try {
    const r = f.repos[0], git = observeGit(f.root);
    commitChange(r.path);
    await blocker`select pg_advisory_lock(91173321)`;
    await store.sql.unsafe(`create function hold_sync_publication() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(91173321); return new; end $$`);
    await store.sql.unsafe(`create trigger hold_sync_publication before insert or update on state_row for each row when (new.sheet = 'sync') execute function hold_sync_publication()`);
    running = syncChild(f, git.env);
    const until = Date.now() + 10_000;
    let waiting = false;
    while (Date.now() < until) {
      const rows = await store.sql`select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory' and query like 'insert into state_row%'`;
      if (rows.length) { waiting = true; break; }
      await Bun.sleep(20);
    }
    expect(waiting).toBe(true);
    const common = realpathSync(fixtureGit(r.path, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    const key = syncLockKey(f.machine, common);
    const [move] = await blocker`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as held`;
    expect(move.held).toBe(false);
    const commands = git.events().length;
    expect((await syncChild(f, git.env)).code).toBe(0);
    expect(git.events().length).toBe(commands);
    expect((await f.read.sheet("sync")).find(row => row.id === f.id)).toBeUndefined();
    await blocker`select pg_advisory_unlock(91173321)`;
    expect((await running).code).toBe(0);
    expect((await state(f)).data.status).toBe("success");
    const [free] = await blocker`select pg_try_advisory_lock(hashtextextended(${key}, 0)) as held`;
    expect(free.held).toBe(true);
    await blocker`select pg_advisory_unlock(hashtextextended(${key}, 0))`;
    expect((await f.read.ledger({ subject: f.id })).filter(row => row.kind === "sync")).toHaveLength(1);
  } finally {
    await blocker`select pg_advisory_unlock(91173321)`.catch(() => {});
    await running;
    blocker.release(); await store.close(); await f.stop();
  }
}, 90_000);

test("thirty-minute notice is durable after outbox retention and resets only after success", async () => {
  const f = await syncFixture(cluster, { chat: true });
  try {
    const r = f.repos[0], git = observeGit(f.root);
    git.control({ path: realpathSync(r.path), fail: "push" });
    const at = (minutes: number) => new Date(Date.parse("2026-10-03T10:00:00Z") + minutes * 60_000).toISOString();
    const run = (minutes: number) => syncChild(f, git.env, f.id, undefined, at(minutes));
    const notices = () => f.read.sql("select id, body, notice_key from outbox where notice_key like 'sync-stuck:%' order by id");
    for (const minute of [0, 1, 29]) { expect((await run(minute)).code).toBe(1); expect(await notices()).toHaveLength(0); }
    expect((await run(30)).code).toBe(1);
    const [notice] = await notices();
    expect(notice.body).toContain("30 minutes");
    expect(notice.body).toContain("push failed");
    expect(notice.body).toContain("preserve pending work");
    expect(notice.body).not.toMatch(/stage=|reason=|postgres|https?:\/\//);
    expect((await result(f))[0].notified_at).toBe(at(30));
    await f.read.sql("delete from outbox where notice_key like 'sync-stuck:%'");
    expect((await run(60)).code).toBe(1);
    expect(await notices()).toHaveLength(0);
    git.control({}); expect((await run(61)).code).toBe(0);
    expect((await result(f))[0].notified_at).toBeUndefined();
    git.control({ path: realpathSync(r.path), fail: "fetch" });
    expect((await run(62)).code).toBe(1); expect(await notices()).toHaveLength(0);
    expect((await run(92)).code).toBe(1);
    const [next] = await notices();
    expect(next.notice_key).not.toBe(notice.notice_key);
    expect(next.body).toContain("fetch failed");
  } finally { await f.stop(); }
}, 90_000);
