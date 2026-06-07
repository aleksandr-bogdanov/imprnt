// imprint · whenful plugin — task mirror. Shipped as built whenful.js (node banner).
//
//   node plugins/whenful/whenful.js sync     refresh mirror/<id>.md from Whenful   (STUB — no live call yet)
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
  // The integrity logic lives in check.js (the built file the `imprint check --all` aggregator globs).
  // Run it as a node subprocess so there's ONE implementation and the exit code propagates unchanged.
  const proc = spawnSync(process.execPath, [join(here, "check.js")], { stdio: "inherit" });
  process.exit(proc.status ?? 1);
}

if (cmd === "sync") {
  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  // STUB — makes NO live network call. It documents the Whenful API contract `sync` WILL call, and
  // refreshes the local mirror so the render-at-read path and `check` are exercisable end-to-end today.
  //
  // TODO(next session): wire the real Whenful API. The contract this stub stands in for:
  //
  //   AUTH:    Bearer token from the user's Whenful session (env `WHENFUL_TOKEN`, never hardcoded).
  //            Whenful is a React SPA + FastAPI backend at whenful.com; the API is the same one the SPA
  //            calls. Read the token from the environment at sync time; do not persist it in the repo.
  //
  //   FETCH:   incremental, `updated_at`-based — the client/server model in the Whenful repo. We track
  //            the last successful sync timestamp locally (mirror/.last-sync) and ask the server only
  //            for tasks changed since then:
  //                GET /api/tasks?updated_since=<ISO8601>     -> [{ id, title, status, due, updated_at, ... }]
  //            so a routine sync transfers only deltas, not the whole task list. Batched, one call.
  //
  //   WRITE:   for each returned task, (over)write mirror/<id>.md with its current state (frontmatter +
  //            a human-readable body), and stamp mirror/.last-sync with the server's response time. The
  //            mirror is a pure cache: it is always safe to delete and rebuild from a full sync.
  //
  //   SCOPE:   sync ONLY refreshes the mirror and the join-table-referenced tasks. It never writes a
  //            vault note (that's `imprint ingest --apply` on a proposed/ file) and never runs on its
  //            own (the user schedules it). See docs: https://whenful.com  /  the Whenful repo's API.
  // ─────────────────────────────────────────────────────────────────────────────────────────────────
  mkdirSync(MIRROR_DIR, { recursive: true });
  const links = readLinks();

  if (links.length === 0) {
    console.log("whenful sync (STUB): no links in links.tsv yet — nothing to mirror.");
    console.log("  add task↔note rows to plugins/whenful/links.tsv, then sync.");
    console.log("  NOTE: this is a stub — no live Whenful call is made. Live wiring is the next session.");
    process.exit(0);
  }

  // Refresh a mirror file per linked task. With no live API, we write a clearly-marked PLACEHOLDER so the
  // staleness check and the render-at-read path are exercisable; the real `sync` replaces this with the
  // task's actual fetched state. We never invent a status that looks real.
  const now = new Date().toISOString();
  let written = 0;
  for (const { taskId } of links) {
    const p = join(MIRROR_DIR, `${taskId}.md`);
    if (existsSync(p)) continue; // don't clobber a real mirror file a future live sync may have written
    writeFileSync(p, [
      "---",
      `task_id: ${taskId}`,
      "status: unknown            # STUB placeholder — real status arrives when sync is wired",
      `mirrored: ${now}`,
      "stub: true",
      "---",
      "",
      `# Task ${taskId} (placeholder)`,
      "",
      "> Placeholder mirror file written by the `sync` STUB. No live Whenful data yet.",
      "> Run a real sync (next session) to populate title/status/due from the server.",
      "",
    ].join("\n"));
    written++;
  }
  writeFileSync(join(MIRROR_DIR, ".last-sync"), now + "\n");
  console.log(`whenful sync (STUB): ${written} placeholder mirror file(s) written, last-sync stamped ${now}.`);
  console.log("  NOTE: this is a stub — no live Whenful call is made. Live wiring is the next session.");
  process.exit(0);
}

console.error("usage: bun plugins/whenful/whenful.ts <sync|check>");
process.exit(1);
