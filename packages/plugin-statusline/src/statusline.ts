// imprnt statusline — the bottom line of your Claude session, yours to shape.
// Shipped as built statusline.js. Claude Code runs it on every refresh (plus every 30s via the
// refreshInterval in this plugin's imp-settings.json, which keeps the clock, weather, and rate
// limits honest), pipes the session JSON on stdin, and shows whatever it prints. The wiring rides
// imp's --settings; there is nothing to configure in your own settings files.
//
// Four rows, on a wide terminal:
//
//   model Fable 5 · session taxes-deep-dive · dir imprint-vault · git main ↑2 ⊡1
//   cost $0.42 · elapsed 1h12m · lines +156/-23 · effort high · thinking on
//   ctx ▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 48%
//   limits 5h 24% →18:00 · 7d 41% →Thu · vault 247 notes · 3 review · ☀️ 22° · 14:05
//
// Row one is identity: model · session name (when you /rename) · directory · git branch with
// ahead/behind and stash count (index-only — never `git status`, which is the one slow git call).
// Row two is the spend: session cost · elapsed time · lines added/removed · effort level ·
// extended thinking. Row three is the context gauge alone, stretched to the terminal width
// (cells colored by zone: the bar is a meter with bands, not just a fill). Row four is the
// world: rate-limit windows with absolute reset times (clock today, weekday otherwise) · the
// vault (note count, plus a red needs-review count when imprnt check flagged something) ·
// weather (cached, never blocks — fetched in a detached background curl) · wall clock. An empty
// row doesn't print, and on a narrow terminal each row drops its segments in a fixed order
// instead of wrapping — see the ROWS table.
//
// It is a starting point you personalize — edit the segments below (or copy the plugin into
// plugins/_personal/ first to keep the shipped one pristine). The full field list the JSON
// carries is documented at https://code.claude.com/docs/en/statusline — PR state, vim mode,
// output style, worktree, and more are in there to pick from. Multi-line output (one console.log
// per row) also works if you want a second row.
//
// Defensive on purpose: every field is optional, a missing one just drops its segment, git and
// vault reads swallow their errors, weather renders only from cache, and unparseable stdin prints
// nothing. A status line must never crash or stall a session.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

type Window = { used_percentage?: number; resets_at?: number };
type SessionInfo = {
  model?: { display_name?: string };
  session_name?: string;
  workspace?: { current_dir?: string };
  context_window?: { used_percentage?: number };
  exceeds_200k_tokens?: boolean;
  effort?: { level?: string };
  thinking?: { enabled?: boolean };
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

const cols = Number(process.env.COLUMNS) || 0;

function worry(used: number): string {
  return used >= 85 ? RED : used >= 60 ? YELLOW : GREEN;
}

// A used-percentage, colored by how worried you should be.
function pct(used: number): string {
  return `${worry(used)}${Math.round(used)}%${RESET}`;
}

// ▰▰▰▰▱▱▱▱ — a gauge, not just a fill: each FILLED cell carries the color of the zone it sits in
// (green to 60%, yellow to 85%, red past), so a long bar reads like a meter with bands. Empty
// cells stay dim. The gauge has its row to itself, so it stretches to the terminal: everything
// around it ("ctx " + " 100%" + a possible " !200k") needs ~20 columns, the cells get the rest,
// capped so an ultrawide doesn't render a runway.
function bar(used: number): string {
  const cells = cols > 0 ? Math.max(8, Math.min(48, cols - 20)) : 16;
  const filled = Math.min(cells, Math.round((used / 100) * cells));
  let out = "";
  for (let i = 0; i < cells; i++) {
    const zone = (i + 1) / cells;
    out += i < filled ? `${zone > 0.85 ? RED : zone > 0.6 ? YELLOW : GREEN}▰` : `${DIM}▱`;
  }
  return out + RESET;
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// A reset moment: clock time when it lands today, weekday otherwise (a 7-day window resetting
// "at 09:00" tells you nothing without the day).
function reset(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return `${DIM}→${today ? hhmm(d) : d.toLocaleDateString("en-US", { weekday: "short" })}${RESET}`;
}

// 45000ms -> "45s", 4_320_000 -> "1h12m". Sessions don't run for days; hours is enough.
function duration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.floor(ms / 1000)}s`;
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

function git(args: string[], dir: string): string {
  try {
    return execFileSync("git", ["-C", dir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

// branch ↑ahead ↓behind ⊡stashes — all index-only reads (a few ms each). Deliberately NO
// `git status`: on a big repo that scans every tracked file and lags the whole bar.
function gitSegment(dir: string): string {
  const branch = git(["branch", "--show-current"], dir);
  if (!branch) return "";
  let out = `${DIM}git${RESET} ${MAGENTA}${branch}${RESET}`;
  const counts = git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], dir);
  if (counts) {
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    if (ahead) out += ` ${GREEN}↑${ahead}${RESET}`;
    if (behind) out += ` ${RED}↓${behind}${RESET}`;
  }
  const stashes = git(["rev-list", "--walk-reflogs", "--count", "refs/stash"], dir);
  if (stashes && stashes !== "0") out += ` ${DIM}⊡${stashes}${RESET}`;
  return out;
}

// vault 247 notes · 3 review — the vault at a glance: how many notes, and a red count when `imprnt check` flagged
// anything into needs-review. Reads the vault imp already pointed the session at (IMPRNT_VAULT).
function vaultSegment(): string {
  const vault = process.env.IMPRNT_VAULT || process.env.IMPRINT_VAULT;
  if (!vault || !existsSync(vault)) return "";
  try {
    const notes = readdirSync(vault, { recursive: true }).filter(
      (f) => String(f).endsWith(".md") && !basename(String(f)).startsWith("_"),
    ).length;
    const review = existsSync(join(vault, "_needs-review.md"))
      ? readFileSync(join(vault, "_needs-review.md"), "utf8")
          .split("\n")
          .filter((l) => l.startsWith("- ")).length
      : 0;
    const flag = review ? ` ${DIM}·${RESET} ${RED}${BOLD}${review} review${RESET}` : "";
    return `${DIM}vault${RESET} ${notes} ${DIM}notes${RESET}${flag}`;
  } catch {
    return "";
  }
}

// ☀️ 22° — rendered ONLY from a cache file; when the cache is stale a detached curl refreshes it
// for the NEXT render. The bar never waits on the network. Delete this segment if you'd rather
// the script touch no network at all.
function weatherSegment(): string {
  if (process.env.IMPRNT_STATUSLINE_NO_NET) return "";
  const dir = join(tmpdir(), "imprnt-statusline");
  const cache = join(dir, "weather.json");
  let fresh = false;
  let line = "";
  try {
    fresh = Date.now() - statSync(cache).mtimeMs < 15 * 60_000;
    const w = JSON.parse(readFileSync(cache, "utf8")) as { current_weather?: { temperature?: number; weathercode?: number } };
    const cur = w.current_weather;
    if (cur && typeof cur.temperature === "number") {
      const code = cur.weathercode ?? 0;
      const icon =
        code === 0 ? "☀️" : code <= 2 ? "🌤" : code === 3 ? "☁️" : code <= 48 ? "🌫" :
        code <= 67 ? "🌧" : code <= 77 ? "🌨" : code <= 82 ? "🌧" : code <= 86 ? "🌨" : "⛈";
      line = `${icon} ${Math.round(cur.temperature)}°`;
    }
  } catch {
    // no cache yet — fall through to the refresh
  }
  if (!fresh) {
    try {
      mkdirSync(dir, { recursive: true });
      // One shell, detached, output to the cache: geolocate by IP, then ask open-meteo. Both
      // free, no keys. -m caps each call so a dead network can't accumulate zombie curls.
      spawn("sh", ["-c",
        `loc=$(curl -sm 3 http://ip-api.com/json) && curl -sm 3 -o "${cache}" "https://api.open-meteo.com/v1/forecast?latitude=$(echo "$loc" | sed -n 's/.*"lat":\\([0-9.-]*\\).*/\\1/p')&longitude=$(echo "$loc" | sed -n 's/.*"lon":\\([0-9.-]*\\).*/\\1/p')&current_weather=true"`,
      ], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // no curl, read-only tmp — fine, the segment just stays empty
    }
  }
  return line;
}

// Build every segment the payload supports, keyed so the width fitter can drop by name.
const seg = new Map<string, string>();

if (info.model?.display_name) seg.set("model", `${DIM}model${RESET} ${BOLD}${CYAN}${info.model.display_name}${RESET}`);
if (info.session_name) seg.set("session", `${DIM}session${RESET} ${BOLD}${info.session_name}${RESET}`);
if (info.workspace?.current_dir) {
  seg.set("dir", `${DIM}dir${RESET} ${basename(info.workspace.current_dir)}`);
  const g = gitSegment(info.workspace.current_dir);
  if (g) seg.set("branch", g);
}
if (typeof info.context_window?.used_percentage === "number") {
  const used = info.context_window.used_percentage;
  const over = info.exceeds_200k_tokens ? ` ${RED}${BOLD}!200k${RESET}` : "";
  seg.set("ctx", `${DIM}ctx${RESET} ${bar(used)} ${pct(used)}${over}`);
}
if (info.effort?.level) seg.set("effort", `${DIM}effort${RESET} ${info.effort.level}`);
if (typeof info.thinking?.enabled === "boolean") {
  seg.set("thinking", `${DIM}thinking${RESET} ${info.thinking.enabled ? "on" : "off"}`);
}
if (typeof info.cost?.total_cost_usd === "number") {
  seg.set("cost", `${DIM}cost${RESET} $${info.cost.total_cost_usd.toFixed(2)}`);
}
if (typeof info.cost?.total_duration_ms === "number" && info.cost.total_duration_ms >= 1000) {
  seg.set("time", `${DIM}elapsed${RESET} ${duration(info.cost.total_duration_ms)}`);
}
if (info.cost?.total_lines_added || info.cost?.total_lines_removed) {
  seg.set("lines", `${DIM}lines${RESET} ${GREEN}+${info.cost.total_lines_added ?? 0}${RESET}${DIM}/${RESET}${RED}-${info.cost.total_lines_removed ?? 0}${RESET}`);
}
const fiveHour = info.rate_limits?.five_hour;
if (typeof fiveHour?.used_percentage === "number") {
  const r = fiveHour.resets_at ? ` ${reset(fiveHour.resets_at)}` : "";
  seg.set("5h", `${DIM}limits${RESET} 5h ${pct(fiveHour.used_percentage)}${r}`);
}
const sevenDay = info.rate_limits?.seven_day;
if (typeof sevenDay?.used_percentage === "number") {
  const r = sevenDay.resets_at ? ` ${reset(sevenDay.resets_at)}` : "";
  seg.set("7d", `7d ${pct(sevenDay.used_percentage)}${r}`);
}
const vault = vaultSegment();
if (vault) seg.set("vault", vault);
const weather = weatherSegment();
if (weather) seg.set("weather", weather);
seg.set("clock", `${DIM}${hhmm(new Date())}${RESET}`);

// Two rows, each with its own drop order for narrow terminals (COLUMNS is set by Claude Code,
// v2.1.153+): when a row runs too wide, its segments drop housekeeping-first, load-bearing last.
// An empty row simply doesn't print, so a sparse payload degrades to one line on its own.
const ROWS: { keys: string[]; drop: string[] }[] = [
  { keys: ["model", "session", "dir", "branch"],
    drop: ["session", "dir", "branch", "model"] },
  { keys: ["cost", "time", "lines", "effort", "thinking"],
    drop: ["thinking", "effort", "lines", "time", "cost"] },
  { keys: ["ctx"], drop: [] }, // the gauge already sizes itself to the terminal
  { keys: ["5h", "7d", "vault", "weather", "clock"],
    drop: ["weather", "clock", "vault", "7d", "5h"] },
];
const SEP = `${DIM} · ${RESET}`;
// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

for (const row of ROWS) {
  const present = () => row.keys.filter((k) => seg.has(k)).map((k) => seg.get(k)!);
  if (cols > 0) {
    for (const name of row.drop) {
      if (visible(present().join(SEP)) <= cols) break;
      seg.delete(name);
    }
  }
  if (present().length) console.log(present().join(SEP));
}
