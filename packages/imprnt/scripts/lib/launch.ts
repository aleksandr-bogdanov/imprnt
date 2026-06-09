// The imp front door — assemble the per-session context and spawn `claude`.
//
// Bare `imp` = claude in cwd, plus the user's enabled cast and the vault pointer injected via
// --append-system-prompt, plus --add-dir on the vault project so recall hits read without
// permission prompts. `imp lair` = the same spawn with cwd set to the vault project, where
// CLAUDE.md and CLAUDE.local.md load natively — so nothing is injected there (injecting would
// double-load the cast). The full vault contract is never injected anywhere: the pointer tells
// the agent to run `imprnt context` before writing, the same frequency rule as the engine.
import { existsSync, readFileSync } from "node:fs";
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
  return tpl.replaceAll("{{VAULT_PROJECT}}", vaultProject);
}

export function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  return c === p || c.startsWith(p + sep);
}

// Pure assembly of the spawn inputs (args + env), separated from the spawn so tests can assert
// the exact composition. Inside the vault project (or with no vault registered) nothing is
// injected and the env is untouched: claude runs as-is and context loads natively from cwd.
export function buildLaunch(opts: {
  cwd: string;
  vaultProject?: string;
  pkgRoot: string;
  passthrough?: string[];
}): { args: string[]; env: NodeJS.ProcessEnv } {
  const pass = [...(opts.passthrough ?? [])];
  if (!opts.vaultProject || isInside(opts.cwd, opts.vaultProject)) return { args: pass, env: process.env };

  const fragment = [castFragment(opts.vaultProject), pointerFragment(opts.pkgRoot, opts.vaultProject)]
    .filter(Boolean)
    .join("\n\n");
  // A user-supplied --append-system-prompt would collide with ours (claude keeps one value per
  // single-value flag), so merge the fragment into theirs instead of adding a second flag.
  const i = pass.indexOf("--append-system-prompt");
  const args =
    i >= 0 && pass[i + 1] !== undefined
      ? [...pass.slice(0, i + 1), pass[i + 1] + "\n\n" + fragment, ...pass.slice(i + 2), "--add-dir", opts.vaultProject]
      : [...pass, "--append-system-prompt", fragment, "--add-dir", opts.vaultProject];

  // The agent inside this session runs engine commands (`imprnt recall`), and those default to
  // ./vault relative to cwd — the coding repo, not the vault. Point the child session's env at
  // the real vault so the pointer's advertised commands actually work. An IMPRNT_VAULT the user
  // set themselves stays untouched (it already steered vaultProject resolution upstream).
  const env =
    process.env.IMPRNT_VAULT || process.env.IMPRINT_VAULT
      ? process.env
      : { ...process.env, IMPRNT_VAULT: join(opts.vaultProject, "vault") };
  return { args, env };
}

// Spawn claude interactively and hand back its exit code. The two failure modes a novice
// actually hits get a real message; everything else streams through inherited stdio.
export function launchClaude(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): number {
  // A dead cwd also surfaces as ENOENT from spawnSync and would masquerade as "claude missing" —
  // catch it first with the fix that actually applies.
  if (!existsSync(cwd)) {
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
