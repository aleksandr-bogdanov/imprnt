// imprnt · whenful plugin — the network edge. The ONLY module that may touch the wire.
//
// Wired against the real Whenful API (FastAPI backend at whenful.com): one task per call,
//     GET /api/v1/tasks/{id}      Authorization: Bearer <device-token>   -> TaskResponse
// The token is the user's Whenful device token, read from WHENFUL_TOKEN at sync time — never
// hardcoded, never committed. The base URL is WHENFUL_API (default https://whenful.com).
//
// One offline door so the whole sync + render path is exercisable with ZERO network:
//     WHENFUL_FIXTURES=<dir>   read each task from <dir>/<id>.json instead of the wire
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The subset of Whenful's TaskResponse the mirror renders. Whenful sends more fields; we read only
// the ones a render-at-read surface needs (title/status/due/impact/domain/duration/recurrence). Extra
// fields on the wire are ignored — a forward-compatible read, not a brittle exact-shape contract.
export type WhenfulTask = {
  id: number;
  title: string;
  description: string | null;
  domain_name: string | null;
  duration_minutes: number | null;
  impact: number;
  clarity: string | null;
  scheduled_date: string | null;
  scheduled_time: string | null;
  is_recurring: boolean;
  status: string;
  completed_at: string | null;
  today_instance_completed: boolean | null;
};

const DEFAULT_API = "https://whenful.com";

export const AUTH_HINT =
  "no Whenful token — set WHENFUL_TOKEN to your device token (from the Whenful app/SPA), then sync.\n" +
  "  The token is read from the environment at sync time, never stored in the repo.\n" +
  "  Offline (no wire, for tests/demo): WHENFUL_FIXTURES=<dir> with one <id>.json per task.";

function apiBase(): string {
  return (process.env.WHENFUL_API ?? DEFAULT_API).replace(/\/+$/, "");
}

// A task id from links.tsv is a string; Whenful task ids are integers. Reject anything that isn't a
// clean integer before it reaches a URL — a stray slug would otherwise build a wrong, possibly unsafe
// request path. The caller turns this into a per-task skip, never a crash.
function assertNumericId(id: string): void {
  if (!/^\d+$/.test(id)) throw new Error(`task id "${id}" is not a numeric Whenful id — fix the links.tsv row`);
}

function readFixture(dir: string, id: string): WhenfulTask {
  const p = join(dir, `${id}.json`);
  if (!existsSync(p)) throw new Error(`WHENFUL_FIXTURES has no ${id}.json (looked in ${dir})`);
  return JSON.parse(readFileSync(p, "utf8")) as WhenfulTask;
}

// Fetch ONE task's current state. Fixtures win when WHENFUL_FIXTURES is set (offline). Live path:
// Bearer-auth GET against the same /api/v1/tasks/{id} the SPA calls. Errors are loud and specific so a
// caller can tell "fix your token" (401) from "this one task is gone" (404) from a transient blip.
export async function fetchTask(id: string): Promise<WhenfulTask> {
  assertNumericId(id);

  const fixtures = process.env.WHENFUL_FIXTURES;
  if (fixtures) {
    if (!existsSync(fixtures)) throw new Error(`WHENFUL_FIXTURES points at a missing dir: ${fixtures}`);
    return readFixture(fixtures, id);
  }

  const token = process.env.WHENFUL_TOKEN;
  if (!token) throw new Error(AUTH_HINT);

  const url = `${apiBase()}/api/v1/tasks/${id}`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  } catch (e) {
    throw new Error(`network error reaching Whenful (${url}): ${e instanceof Error ? e.message : e}`);
  }
  if (res.status === 401) throw new Error("401 from Whenful — WHENFUL_TOKEN is missing, wrong, or revoked. Re-copy it from the app.");
  if (res.status === 404) throw new Error(`task ${id} returns 404 — deleted in Whenful, or the links.tsv id is wrong`);
  if (!res.ok) throw new Error(`GET /api/v1/tasks/${id} -> ${res.status} ${res.statusText}`);
  return (await res.json()) as WhenfulTask;
}

// --- render-at-read: turn a fetched task into the mirror/<id>.md a reader (the agent) renders from ---
// Pure (no IO) so it is unit-testable and so `sync` is the only writer. Frontmatter carries the fields
// the agent surfaces; the body is a short human-readable echo. Impact maps 1..4 -> high..minimal.
const IMPACT_LABEL: Record<number, string> = { 1: "high", 2: "medium", 3: "low", 4: "minimal" };

function fmtDue(task: WhenfulTask): string {
  if (!task.scheduled_date) return "unscheduled";
  return task.scheduled_time ? `${task.scheduled_date} ${task.scheduled_time}` : task.scheduled_date;
}

// YAML-safe single-line scalar: collapse any interior whitespace run (newlines/tabs included) to a
// single space, then wrap in double quotes escaping `\` and `"`. Titles/descriptions are arbitrary
// user text and Whenful KEEPS interior newlines (its validator strips only control chars and trims
// the ends), so without the collapse a two-line title would split the scalar across physical lines and
// inject sibling frontmatter keys at column 0. Forcing one line is the correct fix for a flat scalar.
function yamlStr(v: string): string {
  const oneLine = v.replace(/[\r\n\t]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${oneLine}"`;
}

export function renderMirror(task: WhenfulTask, mirroredAt: string): string {
  const due = fmtDue(task);
  const impact = IMPACT_LABEL[task.impact] ?? String(task.impact);
  const lines = [
    "---",
    `task_id: ${task.id}`,
    `title: ${yamlStr(task.title)}`,
    `status: ${yamlStr(task.status)}`, // server enum today, but a string field — quote defensively
    `impact: ${yamlStr(impact)}`,
    `domain: ${task.domain_name ? yamlStr(task.domain_name) : "null"}`,
    `due: ${due === "unscheduled" ? "null" : yamlStr(due)}`,
  ];
  if (task.duration_minutes != null) lines.push(`duration_minutes: ${task.duration_minutes}`);
  if (task.is_recurring) lines.push("recurring: true");
  if (task.is_recurring && task.today_instance_completed != null)
    lines.push(`today_done: ${task.today_instance_completed}`);
  if (task.completed_at) lines.push(`completed_at: ${yamlStr(task.completed_at)}`);
  lines.push(`mirrored: ${mirroredAt}`);
  lines.push("---", "");
  lines.push(`# ${task.title}`, "");
  lines.push(`- status: ${task.status}${task.is_recurring ? " (recurring)" : ""}`);
  lines.push(`- due: ${due}`);
  lines.push(`- impact: ${impact}${task.domain_name ? ` · domain: ${task.domain_name}` : ""}`);
  if (task.description && task.description.trim()) {
    lines.push("", task.description.trim());
  }
  lines.push("");
  return lines.join("\n");
}
