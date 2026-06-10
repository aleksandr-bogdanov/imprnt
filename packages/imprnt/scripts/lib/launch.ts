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
import { importTargets } from "./plugins.ts";

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
// A dangling import warns and is skipped (mirroring Claude Code's tolerance), never aborts.
export function castFragment(root: string): string {
  const parts: string[] = [];
  for (const target of importTargets(root)) {
    const p = importPath(root, target);
    if (!existsSync(p)) {
      console.error(`imp: skipping missing import @${target}`);
      continue;
    }
    parts.push(readFileSync(p, "utf8").trim());
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
// set themselves stays untouched (it already steered vaultProject resolution upstream). Exported
// so `imp lair` gets the SAME env as the exact-root launch - lair lands at the root cwd, where an
// in-session cd would otherwise strand the engine's ./vault default just like a subdir launch.
export function childEnv(vaultProject: string): NodeJS.ProcessEnv {
  return process.env.IMPRNT_VAULT || process.env.IMPRINT_VAULT
    ? process.env
    : { ...process.env, IMPRNT_VAULT: join(vaultProject, "vault") };
}

// Pure assembly of the spawn inputs (args + env), separated from the spawn so tests can assert
// the exact composition. Inside the vault project (or with no vault registered) nothing is
// injected: claude runs as-is and context loads natively from cwd.
export function buildLaunch(opts: {
  cwd: string;
  vaultProject?: string;
  pkgRoot: string;
  passthrough?: string[];
}): { args: string[]; env: NodeJS.ProcessEnv } {
  const pass = [...(opts.passthrough ?? [])];
  if (!opts.vaultProject) return { args: pass, env: process.env };
  // A resolved project that is missing or a plain file (a stale IMPRNT_ROOT, a moved dir) must
  // not get injected - the pointer would advertise a phantom vault and shadow reality. Warn and
  // fall back to plain claude, same shape as nothing-registered. `imp lair` keeps its hard error.
  if (!isDir(opts.vaultProject)) {
    console.error(`imp: vault project not found at ${opts.vaultProject} - launching plain claude (re-run \`imprnt init\` there, or fix IMPRNT_ROOT)`);
    return { args: pass, env: process.env };
  }
  // Inside the project (root or any subdir) the prompt loads natively, so injecting would double
  // the cast - but a subdir cwd still strands the engine's ./vault default, so the env (not a
  // prompt injection) is set either way. The exact root gets it too: one uniform rule.
  if (isInside(opts.cwd, opts.vaultProject)) return { args: pass, env: childEnv(opts.vaultProject) };

  const fragment = [castFragment(opts.vaultProject), pointerFragment(opts.pkgRoot, opts.vaultProject)]
    .filter(Boolean)
    .join("\n\n");
  // A user-supplied --append-system-prompt would collide with ours (claude keeps one value per
  // single-value flag), so merge the fragment into theirs instead of adding a second flag -
  // matching both the `--flag value` and the `--flag=value` spellings, last occurrence wins
  // (mirroring how claude resolves a repeated flag).
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
    // exact flag). imp is a thin launcher, not a reimplementation of claude's parser, so this
    // guards the realistic free-text-value flags rather than enumerating every claude flag.
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
  // Inject before a `--` terminator if the user passed one: everything after `--` is positional
  // prompt text to claude, so flags appended past it would be read as prompt and --add-dir lost.
  // No terminator -> append at the end (the round-1 shape).
  const term = args.indexOf("--");
  const inject = merged ? ["--add-dir", opts.vaultProject] : ["--append-system-prompt", fragment, "--add-dir", opts.vaultProject];
  if (term >= 0) args.splice(term, 0, ...inject);
  else args.push(...inject);

  return { args, env: childEnv(opts.vaultProject) };
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
