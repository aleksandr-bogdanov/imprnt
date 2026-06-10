// imprnt statusline — the bottom line of your Claude session, yours to shape.
// Shipped as built statusline.js. Claude Code runs it on every refresh (plus every 30s via the
// refreshInterval in this plugin's imp-settings.json, which keeps the clock and the rate limits
// honest), pipes the session JSON on stdin, and shows whatever single line it prints. The wiring
// rides imp's --settings; there is nothing to configure in your own settings files.
//
// The default line:   Opus · imprnt · main · ctx 42% · $1.23 · 5h 24% →18:00 · 7d 41% · 14:05
// model · directory · git branch · context used · session cost · rate limits (reset time for the
// five-hour window) · wall clock. Percentages go yellow past 60 and red past 85.
//
// It is a starting point you personalize — edit the segments below (or copy the plugin into
// plugins/_personal/ first to keep the shipped one pristine). The full field list the JSON
// carries is documented at https://code.claude.com/docs/en/statusline — PR state, vim mode,
// output style, worktree, and more are in there to pick from. ANSI colors and multi-line output
// (one console.log per row) are supported.
//
// Defensive on purpose: every field is optional, a missing one just drops its segment, and
// unparseable stdin prints nothing. A status line must never crash a session.
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename } from "node:path";

type Window = { used_percentage?: number; resets_at?: number };
type SessionInfo = {
  model?: { display_name?: string };
  workspace?: { current_dir?: string };
  context_window?: { used_percentage?: number };
  cost?: { total_cost_usd?: number };
  rate_limits?: { five_hour?: Window; seven_day?: Window };
};

let info: SessionInfo = {};
try {
  info = JSON.parse(readFileSync(0, "utf8")) as SessionInfo;
} catch {
  process.exit(0);
}

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

// A used-percentage, colored by how worried you should be.
function pct(used: number): string {
  const color = used >= 85 ? RED : used >= 60 ? YELLOW : GREEN;
  return `${color}${Math.round(used)}%${RESET}`;
}

function clock(epochSeconds?: number): string {
  const d = epochSeconds === undefined ? new Date() : new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// The current branch, or "" outside a repo / without git. `branch --show-current` is a few ms;
// anything slower (git status) would lag the bar — see the caching note in the statusline docs.
function gitBranch(dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, "branch", "--show-current"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

const segments: string[] = [];

if (info.model?.display_name) segments.push(`${CYAN}${info.model.display_name}${RESET}`);
if (info.workspace?.current_dir) {
  segments.push(basename(info.workspace.current_dir));
  const branch = gitBranch(info.workspace.current_dir);
  if (branch) segments.push(`${MAGENTA}${branch}${RESET}`);
}
if (typeof info.context_window?.used_percentage === "number") {
  segments.push(`ctx ${pct(info.context_window.used_percentage)}`);
}
if (typeof info.cost?.total_cost_usd === "number") {
  segments.push(`$${info.cost.total_cost_usd.toFixed(2)}`);
}
const fiveHour = info.rate_limits?.five_hour;
if (typeof fiveHour?.used_percentage === "number") {
  const reset = fiveHour.resets_at ? ` ${DIM}→${clock(fiveHour.resets_at)}${RESET}` : "";
  segments.push(`5h ${pct(fiveHour.used_percentage)}${reset}`);
}
if (typeof info.rate_limits?.seven_day?.used_percentage === "number") {
  segments.push(`7d ${pct(info.rate_limits.seven_day.used_percentage)}`);
}
segments.push(`${DIM}${clock()}${RESET}`);

console.log(segments.join(`${DIM} · ${RESET}`));
