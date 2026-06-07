// Plugin install: fetch a plugin package and copy its shipped files into the user's project.
//
// Why copy (not symlink, not run-from-node_modules): Claude Code's `@import` in CLAUDE.local.md
// resolves files ONLY inside the project root, never node_modules. So a plugin's agent.md must
// physically live at projectRoot/plugins/<name>/agent.md. We copy the whole shipped tree there, so
// the project dir is self-contained, offline, and rm-able — npm is just the transport.
//
// One code path for both sources: `npm pack <spec>` accepts a registry name OR a local dir and emits
// a tarball of EXACTLY the package's files[] (built check.js, agent.md, seed dirs — never src/ or
// tests). We extract it and copy, minus the npm manifest. `--from <dir>` is how you install a plugin
// before it is published, and how the monorepo wires its own plugins.
import { existsSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Official plugin names, for `plugin list` discovery when nothing is installed yet. A hint string,
// NOT a registry: each maps by convention to the npm package `imprint-plugin-<name>`. Adding an
// official plugin is a one-line edit here; core fetches nothing to produce this list.
export const OFFICIAL = ["anti-slop", "character", "whenful", "guard"];

export type InstallResult = { copied: boolean; dest: string; skipped?: boolean; error?: string };

// Fetch `imprint-plugin-<name>` (or a local dir via `from`) and copy its shipped files into
// projectRoot/plugins/<name>/. Idempotent: an existing plugins/<name>/agent.md skips the fetch
// unless `force`. Returns what happened; the caller wires the @import line separately.
export function installPlugin(
  projectRoot: string,
  name: string,
  opts: { from?: string; force?: boolean } = {},
): InstallResult {
  const dest = join(projectRoot, "plugins", name);
  if (existsSync(join(dest, "agent.md")) && !opts.force) return { copied: false, dest, skipped: true };

  const spec = opts.from ? resolve(opts.from) : `imprint-plugin-${name}`;
  if (opts.from && !existsSync(spec)) return { copied: false, dest, error: `--from path not found: ${spec}` };

  const tmp = mkdtempSync(join(tmpdir(), "imprint-pkg-"));
  try {
    const pack = spawnSync("npm", ["pack", spec, "--pack-destination", tmp, "--silent"], { encoding: "utf8" });
    if (pack.status !== 0) {
      const why = (pack.stderr || "").trim() || (pack.error ? String(pack.error.message) : `exit ${pack.status}`);
      return { copied: false, dest, error: `npm pack failed for ${spec}: ${why}` };
    }
    const tgz = pack.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    if (!tgz) return { copied: false, dest, error: `npm pack produced no tarball for ${spec}` };

    const ex = spawnSync("tar", ["-xzf", join(tmp, tgz), "-C", tmp], { encoding: "utf8" });
    if (ex.status !== 0) return { copied: false, dest, error: `tar extract failed: ${(ex.stderr || "").trim()}` };

    const src = join(tmp, "package"); // npm tarballs always root at package/
    if (!existsSync(join(src, "agent.md"))) {
      return { copied: false, dest, error: `${spec} has no agent.md — not an imprint plugin?` };
    }
    // Mirror today's hand-authored plugin layout: agent.md + check.js + seed dirs, no package.json.
    // force:true is required: bun's cpSync skips overwrites when a filter is present unless it is set.
    cpSync(src, dest, { recursive: true, force: true, filter: (s) => basename(s) !== "package.json" });
    return { copied: true, dest };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Delete an installed plugin's dir (the `rm -rf plugins/<name>` the contract describes, as a flag).
// Guarded: never touches a _-prefixed dir (the private cast) and a missing dir is a clean no-op.
export function purgePlugin(projectRoot: string, name: string): boolean {
  if (name.startsWith("_")) return false;
  const dir = join(projectRoot, "plugins", name);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
