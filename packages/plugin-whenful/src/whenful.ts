// imprnt · whenful plugin — task mirror. Shipped as built whenful.js (node banner).
//
//   node plugins/whenful/whenful.js sync     refresh mirror/<id>.md from Whenful (live, Bearer auth)
//   node plugins/whenful/whenful.js check    integrity (delegates to ./check.js)
//
// Contract reminders (see plugins/README.md): this plugin depends on exactly two things — the vault's
// note FORMAT and its own folder. It NEVER edits a vault note; it keeps task state in its OWN mirror
// and the task↔note links in its OWN join table (links.tsv). Render-at-read off the mirror; the ONLY
// thing that crosses the wire is `sync`, batched and user-run — never a daemon.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchTask, renderMirror, AUTH_HINT } from "./client.ts";

const here = dirname(fileURLToPath(import.meta.url));
const MIRROR_DIR = join(here, "mirror");
const LINKS = join(here, "links.tsv");

// --- the ~12-line frontmatter/TSV readers, COPIED per the contract (plugins don't import core code) -
// Parse links.tsv into {task_id, note_slug, step_label} rows, skipping comments + blanks.
type Link = { taskId: string; noteSlug: string; step: string };
function readLinks(): Link[] {
  if (!existsSync(LINKS)) return [];
  const out: Link[] = [];
  for (const line of readFileSync(LINKS, "utf8").split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const [taskId, noteSlug, step] = line.split("\t");
    if (taskId && noteSlug) out.push({ taskId: taskId.trim(), noteSlug: noteSlug.trim(), step: (step ?? "").trim() });
  }
  return out;
}

const cmd = process.argv[2];

if (cmd === "check") {
  // The integrity logic lives in check.js (the built file the `imprnt check --all` aggregator globs).
  // Run it as a node subprocess so there's ONE implementation and the exit code propagates unchanged.
  const proc = spawnSync(process.execPath, [join(here, "check.js")], { stdio: "inherit" });
  process.exit(proc.status ?? 1);
}

if (cmd === "sync") {
  // The ONLY command that crosses the wire. For each task referenced by the join table it GETs the
  // task's current state from Whenful (Bearer auth, WHENFUL_TOKEN) and (over)writes mirror/<id>.md. The
  // mirror is a pure cache: always safe to delete and rebuild from a full sync. sync never writes a
  // vault note (that's `imprnt ingest --apply` on a proposed/ file) and never runs on its own.
  //
  //   AUTH:  Authorization: Bearer <WHENFUL_TOKEN>   (the user's Whenful device token, env-only)
  //   FETCH: GET {WHENFUL_API|https://whenful.com}/api/v1/tasks/{id}  -> TaskResponse, per linked task
  //   WRITE: mirror/<id>.md (frontmatter the agent renders from + a short body) + stamp mirror/.last-sync
  //   OFFLINE: WHENFUL_FIXTURES=<dir> reads <id>.json instead of the wire (tests/demo, zero network)
  await runSync();
}

async function runSync(): Promise<never> {
  mkdirSync(MIRROR_DIR, { recursive: true });
  const links = readLinks();

  // Distinct task ids — a task may be linked from more than one note; we fetch+mirror it once.
  const ids = [...new Set(links.map((l) => l.taskId))];

  if (ids.length === 0) {
    console.log("whenful sync: no links in links.tsv yet — nothing to mirror.");
    console.log("  add task↔note rows to plugins/whenful/links.tsv (links.example.tsv shows the format), then sync.");
    process.exit(0);
  }

  // Preflight the credential up front. Missing auth (no token AND no fixtures) is a whole-run failure,
  // not a per-task one — fail loud and early so the user fixes the token instead of seeing N identical
  // 401s. A per-task error (a deleted task, a bad id) is isolated below and never sinks the rest.
  if (!process.env.WHENFUL_FIXTURES && !process.env.WHENFUL_TOKEN) {
    console.error(`whenful sync: ${AUTH_HINT}`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const failed: string[] = [];
  let written = 0;
  for (const id of ids) {
    try {
      const task = await fetchTask(id);
      writeFileSync(join(MIRROR_DIR, `${id}.md`), renderMirror(task, now));
      written++;
    } catch (e) {
      failed.push(`task ${id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  // Only stamp .last-sync when at least one task came through — a run where every fetch failed (e.g. a
  // revoked token) must NOT look fresh to `check`. The staleness gate then keeps surfacing the problem.
  if (written > 0) writeFileSync(join(MIRROR_DIR, ".last-sync"), now + "\n");

  console.log(`whenful sync: ${written}/${ids.length} task(s) mirrored at ${now}.`);
  if (failed.length) {
    console.error(`⚠ ${failed.length} task(s) failed:`);
    for (const f of failed) console.error(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

console.error("usage: node plugins/whenful/whenful.js <sync|check>");
process.exit(1);
