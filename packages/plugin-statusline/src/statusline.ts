// imprnt statusline — the bottom panel of your Claude session, yours to shape.
// Shipped as built statusline.js. Claude Code runs it on every refresh (plus every 30s via the
// refreshInterval in this plugin's imp-settings.json, which keeps the clock, weather, and rate
// limits honest), pipes the session JSON on stdin, and shows whatever it prints. The wiring rides
// imp's --settings; there is nothing to configure in your own settings files.
//
// Four rows, on a wide terminal — identity, spend, engine, world:
//
//   model  Fable 5 · session taxes-deep-dive · dir imprint-vault · git main ↑2 ⊡1
//   cost   $0.42 · elapsed 1h12m · lines +156/-23
//   ctx    ▰▰▰▰▰▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱  42% · effort high
//   limits 5h  24% →18:00 · 7d  41% →Thu · vault 247 notes, 3 review · ☀ 22° · 14:05
//
// The design rules, learned from the tools that do this well (p10k-lean, catppuccin/tmux):
//   - The leading label of each row pads to one gutter width, so the panel reads as a table.
//   - Labels are muted slate, values are bright ink. One accent per row (your session name).
//   - Color means something or it isn't there: green/amber/red is one alarm ramp shared by every
//     percentage and the gauge; on a calm session the panel is nearly monochrome.
//   - The gauge is a meter face: empty cells are faintly tinted by their zone, so the amber and
//     red bands are visible even when you're at 10%.
//   - Numbers pad to fixed width so the panel never jitters between refreshes.
//   - `thinking` renders only when OFF — a flag that is always "on" is not information.
//
// Truecolor by default, plain 16-color when COLORTERM doesn't advertise it, bare text under
// NO_COLOR. On a narrow terminal each row drops segments in a fixed order instead of wrapping
// (see ROWS at the bottom); a trailing row whose only survivor is the clock doesn't print.
//
// It is a starting point you personalize — edit the segments and the PALETTE below (or copy the
// plugin into plugins/_personal/ first to keep the shipped one pristine). The full field list the
// JSON carries is documented at https://code.claude.com/docs/en/statusline — PR state, vim mode,
// output style, worktree, and more are in there to pick from.
//
// Defensive on purpose: every field is optional, a missing one just drops its segment, git and
// vault reads swallow their errors, weather renders only from cache (a detached curl refreshes it
// for the NEXT render), and unparseable stdin prints nothing. A status line must never crash or
// stall a session.
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

// ----------------------------------------------------------------------------------------------
// Ink. Roles, not decorations: lbl is the chrome, val is what you read, ok/warn/bad is the one
// alarm ramp everything thresholded shares. Truecolor (Tokyo Night family) when the terminal
// advertises it, the nearest base colors otherwise, nothing under NO_COLOR.
const plain = !!process.env.NO_COLOR;
const truecolor = !plain && /truecolor|24bit/i.test(process.env.COLORTERM ?? "");
const fg = (hex: string, fallback: string): string => {
  if (plain) return "";
  if (!truecolor) return fallback;
  const [r, g, b] = [hex.slice(1, 3), hex.slice(3, 5), hex.slice(5, 7)].map((h) => parseInt(h, 16));
  return `\x1b[38;2;${r};${g};${b}m`;
};
const RESET = plain ? "" : "\x1b[0m";
const BOLD = plain ? "" : "\x1b[1m";
const P = {
  lbl: fg("#565f89", "\x1b[2m"), //    labels, reset times, stash — the chrome
  sep: fg("#3b4261", "\x1b[2m"), //    the · between segments, quieter than the chrome
  val: fg("#c0caf5", ""), //           values — the ink you actually read
  model: fg("#7dcfff", "\x1b[36m"), // the model name: quiet cyan, no bold
  session: BOLD, //                    the one accent: the name YOU gave this session
  branch: fg("#bb9af7", "\x1b[35m"),
  ok: fg("#9ece6a", "\x1b[32m"),
  warn: fg("#e0af68", "\x1b[33m"),
  bad: fg("#f7768e", "\x1b[31m"),
  // the gauge face: empty cells faintly tinted by their zone, so the bands always show
  okDim: fg("#2e3b2e", "\x1b[2m"),
  warnDim: fg("#453b28", "\x1b[2m"),
  badDim: fg("#462e33", "\x1b[2m"),
};

const cols = Number(process.env.COLUMNS) || 0;

function worry(used: number): string {
  return used >= 85 ? P.bad : used >= 60 ? P.warn : P.ok;
}

// A used-percentage on the alarm ramp, padded to a fixed width so the row never jitters when
// 9% becomes 10%.
function pct(used: number): string {
  return `${worry(used)}${String(Math.round(used)).padStart(3)}%${RESET}`;
}

// ▰▰▰▰▱▱▱▱ — a meter face, not just a fill. Filled cells take the color of the zone they sit in
// (green to 60%, amber to 85%, red past), and EMPTY cells carry a faint tint of the same zone,
// so the danger bands are visible at any fill level. One SGR per zone change, not per cell.
function bar(used: number): string {
  const cells = cols >= 100 ? 24 : 12;
  const filled = Math.min(cells, Math.round((used / 100) * cells));
  let out = "";
  let last = "";
  for (let i = 0; i < cells; i++) {
    const zone = (i + 1) / cells;
    const color =
      i < filled
        ? zone > 0.85 ? P.bad : zone > 0.6 ? P.warn : P.ok
        : zone > 0.85 ? P.badDim : zone > 0.6 ? P.warnDim : P.okDim;
    if (color !== last) out += color;
    last = color;
    out += i < filled ? "▰" : "▱";
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
  return `${P.lbl}→${today ? hhmm(d) : d.toLocaleDateString("en-US", { weekday: "short" })}${RESET}`;
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
// `git status`: on a big repo that scans every tracked file and lags the whole panel.
function gitSegment(dir: string): string {
  const branch = git(["branch", "--show-current"], dir);
  if (!branch) return "";
  let out = `${P.lbl}git${RESET} ${P.branch}${branch}${RESET}`;
  const counts = git(["rev-list", "--left-right", "--count", "@{upstream}...HEAD"], dir);
  if (counts) {
    const [behind, ahead] = counts.split(/\s+/).map(Number);
    if (ahead) out += ` ${P.warn}↑${ahead}${RESET}`;
    if (behind) out += ` ${P.bad}↓${behind}${RESET}`;
  }
  const stashes = git(["rev-list", "--walk-reflogs", "--count", "refs/stash"], dir);
  if (stashes && stashes !== "0") out += ` ${P.lbl}⊡${stashes}${RESET}`;
  return out;
}

// vault 247 notes, 3 review — the vault at a glance: how many notes, and a red count when
// `imprnt check` flagged anything. The review count binds to the vault with a comma — it is a
// property of the vault, not its own segment. Reads the vault imp pointed the session at.
// Root-level index.md/hot.md/log.md are generated control surfaces, not notes — excluded with
// the same root anchoring core's walks use (a nested work/index.md is genuine knowledge, so a
// control basename only counts when the relative path has no directory component).
const CONTROL = new Set(["index.md", "hot.md", "log.md"]);
function vaultSegment(): string {
  const vault = process.env.IMPRNT_VAULT || process.env.IMPRINT_VAULT;
  if (!vault || !existsSync(vault)) return "";
  try {
    const notes = readdirSync(vault, { recursive: true }).filter((f) => {
      const rel = String(f);
      if (!rel.endsWith(".md") || basename(rel).startsWith("_")) return false;
      return rel.includes("/") || rel.includes("\\") || !CONTROL.has(rel);
    }).length;
    const review = existsSync(join(vault, "_needs-review.md"))
      ? readFileSync(join(vault, "_needs-review.md"), "utf8")
          .split("\n")
          .filter((l) => l.startsWith("- ")).length
      : 0;
    const flag = review ? `${P.lbl},${RESET} ${P.bad}${BOLD}${review} review${RESET}` : "";
    return `${P.lbl}vault${RESET} ${P.val}${notes}${RESET} ${P.lbl}notes${RESET}${flag}`;
  } catch {
    return "";
  }
}

// ☀ 22° — text-presentation weather glyphs (no emoji variation selector: single-width,
// monochrome, they match the panel's register). Rendered ONLY from a cache file; when the cache
// is stale a detached curl refreshes it for the NEXT render. The panel never waits on the
// network. This is the one segment that touches the network (IP geolocation + open-meteo, both
// HTTPS, no vault or session data): set IMPRNT_STATUSLINE_NO_NET=1 (or delete the segment) if
// you'd rather the script touch no network at all.
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
        code <= 1 ? "☀" : code <= 3 ? "☁" : code <= 48 ? "≡" :
        code <= 77 ? "☂" : code <= 86 ? "❄" : "☂";
      line = `${P.val}${icon} ${Math.round(cur.temperature)}°${RESET}`;
    }
  } catch {
    // no cache yet — fall through to the refresh
  }
  if (!fresh) {
    try {
      mkdirSync(dir, { recursive: true });
      // One shell, detached, output to the cache: geolocate by IP, then ask open-meteo. Both
      // free, no keys, HTTPS only. -m caps each call so a dead network can't accumulate zombie
      // curls.
      spawn("sh", ["-c",
        `loc=$(curl -sm 3 https://ipwho.is) && curl -sm 3 -o "${cache}" "https://api.open-meteo.com/v1/forecast?latitude=$(echo "$loc" | sed -n 's/.*"latitude": *\\([0-9.-]*\\).*/\\1/p')&longitude=$(echo "$loc" | sed -n 's/.*"longitude": *\\([0-9.-]*\\).*/\\1/p')&current_weather=true"`,
      ], { detached: true, stdio: "ignore" }).unref();
    } catch {
      // no curl, read-only tmp — fine, the segment just stays empty
    }
  }
  return line;
}

// Build every segment the payload supports, keyed so the width fitter can drop by name.
const seg = new Map<string, string>();
const label = (name: string, value: string) => `${P.lbl}${name}${RESET} ${value}`;

if (info.model?.display_name) seg.set("model", label("model", `${P.model}${info.model.display_name}${RESET}`));
if (info.session_name) seg.set("session", label("session", `${P.session}${info.session_name}${RESET}`));
if (info.workspace?.current_dir) {
  seg.set("dir", label("dir", `${P.val}${basename(info.workspace.current_dir)}${RESET}`));
  const g = gitSegment(info.workspace.current_dir);
  if (g) seg.set("branch", g);
}
if (typeof info.context_window?.used_percentage === "number") {
  const used = info.context_window.used_percentage;
  const over = info.exceeds_200k_tokens ? ` ${P.bad}${BOLD}!200k${RESET}` : "";
  seg.set("ctx", label("ctx", `${bar(used)} ${pct(used)}${over}`));
}
if (info.effort?.level) seg.set("effort", label("effort", `${P.val}${info.effort.level}${RESET}`));
// A flag that is always "on" is not information: render thinking only when it is OFF.
if (info.thinking?.enabled === false) seg.set("thinking", label("thinking", `${P.warn}off${RESET}`));
if (typeof info.cost?.total_cost_usd === "number") {
  seg.set("cost", label("cost", `${P.val}$${info.cost.total_cost_usd.toFixed(2)}${RESET}`));
}
if (typeof info.cost?.total_duration_ms === "number" && info.cost.total_duration_ms >= 1000) {
  seg.set("time", label("elapsed", `${P.val}${duration(info.cost.total_duration_ms)}${RESET}`));
}
if (info.cost?.total_lines_added || info.cost?.total_lines_removed) {
  seg.set("lines", label("lines", `${P.ok}+${info.cost.total_lines_added ?? 0}${RESET}${P.lbl}/${RESET}${P.bad}-${info.cost.total_lines_removed ?? 0}${RESET}`));
}
const fiveHour = info.rate_limits?.five_hour;
if (typeof fiveHour?.used_percentage === "number") {
  const r = fiveHour.resets_at ? ` ${reset(fiveHour.resets_at)}` : "";
  seg.set("5h", label("limits", `5h ${pct(fiveHour.used_percentage)}${r}`));
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
seg.set("clock", `${P.lbl}${hhmm(new Date())}${RESET}`);

// Four rows — identity, spend, engine, world — each with its own drop order for narrow terminals
// (COLUMNS is set by Claude Code, v2.1.153+): when a row runs too wide, its segments drop
// housekeeping-first, load-bearing last. The leading label of each row pads to one gutter width
// so the rows align into a table. An empty row doesn't print, and neither does the world row when
// its only survivor is the clock — a bare time is not a status.
const ROWS: { keys: string[]; drop: string[] }[] = [
  { keys: ["model", "session", "dir", "branch"],
    drop: ["session", "dir", "branch", "model"] },
  { keys: ["cost", "time", "lines"],
    drop: ["lines", "time", "cost"] },
  { keys: ["ctx", "effort", "thinking"],
    drop: ["thinking", "effort", "ctx"] },
  { keys: ["5h", "7d", "vault", "weather", "clock"],
    drop: ["weather", "clock", "vault", "7d", "5h"] },
];
const GUTTER = 6; // the widest leading label ("limits"); keeps the left edge a straight line
const SEP = `${P.sep} · ${RESET}`;
// eslint-disable-next-line no-control-regex
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

for (const row of ROWS) {
  const present = () => row.keys.filter((k) => seg.has(k)).map((k) => seg.get(k)!);
  const render = (parts: string[]) => {
    // Pad the row's leading label out to the gutter: the text before the first space in the
    // first segment, measured visibly, padded with plain spaces.
    const labelLen = visible(parts[0]!.split(" ")[0] ?? "");
    return [parts[0]!.replace(" ", " ".repeat(Math.max(1, GUTTER - labelLen + 1))), ...parts.slice(1)].join(SEP);
  };
  if (cols > 0) {
    for (const name of row.drop) {
      const parts = present();
      if (!parts.length || visible(render(parts)) <= cols) break;
      seg.delete(name);
    }
  }
  const parts = present();
  if (!parts.length) continue;
  if (parts.length === 1 && row.keys.includes("clock") && seg.has("clock") && parts[0] === seg.get("clock")) continue;
  console.log(render(parts));
}
