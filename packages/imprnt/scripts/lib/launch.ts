// The imp front door — assemble the per-session context and spawn `claude`.
//
// Bare `imp` = claude in cwd, plus the user's enabled cast and the vault pointer injected via
// --append-system-prompt, plus --add-dir on the vault project so recall hits read without
// permission prompts. `imp lair` = the same spawn with cwd set to the vault project, where
// CLAUDE.md and CLAUDE.local.md load natively — so nothing is injected there (injecting would
// double-load the cast). The full vault contract is never injected anywhere: the pointer tells
// the agent to run `imprnt context` before writing, the same frequency rule as the engine.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
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
  const tpl = readFileSync(join(pkgRoot, "templates", "pointer.md"), "utf8");
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

// Pure assembly of the spawn inputs (args + env), separated from the spawn so tests can assert
// the exact composition. Inside the vault project the project cast is NOT injected (it loads
// natively from cwd), but the global cast IS - globals live in <globalDir>/imprnt/, not in the
// project's CLAUDE.local.md, so claude never loads them on its own anywhere. With no vault
// registered, claude runs plain (no project, no pointer) but globals still ride: imprnt only ever
// affects imp sessions, and a global module is exactly "every imp session".
export function buildLaunch(opts: {
  cwd: string;
  vaultProject?: string;
  pkgRoot: string;
  passthrough?: string[];
  globalDir?: string;
}): { args: string[]; env: NodeJS.ProcessEnv } {
  const pass = [...(opts.passthrough ?? [])];
  const globalDir = opts.globalDir ?? defaultGlobalDir();
  // Dedupe: a plugin enabled both project-locally and globally must inject once. The project cast is
  // only injected on the OUTSIDE branch (inside loads it natively), so dedupe only matters there;
  // pass the project's enabled names as the skip set so the global pass drops a name already wired
  // project-locally. Inside/lair has no project-cast injection, so nothing to skip.
  if (!opts.vaultProject) {
    // No vault: plain claude + globals. mergeFragment handles the --append-system-prompt plumbing.
    const globals = globalFragment(globalDir);
    if (!globals) return { args: pass, env: process.env };
    return { args: mergeFragment(pass, globals, []), env: process.env };
  }
  // A resolved project that is missing or a plain file (a stale IMPRNT_ROOT, a moved dir) must
  // not get injected - the pointer would advertise a phantom vault and shadow reality. Warn and
  // fall back to plain claude, same shape as nothing-registered. `imp lair` keeps its hard error.
  if (!isDir(opts.vaultProject)) {
    console.error(`imp: vault project not found at ${opts.vaultProject} - launching plain claude (re-run \`imprnt init\` there, or fix IMPRNT_ROOT)`);
    return { args: pass, env: process.env };
  }
  // Harness plugins (a guard hook, a statusline) load ONLY through these flags — Claude Code never
  // auto-discovers plugins/<name>/ — so unlike the cast fragment they ride every imp launch, inside
  // the project included. PREPENDED, so a user-passed --settings comes later and wins (claude keeps
  // the last occurrence of a single-value flag); --plugin-dir is repeatable, position is moot.
  const harness = harnessFlags(opts.vaultProject);
  // The project plugins enabled in this vault's CLAUDE.local.md. Used to dedupe globals: a plugin
  // enabled BOTH project-locally and globally must inject once, so the global pass skips a name that
  // the project cast already carries (outside) / loads natively (inside).
  const projectPlugins = new Set(enabledPluginDirs(opts.vaultProject));
  // Inside the project (root or any subdir) the project prompt + pointer load natively, so injecting
  // those would double the cast - but globals live in <globalDir>/imprnt/, NOT in this project, so
  // claude never loads them on its own here; imp must still inject them (deduped against the project
  // plugins claude already loaded natively). The env is set either way (a subdir cwd strands the
  // engine's ./vault default).
  if (isInside(opts.cwd, opts.vaultProject)) {
    const globals = globalFragment(globalDir, projectPlugins);
    const args = globals ? mergeFragment(pass, globals, []) : pass;
    return { args: [...harness, ...args], env: childEnv(opts.vaultProject) };
  }

  // Outside: inject the project cast + pointer, then the globals (deduped), then point --add-dir at
  // the vault. One combined fragment so a user --append-system-prompt is merged into once.
  const globals = globalFragment(globalDir, projectPlugins);
  const fragment = [castFragment(opts.vaultProject), pointerFragment(opts.pkgRoot, opts.vaultProject), globals]
    .filter(Boolean)
    .join("\n\n");
  const args = mergeFragment(pass, fragment, ["--add-dir", opts.vaultProject]);
  return { args: [...harness, ...args], env: childEnv(opts.vaultProject) };
}

// Spawn claude interactively and hand back its exit code. The two failure modes a novice
// actually hits get a real message; everything else streams through inherited stdio.
export function launchClaude(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  // A dead cwd surfaces as ENOENT from spawnSync (masquerading as "claude missing") and a
  // plain-file cwd as ENOTDIR (blaming claude for a vault-path problem) - catch both first with
  // the fix that actually applies.
  if (!isDir(cwd)) {
    console.error(`imp: vault project not found at ${cwd} — re-run \`imprnt init\` in its new location (add --register to switch the default)`);
    return 1;
  }
  const r = spawnSync("claude", args, { cwd, stdio: "inherit", env });
  if (r.error) {
    const code = (r.error as NodeJS.ErrnoException).code;
    console.error(
      code === "ENOENT"
        ? "imp: `claude` not found on PATH. Install Claude Code first: npm i -g @anthropic-ai/claude-code"
        : `imp: failed to launch claude: ${r.error.message}`,
    );
    return 1;
  }
  // status is null when claude died to a signal — that is not a success.
  return r.status ?? 1;
}
