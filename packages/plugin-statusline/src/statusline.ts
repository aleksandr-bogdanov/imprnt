// imprnt statusline — the bottom line of your Claude session, yours to shape.
// Shipped as built statusline.js. Claude Code runs it on every refresh (plus every 30s via the
// refreshInterval in this plugin's imp-settings.json, which keeps the clock and the rate limits
// honest), pipes the session JSON on stdin, and shows whatever it prints. The wiring rides imp's
// --settings; there is nothing to configure in your own settings files.
//
// The full line, on a wide terminal:
//
//   Fable 5 · imprint-vault · main · ▰▰▰▰▱▱▱▱ 48% · $0.42 · 1h12m · +156/-23 · 5h 24% →18:00 · 7d 41% · 02:01
//
// model · directory · git branch · context bar · session cost · session duration · lines
// added/removed · rate-limit windows (reset clock on the five-hour one) · wall clock. Percentages
// and the bar go yellow past 60 and red past 85. On a narrow terminal, segments drop in a fixed
// order (clock and lines first, model and context last) instead of wrapping — see DROP_ORDER.
//
// It is a starting point you personalize — edit the segments below (or copy the plugin into
// plugins/_personal/ first to keep the shipped one pristine). The full field list the JSON
// carries is documented at https://code.claude.com/docs/en/statusline — PR state, vim mode,
// output style, worktree, and more are in there to pick from. Multi-line output (one console.log
// per row) also works if you want a second row.
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
  exceeds_200k_tokens?: boolean;
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  rate_limits?: { five_hour?: Window; seven_day?: Window };
};

let info: SessionInfo = {};
try {
  info = JSON.parse(readFileSync(0, "utf8")) as SessionInfo;
} catch {
  process.exit(0);
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

function worry(used: number): string {
  return used >= 85 ? RED : used >= 60 ? YELLOW : GREEN;
}

// A used-percentage, colored by how worried you should be.
function pct(used: number): string {
  return `${worry(used)}${Math.round(used)}%${RESET}`;
}

// ▰▰▰▰▱▱▱▱ — the filled cells carry the worry color, the empty ones stay dim.
function bar(used: number, cells = 8): string {
  const filled = Math.min(cells, Math.round((used / 100) * cells));
  return `${worry(used)}${"▰".repeat(filled)}${DIM}${"▱".repeat(cells - filled)}${RESET}`;
}

function clock(epochSeconds?: number): string {
  const d = epochSeconds === undefined ? new Date() : new Date(epochSeconds * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// 45000ms -> "45s", 4_320_000 -> "1h12m". Sessions don't run for days; hours is enough.
function duration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
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

// Build every segment the payload supports, keyed so the width fitter can drop by name.
const seg = new Map<string, string>();

if (info.model?.display_name) seg.set("model", `${BOLD}${CYAN}${info.model.display_name}${RESET}`);
if (info.workspace?.current_dir) {
  seg.set("dir", basename(info.workspace.current_dir));
  const branch = gitBranch(info.workspace.current_dir);
  if (branch) seg.set("branch", `${MAGENTA}${branch}${RESET}`);
}
if (typeof info.context_window?.used_percentage === "number") {
  const used = info.context_window.used_percentage;
  const over = info.exceeds_200k_tokens ? ` ${RED}${BOLD}!200k${RESET}` : "";
  seg.set("ctx", `${bar(used)} ${pct(used)}${over}`);
}
if (typeof info.cost?.total_cost_usd === "number") {
  seg.set("cost", `$${info.cost.total_cost_usd.toFixed(2)}`);
}
if (typeof info.cost?.total_duration_ms === "number" && info.cost.total_duration_ms >= 1000) {
  seg.set("time", `${DIM}${duration(info.cost.total_duration_ms)}${RESET}`);
}
if (info.cost?.total_lines_added || info.cost?.total_lines_removed) {
  seg.set("lines", `${GREEN}+${info.cost.total_lines_added ?? 0}${RESET}${DIM}/${RESET}${RED}-${info.cost.total_lines_removed ?? 0}${RESET}`);
}
const fiveHour = info.rate_limits?.five_hour;
if (typeof fiveHour?.used_percentage === "number") {
  const reset = fiveHour.resets_at ? ` ${DIM}→${clock(fiveHour.resets_at)}${RESET}` : "";
  seg.set("5h", `5h ${pct(fiveHour.used_percentage)}${reset}`);
}
if (typeof info.rate_limits?.seven_day?.used_percentage === "number") {
  seg.set("7d", `7d ${pct(info.rate_limits.seven_day.used_percentage)}`);
}
seg.set("clock", `${DIM}${clock()}${RESET}`);

// Fit to the terminal: COLUMNS is set by Claude Code (v2.1.153+). When the assembled line is too
// wide, drop segments in this order — housekeeping first, the load-bearing ones last.
const DROP_ORDER = ["clock", "lines", "time", "7d", "dir", "branch", "5h", "cost", "ctx", "model"];
const SEP = `${DIM} · ${RESET}`;
// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const line = () => [...seg.values()].join(SEP);

const cols = Number(process.env.COLUMNS) || 0;
if (cols > 0) {
  for (const name of DROP_ORDER) {
    if (visible(line()) <= cols) break;
    seg.delete(name);
  }
}

if (seg.size) console.log(line());
