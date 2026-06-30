// The imp front door — assemble the per-session context and spawn `claude`.
//
// Bare `imp` = claude in cwd, plus the user's enabled cast and the vault pointer injected via
// --append-system-prompt, plus --add-dir on the vault project so recall hits read without
// permission prompts. `imp lair` = the same spawn with cwd set to the vault project, where
// CLAUDE.md and CLAUDE.local.md load natively — so nothing is injected there (injecting would
// double-load the cast). The full vault contract is never injected anywhere: the pointer tells
// the agent to run `imprnt context` before writing, the same frequency rule as the engine.
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { enabledPluginDirs, entryExists, importTargets } from "./plugins.ts";
import { globalFragment } from "./global.ts";

// Resolve one @import target the way Claude Code does: absolute stays absolute, ~/ expands to
// the home dir, everything else is project-relative.
function importPath(root: string, target: string): string {
  if (target.startsWith("~/")) return join(homedir(), target.slice(2));
  if (isAbsolute(target)) return target;
  return join(root, target);
}

// Inline every enabled @import from the vault project's CLAUDE.local.md — the same fragments
// Claude Code would load natively inside the project. The line format is parsed in ONE place
// (plugins.ts importTargets, the module that also writes those lines). Commented lines stay off.
// A dangling import warns and is skipped (mirroring Claude Code's tolerance), never aborts. The same
// holds for a target that EXISTS but cannot be read - a directory named *.md (EISDIR) or a chmod-000
// file (EACCES). readFileSync throws on those, so guard it and skip with the same warn+continue shape
// as the missing case, never letting a bad wire-in crash the launch.
export function castFragment(root: string): string {
  const parts: string[] = [];
  for (const target of importTargets(root)) {
    const p = importPath(root, target);
    if (!existsSync(p)) {
      console.error(`imp: skipping missing import @${target}`);
      continue;
    }
    try {
      parts.push(readFileSync(p, "utf8").trim());
    } catch {
      console.error(`imp: skipping unreadable import @${target}`);
    }
  }
  return parts.join("\n\n");
}

// The ~150-token pointer: what exists, when to recall, and the one entry point for writing.
// Lives in templates/ so it ships with the package and stays editable without a code change.
export function pointerFragment(pkgRoot: string, vaultProject: string): string {
  // assembleSession now computes the pointer for EVERY live-vault launch (so a backend that does not
  // load it natively, like gemini, can inject it), inside the project included - where the pre-seam
  // launcher never read it. A missing template (a broken install, a test sandbox that ships no
  // templates/) must therefore degrade to no-pointer with a warning, never hard-crash the launch -
  // the same tolerance castFragment has for a missing import. In a real install the template always
  // ships, so this never fires there.
  let tpl: string;
  try {
    tpl = readFileSync(join(pkgRoot, "templates", "pointer.md"), "utf8");
  } catch {
    console.error(`imp: pointer template missing at ${join(pkgRoot, "templates", "pointer.md")} - launching without the vault pointer`);
    return "";
  }
  // Function replacement: a string replacement runs $-pattern substitution, so a path with $$
  // would render corrupted ($$ collapses to $) and the pointer would advertise a phantom path.
  return tpl.replaceAll("{{VAULT_PROJECT}}", () => vaultProject);
}

// Every string value in a parsed settings fragment, with ${PLUGIN_DIR} replaced by the plugin's
// absolute dir. ${CLAUDE_PLUGIN_ROOT} is accepted as an alias: it is the native spelling a plugin
// author already writes in hooks.json (where Claude Code expands it), and both name the same dir
// here, so using either in either file works instead of failing silently as a literal string.
// Substituting AFTER the parse (not in the raw text) keeps a path with JSON-special characters
// (a backslash, a quote) from corrupting the document.
function substitutePluginDir(value: unknown, dir: string): unknown {
  if (typeof value === "string")
    return value.replaceAll("${PLUGIN_DIR}", dir).replaceAll("${CLAUDE_PLUGIN_ROOT}", dir);
  if (Array.isArray(value)) return value.map((v) => substitutePluginDir(v, dir));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substitutePluginDir(v, dir)]),
    );
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

// Merge fragment b over a: objects merge recursively, anything else (scalar, array) replaces.
// Later-wired plugins win on a key conflict, matching how Claude Code resolves its own settings
// scopes (the later, more specific scope overrides).
function mergeSettings(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = isPlainObject(prev) && isPlainObject(v) ? mergeSettings(prev, v) : v;
  }
  return out;
}

// The harness-plugin flags for one launch: a `--plugin-dir` per enabled plugin that is a native
// Claude Code plugin (carries .claude-plugin/plugin.json — hooks, skills, commands load from it),
// plus ONE merged `--settings` JSON assembled from every enabled plugin's imp-settings.json (the
// fragment for keys Claude only accepts via settings: a statusLine command, spinnerVerbs). Both are
// discovered by filename convention off the SAME enable list the cast inliner reads (the @import
// lines of CLAUDE.local.md), so "enabled" can never mean two different things. A fragment may write
// ${PLUGIN_DIR} where it needs its own absolute path (a statusLine command must run from any cwd).
// A malformed fragment warns and is skipped — same tolerance as a dangling @import, never a crash.
export function harnessFlags(root: string): string[] {
  const flags: string[] = [];
  let settings: Record<string, unknown> = {};
  for (const name of enabledPluginDirs(root)) {
    const dir = join(root, "plugins", name);
    if (entryExists(root, `plugins/${name}/.claude-plugin/plugin.json`)) flags.push("--plugin-dir", dir);
    if (!entryExists(root, `plugins/${name}/imp-settings.json`)) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(dir, "imp-settings.json"), "utf8"));
      if (!isPlainObject(parsed)) throw new Error("not a JSON object");
      settings = mergeSettings(settings, substitutePluginDir(parsed, dir) as Record<string, unknown>);
    } catch (e) {
      console.error(
        `imp: skipping bad settings fragment plugins/${name}/imp-settings.json: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  if (Object.keys(settings).length) flags.push("--settings", JSON.stringify(settings));
  return flags;
}

// Realpath when the path exists, plain resolve when it doesn't - inside-detection must see
// through symlinks (macOS /tmp -> /private/tmp, Dropbox/iCloud aliases), or a symlink-spelled
// IMPRNT_ROOT defeats it and imp injects on top of claude's native CLAUDE.md load.
function realResolve(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

export function isInside(child: string, parent: string): boolean {
  const c = realResolve(child);
  const p = realResolve(parent);
  return c === p || c.startsWith(p + sep);
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// The agent inside the child session runs engine commands (`imprnt recall`), and those default
// to ./vault relative to cwd - which is only right at the project root itself. Point the child
// env at the real vault so the advertised commands work from anywhere. An IMPRNT_VAULT the user
// set themselves stays untouched (it already steered vaultProject resolution upstream). Every
// launch shape gets this through buildLaunch - `imp lair` included, it IS the exact-root launch.
function childEnv(vaultProject: string): NodeJS.ProcessEnv {
  return process.env.IMPRNT_VAULT || process.env.IMPRINT_VAULT
    ? process.env
    : { ...process.env, IMPRNT_VAULT: join(vaultProject, "vault") };
}

// The default global config dir Claude Code reads (and where imprnt copies its global modules):
// $CLAUDE_CONFIG_DIR || ~/.claude. Resolved here so buildLaunch can default it, while tests pass an
// explicit tmp dir. Globals are imprnt-owned and live at <globalDir>/imprnt/ - never in CLAUDE.md.
export function defaultGlobalDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

// Inject `fragment` into the args' --append-system-prompt, plus any `extraInject` flags (e.g.
// `--add-dir <vault>`). A user-supplied --append-system-prompt would collide with ours (claude keeps
// one value per single-value flag), so MERGE the fragment into theirs rather than add a second flag,
// matching both the `--flag value` and the `--flag=value` spellings (last occurrence wins, mirroring
// how claude resolves a repeated flag). When no user flag exists, the fragment rides as its own
// `--append-system-prompt <fragment>`. Everything respects the `--` terminator: flags injected past
// it would read as positional prompt text and be lost, so they go BEFORE the first `--`. Returns a
// fresh args array; `fragment` is assumed non-empty (callers guard the empty case).
function mergeFragment(pass: string[], fragment: string, extraInject: string[]): string[] {
  const args = [...pass];
  // Everything from the first `--` on is positional prompt text to claude, never a flag, so the
  // merge scan stops there - a `-- --append-system-prompt=...` positional must not be merged into.
  const firstTerm = args.indexOf("--");
  const scanEnd = firstTerm >= 0 ? firstTerm - 1 : args.length - 1;
  let merged = false;
  for (let i = scanEnd; i >= 0 && !merged; i--) {
    // A token in VALUE position (the arg after a value-consuming flag like -p) is the user's text,
    // not a flag - a -p value that merely starts with "--append-system-prompt=" must not be glued
    // onto. The space-form below is already value-safe (it reads args[i+1] only when args[i] is the
    // exact flag).
    const prev = args[i - 1];
    // --add-dir consumes an arbitrary PATH as its value (and imp passes one too), so a user dir
    // named "--append-system-prompt=..." must read as that path, never as the flag. The other
    // entries are claude's free-text value flags. Keep this to the realistic value-consuming flags,
    // not a full mirror of claude's parser - imp is a thin launcher.
    const inValuePosition =
      prev === "-p" ||
      prev === "--print" ||
      prev === "--append-system-prompt" ||
      prev === "--system-prompt" ||
      prev === "--add-dir";
    if (args[i] === "--append-system-prompt" && args[i + 1] !== undefined) {
      args[i + 1] += "\n\n" + fragment;
      merged = true;
    } else if (!inValuePosition && args[i]!.startsWith("--append-system-prompt=")) {
      args[i] += "\n\n" + fragment;
      merged = true;
    }
  }
  // Inject before a `--` terminator if the user passed one (see above). No terminator -> append at
  // the end. When merged into a user flag, only the extra flags need injecting (the fragment already
  // landed); otherwise the fragment rides as its own flag ahead of the extras.
  const term = args.indexOf("--");
  const inject = merged ? extraInject : ["--append-system-prompt", fragment, ...extraInject];
  if (!inject.length) return args;
  if (term >= 0) args.splice(term, 0, ...inject);
  else args.push(...inject);
  return args;
}

// ── The agent-backend seam ──────────────────────────────────────────────────
// A launch has two halves. assembleSession() is the NEUTRAL half: it gathers the raw materials a
// session needs (the cast / pointer / globals fragments, the working dirs, the plugins, the env) and
// names no vendor. A Backend is the EDGE half: it knows ONE agent's native behavior - which of those
// fragments the agent loads on its own, and how the rest reach it - and renders the invocation.
// claude loads the project cast + pointer natively from cwd when you are inside the vault, so its
// renderer injects only what is NOT already loaded; gemini loads nothing from the vault, so its
// renderer injects the whole fragment through a generated GEMINI.md. Same spec, two renderers, zero
// vendor knowledge in assembleSession - a grep for a vendor name inside it must come back empty.
export type SessionSpec = {
  // The project cast (CLAUDE.local.md @imports, inlined), "" when none. A backend that loads it
  // natively (claude, inside the project) drops it; one that does not (gemini) injects it.
  cast: string;
  // The ~150-token vault pointer, "" when no vault. Same native-vs-injected split as the cast.
  pointer: string;
  // The global behavior modules (deduped against the project plugins), "" when none. NO agent loads
  // these on its own (they live in the host config dir, not the project), so every backend injects
  // them on every launch.
  globals: string;
  // cwd is inside the vault project, so an agent that auto-loads project context from cwd already
  // has the cast + pointer. The neutral fact; each backend decides what it means for injection.
  insideProject: boolean;
  // Extra working dirs the agent should read without a prompt: the vault project, launched from
  // outside it. Empty inside (cwd covers it) and with no vault.
  addDirs: string[];
  // The vault project root WHEN live, so a backend can act on its enabled plugins: claude renders
  // them as --plugin-dir + --settings; gemini has no host for harness plugins, so it only detects
  // them to warn-and-skip. Undefined on the no-vault / phantom paths.
  pluginsRoot?: string;
  // Run without permission prompts. Each backend maps it to its own flag (claude:
  // --dangerously-skip-permissions; gemini: --yolo + --skip-trust). Resolved by resolveLaunch
  // (flag > env > per-machine config > off), so the SHIPPED default is safe - a fresh install
  // prompts, and only a machine where git + snapshots are the net opts in.
  skipPermissions: boolean;
  // The per-machine default model (a backend alias like `pro`, or a full id), or undefined to let
  // the agent use its own default. A backend that takes a model (gemini, via -m) expands the alias
  // and injects it when the user did not pass their own -m; others ignore it.
  model?: string;
  env: NodeJS.ProcessEnv;
  passthrough: string[];
};

// The neutral half: gather the session's raw materials, vendor-free. The cast + pointer are computed
// whenever there is a live vault (even inside it) so a backend that does NOT load them natively can
// still inject them; a backend that DOES (claude inside) just ignores them. Globals are always
// gathered and always injected by every backend. The project plugins are the dedupe skip-set so a
// plugin enabled BOTH project-locally and globally contributes its global copy zero extra times.
export function assembleSession(opts: {
  cwd: string;
  vaultProject?: string;
  pkgRoot: string;
  passthrough?: string[];
  globalDir?: string;
  skipPermissions?: boolean;
  model?: string;
}): SessionSpec {
  const passthrough = [...(opts.passthrough ?? [])];
  const globalDir = opts.globalDir ?? defaultGlobalDir();
  const skipPermissions = opts.skipPermissions ?? false;
  const base = { cast: "", pointer: "", insideProject: false, addDirs: [] as string[], skipPermissions, model: opts.model, passthrough };
  // No vault registered: a plain session, globals only (may be "").
  if (!opts.vaultProject) {
    return { ...base, globals: globalFragment(globalDir) || "", env: process.env };
  }
  // A resolved project that is missing or a plain file (a stale IMPRNT_ROOT, a moved dir) must not
  // get injected - the pointer would advertise a phantom vault and shadow reality. Warn and fall back
  // to a plain session with NO globals, matching the pre-seam phantom path. `imp lair` keeps its hard
  // error elsewhere.
  if (!isDir(opts.vaultProject)) {
    console.error(`imp: vault project not found at ${opts.vaultProject} - launching a plain session (re-run \`imprnt init\` there, or fix IMPRNT_ROOT)`);
    return { ...base, globals: "", env: process.env };
  }
  const projectPlugins = new Set(enabledPluginDirs(opts.vaultProject));
  const inside = isInside(opts.cwd, opts.vaultProject);
  // Inside: cast + pointer ride in the spec too (a non-native backend needs them), but addDirs stays
  // empty - cwd already covers the vault. Outside: add the vault as a readable working dir.
  return {
    cast: castFragment(opts.vaultProject),
    pointer: pointerFragment(opts.pkgRoot, opts.vaultProject),
    globals: globalFragment(globalDir, projectPlugins) || "",
    insideProject: inside,
    addDirs: inside ? [] : [opts.vaultProject],
    pluginsRoot: opts.vaultProject,
    skipPermissions,
    model: opts.model,
    env: childEnv(opts.vaultProject),
    passthrough,
  };
}

// Join the fragments an agent must be GIVEN (vs. loads itself) into one block, cast→pointer→globals,
// dropping empties.
function joinFragments(parts: string[]): string {
  return parts.filter(Boolean).join("\n\n");
}

// The Claude edge. claude loads the project cast + pointer natively from cwd when inside the vault,
// so inside it is handed ONLY the globals; outside it gets the whole fragment. The systemPrompt rides
// --append-system-prompt (merged into a user-passed one, never a second flag); addDirs become
// --add-dir; enabled plugins become harness flags (--plugin-dir + one merged --settings), PREPENDED
// so a user-passed --settings wins. This is the exact composition the pre-seam launcher produced,
// pinned by the suite.
function claudeRenderArgs(spec: SessionSpec): string[] {
  const systemPrompt = spec.insideProject ? spec.globals : joinFragments([spec.cast, spec.pointer, spec.globals]);
  const harness = spec.pluginsRoot ? harnessFlags(spec.pluginsRoot) : [];
  const extra = spec.addDirs.flatMap((d) => ["--add-dir", d]);
  // skip-permissions maps to claude's --dangerously-skip-permissions, prepended so it sits in flag
  // position before any `--` terminator. Skipped if the user already passed it.
  const pass =
    spec.skipPermissions && !spec.passthrough.includes("--dangerously-skip-permissions")
      ? ["--dangerously-skip-permissions", ...spec.passthrough]
      : spec.passthrough;
  const body = systemPrompt ? mergeFragment(pass, systemPrompt, extra) : [...pass, ...extra];
  return [...harness, ...body];
}

// Back-compat wrapper: the pre-seam entry point, now assemble-then-render-for-claude. Kept so the
// existing tests that pin the exact arg composition stay green; live call sites resolve a backend.
export function buildLaunch(opts: {
  cwd: string;
  vaultProject?: string;
  pkgRoot: string;
  passthrough?: string[];
  globalDir?: string;
}): { args: string[]; env: NodeJS.ProcessEnv } {
  const spec = assembleSession(opts);
  return { args: claudeRenderArgs(spec), env: spec.env };
}

// ── Backends ─────────────────────────────────────────────────────────────────
// A Backend renders a neutral SessionSpec into one agent's invocation. Adding a third (codex, a
// local model) is a new entry + a line in `backends`, with ZERO change to assembleSession - the
// litmus the vault already holds plugins to, one layer up. The spawn itself (launchBackend) is
// generic: every backend is `spawnSync(backend.name, ...)`, so the binary name is the only thing
// that differs there.
export interface Backend {
  readonly name: string;
  // The one-line install hint shown when the binary is not on PATH.
  readonly missingHint: string;
  renderArgs(spec: SessionSpec): string[];
  // Optional interactive pre-launch hook: resolve a session-resume request into concrete args (e.g.
  // a chat picker) before renderArgs runs. The dispatcher calls it generically, so the gemini-only
  // picker lives at the gemini edge, not in the launcher's neutral path. A backend without it keeps
  // its passthrough as-is.
  resolveResume?(passthrough: string[], cwd: string): Promise<string[]>;
}

export const claudeBackend: Backend = {
  name: "claude",
  missingHint: "Install Claude Code first: npm i -g @anthropic-ai/claude-code",
  renderArgs: claudeRenderArgs,
};

// Short aliases for the gemini models, so a user types `imp --gemini -m pro` (or `imprnt model pro`)
// instead of the full id. A value that is not an alias passes through unchanged, so a full id always
// works and a new model is usable before this map learns it. Vendor data, so it lives at the edge.
export const GEMINI_MODEL_ALIASES: Record<string, string> = {
  pro: "gemini-3.1-pro-preview",
  flash: "gemini-3.5-flash",
  pro25: "gemini-2.5-pro",
  lite: "gemini-3.1-flash-lite",
  gemma31: "gemma-4-31b-it",
  gemma26: "gemma-4-26b-a4b-it",
};
function expandGeminiModel(m: string): string {
  return GEMINI_MODEL_ALIASES[m] ?? m;
}

// gemini reads `@token` in a context file as a file-import directive, so a literal @ in the cast (an
// @handle like @aemilius211, an email) makes it try to import a nonexistent file and log an error.
// The generated GEMINI.md has NO intentional imports (castFragment already inlined them), so escape
// every @ as `\@`, which gemini treats as a literal and does not import (verified against the CLI).
function escapeGeminiImports(text: string): string {
  return text.replaceAll("@", "\\@");
}

// The Gemini edge. gemini has no --append-system-prompt: its native context channel is a GEMINI.md
// the CLI discovers in every workspace directory (verified - a GEMINI.md in an --include-directories
// dir loads as memory, @imports inlined and all). So the whole fragment (cast + pointer + globals,
// since gemini loads none of it from the vault) is written to a throwaway GEMINI.md in a temp dir,
// and that dir is added to the workspace alongside the vault: the user's cwd is never written to.
// The temp dir is removed on process exit. claude-only harness plugins (statusline, timemachine)
// have no gemini host, so they are skipped with one honest line, never silently.
function geminiRenderArgs(spec: SessionSpec): string[] {
  const includes: string[] = [];
  const systemPrompt = joinFragments([spec.cast, spec.pointer, spec.globals]);
  if (systemPrompt) {
    const dir = mkdtempSync(join(tmpdir(), "imprnt-gemini-"));
    writeFileSync(join(dir, "GEMINI.md"), escapeGeminiImports(systemPrompt) + "\n");
    process.on("exit", () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: the OS reaps its tmp dir eventually
      }
    });
    includes.push(dir);
  }
  includes.push(...spec.addDirs);
  if (spec.pluginsRoot && harnessFlags(spec.pluginsRoot).length) {
    console.error("imp: gemini does not host claude harness plugins (statusline, timemachine) - skipping them");
  }
  // skip-permissions on gemini means no gates at all: --yolo auto-approves every tool, and
  // --skip-trust clears the workspace-trust prompt (a gate too). Each added only when not already
  // passed (-y is gemini's short form of --yolo).
  const lead: string[] = [];
  if (spec.skipPermissions) {
    if (!spec.passthrough.includes("--yolo") && !spec.passthrough.includes("-y")) lead.push("--yolo");
    if (!spec.passthrough.includes("--skip-trust")) lead.push("--skip-trust");
  }
  // Model: expand an alias to the full id in a user-passed -m/--model (space OR equals form), else
  // inject the configured default model (alias-expanded). A user-passed model flag of ANY form wins
  // over the configured default; a bare -m with no value is left for gemini to reject clearly.
  const pass = [...spec.passthrough];
  const isModelFlag = (a: string) => a === "-m" || a === "--model" || a.startsWith("-m=") || a.startsWith("--model=");
  const mIdx = pass.findIndex(isModelFlag);
  if (mIdx >= 0) {
    const tok = pass[mIdx]!;
    const eq = tok.indexOf("=");
    if (eq >= 0) pass[mIdx] = tok.slice(0, eq + 1) + expandGeminiModel(tok.slice(eq + 1));
    else if (pass[mIdx + 1] !== undefined) pass[mIdx + 1] = expandGeminiModel(pass[mIdx + 1]!);
  } else if (spec.model) {
    pass.unshift("-m", expandGeminiModel(spec.model));
  }
  // Resume: the interactive chat picker (geminiResolveResume) owns `imp -r` and fills in the chosen
  // session before this runs. This renderer branch is only the NON-interactive fallback: gemini's
  // --resume needs a value, so a still-value-less -r/--resume here means "resume the most recent".
  // An explicit -r <value> (or the --resume=x form) is left untouched.
  const rIdx = valuelessResumeIndex(pass);
  if (rIdx >= 0) pass.splice(rIdx + 1, 0, "latest");
  // --include-directories takes a comma-separated list, so one flag carries the context dir + vault.
  const flags = includes.length ? ["--include-directories", includes.join(",")] : [];
  return [...lead, ...flags, ...pass];
}

export const geminiBackend: Backend = {
  name: "gemini",
  missingHint: "Install the Gemini CLI first: npm i -g @google/gemini-cli",
  renderArgs: geminiRenderArgs,
  resolveResume: geminiResolveResume,
};

// One row of `gemini --list-sessions`. `name` is the real first user prompt (the useful label),
// `age` a human string ("2 minutes ago"), `id` the session UUID to resume with `-r <id>`.
export type GeminiSession = { index: number; name: string; age: string; id: string };

// Parse `gemini --list-sessions` output into rows. A session line looks like:
//   "  1. how do you know I want you to write (2 minutes ago) [b6965347-c6a8-4fb0-...]"
// gemini's list names each chat by its real first prompt, unlike its /resume browser, which labels
// every chat with the raw <session_context> block (identical garbage across chats). So this is the
// clean source for imp's own picker. The header and blank lines do not match and are skipped. The
// `[uuid]` at the end is the anchor; the name is everything before the trailing `(age) [id]`.
export function parseGeminiSessions(stdout: string): GeminiSession[] {
  const out: GeminiSession[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const m = raw.match(/^\s*(\d+)\.\s+(.+?)\s+\(([^()]+)\)\s+\[([0-9a-fA-F-]{8,})\]\s*$/);
    if (m) out.push({ index: Number(m[1]), name: m[2]!.trim(), age: m[3]!.trim(), id: m[4]! });
  }
  return out;
}

// Index of a -r/--resume that carries NO value (it is the last token, or the next token is another
// flag), else -1. The two resume paths share this one predicate: geminiResolveResume fills the value
// interactively from a pick, and geminiRenderArgs fills it with "latest" non-interactively, so they
// can never drift on what "value-less" means.
export function valuelessResumeIndex(args: string[]): number {
  const i = args.findIndex((a) => a === "-r" || a === "--resume");
  if (i < 0) return -1;
  const next = args[i + 1];
  return next === undefined || next.startsWith("-") ? i : -1;
}

// Run `gemini --list-sessions` for the chats of the project at `cwd` (gemini keys sessions by cwd, so
// this lists exactly the chats `imp` made here). `ran` distinguishes "gemini could not run" (binary
// missing — leave the resume request for launchBackend to surface with the real install hint) from a
// genuinely empty list. A non-empty output that parses to zero rows means gemini's list format
// changed: warn so a break is diagnosable, never a silent "you have no chats".
function listGeminiSessions(cwd: string): { sessions: GeminiSession[]; ran: boolean } {
  const r = spawnSync("gemini", ["--list-sessions", "--skip-trust"], { cwd, encoding: "utf8" });
  if (r.error) return { sessions: [], ran: false };
  const stdout = r.stdout || "";
  const sessions = parseGeminiSessions(stdout);
  if (!sessions.length && stdout.trim() && !/\(\s*0\s*\)|no sessions/i.test(stdout)) {
    console.error("imp: couldn't parse gemini's session list (its format may have changed) - starting fresh");
  }
  return { sessions, ran: true };
}

// Render imp's own chat picker to stderr (stdout stays clean) and read a choice. A number resumes
// that chat, Enter resumes the newest, q cancels (start fresh). An out-of-range / non-numeric entry
// falls back to fresh.
async function pickGeminiSession(sessions: GeminiSession[], label: string): Promise<string | null> {
  const cols = process.stdout.columns || 80;
  const nameW = Math.max(20, Math.min(64, cols - 16));
  const trunc = (s: string) => (s.length > nameW ? s.slice(0, nameW - 1) + "…" : s);
  process.stderr.write(`\n  resume a chat - gemini · ${label}\n\n`);
  sessions.forEach((s, i) => {
    process.stderr.write(`  ${String(i + 1).padStart(2)}  ${trunc(s.name).padEnd(nameW)}  ${s.age.replace(/\s*ago$/, "")}\n`);
  });
  process.stderr.write("\n");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question("  number to resume · enter for newest · q to cancel › ")).trim();
  rl.close();
  if (answer === "") return "latest";
  if (answer.toLowerCase() === "q") return null;
  const n = Number(answer);
  if (Number.isInteger(n) && n >= 1 && n <= sessions.length) return sessions[n - 1]!.id;
  process.stderr.write("  not a valid choice - starting a fresh session\n");
  return null;
}

// The gemini resume hook (Backend.resolveResume). On a value-less -r/--resume in an interactive TTY,
// list this project's chats and show imp's own picker, then rewrite the passthrough to resume the
// chosen chat (or drop -r to start fresh). Returned untouched otherwise: an explicit -r <value>, a
// non-interactive run (geminiRenderArgs then defaults to resume-latest), or gemini not being runnable.
async function geminiResolveResume(passthrough: string[], cwd: string): Promise<string[]> {
  const rIdx = valuelessResumeIndex(passthrough);
  if (rIdx < 0) return passthrough;
  if (!(process.stdin.isTTY && process.stdout.isTTY)) return passthrough;
  const { sessions, ran } = listGeminiSessions(cwd);
  if (!ran) return passthrough; // gemini missing - leave -r; launchBackend prints the install hint
  if (!sessions.length) {
    console.error("imp: no saved gemini chats for this project yet - starting fresh");
    return passthrough.filter((_, i) => i !== rIdx);
  }
  const chosen = await pickGeminiSession(sessions, basename(cwd));
  if (chosen === null) return passthrough.filter((_, i) => i !== rIdx); // cancel - fresh session
  const out = [...passthrough];
  out.splice(rIdx + 1, 0, chosen); // the picked id (or "latest" on Enter) becomes the -r value
  return out;
}

export const backends: Record<string, Backend> = {
  claude: claudeBackend,
  gemini: geminiBackend,
};

// Resolve a launch: which backend, whether to skip permission prompts, and the passthrough with
// imp's own selection flags stripped (so the chosen agent never receives `--gemini`/`--yolo`/...).
// Two independent precedence chains, each first-match-wins:
//   backend: --gemini/--claude flag > IMPRNT_AGENT env > config.agent (per-machine) > claude.
//   skip   : --yolo/--safe flag    > IMPRNT_YOLO env  > config.yolo  (per-machine) > off.
// SHIPPED defaults (claude, prompts-on) are the safe ones, so a fresh install is unsurprising and a
// stranger never inherits skip-permissions. An unknown agent falls back to claude with a warning.
export function resolveLaunch(
  passthrough: string[],
  config: { agent?: string; yolo?: boolean } = {},
): { backend: Backend; skipPermissions: boolean; passthrough: string[] } {
  // Stop consuming imp's selection flags at the first `--` terminator: everything from there on is
  // literal prompt text for the agent, so a `--yolo` typed inside a prompt must NOT flip
  // skip-permissions. Scan the head; pass the terminator and tail through untouched.
  const term = passthrough.indexOf("--");
  const head = term < 0 ? passthrough : passthrough.slice(0, term);
  const tail = term < 0 ? [] : passthrough.slice(term);
  let agentFlag: string | undefined;
  let yoloFlag: boolean | undefined;
  const rest: string[] = [];
  for (const a of head) {
    if (a === "--gemini") agentFlag = agentFlag ?? "gemini";
    else if (a === "--claude") agentFlag = agentFlag ?? "claude";
    else if (a === "--yolo") yoloFlag = yoloFlag ?? true;
    else if (a === "--safe") yoloFlag = yoloFlag ?? false;
    else rest.push(a);
  }
  const name = agentFlag ?? process.env.IMPRNT_AGENT ?? config.agent ?? "claude";
  let backend = backends[name];
  if (!backend) {
    console.error(`imp: unknown agent "${name}" - falling back to claude (valid: ${Object.keys(backends).join(", ")})`);
    backend = claudeBackend;
  }
  // IMPRNT_YOLO is a tri-state: present-and-truthy → on, present-and-falsy → off, absent → defer to
  // config. The off-set is generous on purpose (0/false/off/no/"") because the risk is asymmetric:
  // accidentally GRANTING skip-permissions is worse than withholding it, so only an explicit truthy
  // spelling keeps it on.
  const yoloEnv = process.env.IMPRNT_YOLO;
  const envYolo = yoloEnv === undefined ? undefined : !["0", "false", "", "off", "no"].includes(yoloEnv.toLowerCase());
  const skipPermissions = yoloFlag ?? envYolo ?? config.yolo ?? false;
  return { backend, skipPermissions, passthrough: [...rest, ...tail] };
}

// Spawn a resolved backend interactively and hand back its exit code. The cwd guard (a dead or
// plain-file cwd) fires first with the fix that actually applies, never blaming the agent binary;
// a missing binary gets the backend's own install hint. Generic over the backend: the binary name
// is backend.name, everything else streams through inherited stdio.
export function launchBackend(backend: Backend, cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  if (!isDir(cwd)) {
    console.error(`imp: vault project not found at ${cwd} — re-run \`imprnt init\` in its new location (add --register to switch the default)`);
    return 1;
  }
  const r = spawnSync(backend.name, args, { cwd, stdio: "inherit", env });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    console.error(
      code === "ENOENT"
        ? `imp: \`${backend.name}\` not found on PATH. ${backend.missingHint}`
        : `imp: failed to launch ${backend.name}: ${r.error.message}`,
    );
    return 1;
  }
  // status is null when the agent died to a signal — that is not a success.
  return r.status ?? 1;
}

// Back-compat wrapper for the claude spawn: kept so the launch test's cwd-guard assertions stay green
// and any caller still importing it works. New call sites use launchBackend with a resolved backend.
export function launchClaude(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  return launchBackend(claudeBackend, cwd, args, env);
}
