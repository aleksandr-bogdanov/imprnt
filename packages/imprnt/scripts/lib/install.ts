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
import { existsSync, mkdtempSync, cpSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { specError, canonicalSpec } from "./plugins.ts";

// Official plugin names, for `plugin list` discovery when nothing is installed yet. A hint string,
// NOT a registry: each maps by convention to the npm package `imprnt-plugin-<name>`. Adding an
// official plugin is a one-line edit here; core fetches nothing to produce this list.
export const OFFICIAL = ["anti-slop", "character", "timemachine", "statusline"];

export type Channel = "edge" | "latest";

// The running core's release channel, read from its own shipped package.json (the sibling of
// dist/cli.js — npm always ships it, and the publish flow sets the version before building, so an edge
// build's package.json reads e.g. 0.3.3-edge.418). An edge core installs plugins from the matching
// `edge` dist-tag (falling back to latest when a plugin has no edge build), so a bleeding-edge core is
// dogfooded against bleeding-edge plugins. A stable core — or any unreadable/odd version — uses latest.
export function coreChannel(pkgRoot: string): Channel {
  try {
    const v = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version;
    return typeof v === "string" && v.includes("-edge.") ? "edge" : "latest";
  } catch {
    return "latest";
  }
}

// One `npm pack` into tmp; returns the tarball filename or a human error. The spec is a registry name
// (optionally dist-tagged, e.g. imprnt-plugin-anti-slop@edge) or a local dir. No --silent: it swallows
// npm's stderr too, collapsing every failure (404 vs missing package.json vs network down) into a
// bare exit code. The tarball name is still stdout's last line; the notice chatter goes to stderr.
function npmPack(spec: string, tmp: string): { tgz?: string; error?: string } {
  const pack = spawnSync("npm", ["pack", spec, "--pack-destination", tmp], { encoding: "utf8" });
  if (pack.status !== 0) {
    // Keep npm's own error lines (the real reason), drop the notice/log-location noise.
    const errLines = (pack.stderr || "")
      .split(/\r?\n/)
      .filter((l) => /^npm (error|ERR!)/.test(l) && !l.includes("complete log"))
      .map((l) => l.replace(/^npm (error|ERR!) ?/, ""))
      .filter(Boolean);
    const why =
      errLines.join("\n") ||
      (pack.stderr || "").trim() ||
      (pack.error ? String(pack.error.message) : `exit ${pack.status}`);
    return { error: `npm pack failed for ${spec}: ${why}` };
  }
  const tgz = pack.stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  return tgz ? { tgz } : { error: `npm pack produced no tarball for ${spec}` };
}

export type InstallResult = { copied: boolean; dest: string; skipped?: boolean; error?: string };

// Fetch `imprnt-plugin-<name>` (or a local dir via `from`) and copy its shipped files into
// projectRoot/plugins/<name>/. Idempotent: an existing plugins/<name>/agent.md skips the fetch
// unless `force`. Returns what happened; the caller wires the @import line separately.
export function installPlugin(
  projectRoot: string,
  name: string,
  opts: { from?: string; force?: boolean; channel?: Channel } = {},
): InstallResult {
  // Contain the name before it becomes a copy destination: `..` would make dest the project
  // root itself and the extracted tarball would overwrite same-named files there.
  const invalid = specError(projectRoot, name);
  if (invalid) return { copied: false, dest: join(projectRoot, "plugins"), error: invalid };
  // Reuse an existing dir's case so a case-variant install never creates a SECOND physical dir on a
  // case-insensitive FS (finding 2). dest then reports the canonical existing name, which the caller
  // wires, keeping the @import line consistent with what is on disk. A bare name has no file part.
  name = canonicalSpec(projectRoot, name);
  const dest = join(projectRoot, "plugins", name);
  if (existsSync(join(dest, "agent.md")) && !opts.force) return { copied: false, dest, skipped: true };

  if (opts.from && !existsSync(resolve(opts.from))) {
    return { copied: false, dest, error: `--from path not found: ${resolve(opts.from)}` };
  }

  // What to fetch, in order. A local dir is the only spec. A registry install is `imprnt-plugin-<name>`;
  // an edge core tries the `@edge` dist-tag first, then falls back to the default (latest) when the
  // plugin has no edge build published. Latest cores ask for the bare name (npm resolves it to latest).
  const base = `imprnt-plugin-${name}`;
  const specs = opts.from
    ? [resolve(opts.from)]
    : opts.channel === "edge"
      ? [`${base}@edge`, base]
      : [base];

  const tmp = mkdtempSync(join(tmpdir(), "imprnt-pkg-"));
  try {
    let tgz: string | undefined;
    let lastErr: string | undefined;
    for (const spec of specs) {
      const r = npmPack(spec, tmp);
      if (r.tgz) { tgz = r.tgz; break; }
      lastErr = r.error;
    }
    if (!tgz) return { copied: false, dest, error: lastErr ?? `npm pack produced no tarball for ${base}` };

    const ex = spawnSync("tar", ["-xzf", join(tmp, tgz), "-C", tmp], { encoding: "utf8" });
    if (ex.status !== 0) return { copied: false, dest, error: `tar extract failed: ${(ex.stderr || "").trim()}` };

    const src = join(tmp, "package"); // npm tarballs always root at package/
    if (!existsSync(join(src, "agent.md"))) {
      return { copied: false, dest, error: `${name} has no agent.md — not an imprnt plugin?` };
    }
    // A --force install is a REFRESH, so the dest must end up a clean copy of the new tarball, never
    // an overlay of old + new. cpSync alone overwrites same-named files but leaves files the new
    // version dropped (e.g. a check.js v1 shipped, v2 removed - it would still RUN in `check --all`).
    // Clear the dest first on the force/overwrite path only. The non-force "already present" case is
    // handled by the skip above and never reaches here, so this only fires on an intentional refresh.
    if (opts.force) rmSync(dest, { recursive: true, force: true });
    // Mirror today's hand-authored plugin layout: agent.md + check.js + seed dirs, no package.json.
    // force:true is required: bun's cpSync skips overwrites when a filter is present unless it is set.
    cpSync(src, dest, { recursive: true, force: true, filter: (s) => basename(s) !== "package.json" });
    return { copied: true, dest };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Delete an installed plugin's DIR (the `rm -rf plugins/<name>` the contract describes, as a flag).
// --purge is a DIRECTORY operation: it removes a whole plugin, never a single file inside one.
// Guarded so a file-form spec can never route around the private-cast protection:
//   1. specError - rejects a non-canonical or escaping spec (`..`, `./_personal`) up front.
//   2. NO path separator - a `<name>/<file.md>` spec names a file, not a plugin dir, so purge
//      refuses it outright. This is the DATA-LOSS fix: `_personal/voice.md` is canonical and its
//      LEAF basename (`voice.md`) does not start with `_`, so a leaf-only guard let rmSync delete
//      that one gitignored, unrecoverable private file. A file-form spec is a clean refusal.
//   3. _-prefix guard - rejects a bare _name (the private cast).
//   4. statSync isDirectory - only ever rmSync a real directory, never a file.
//   5. a missing dir is a clean no-op (false).
export function purgePlugin(projectRoot: string, name: string): boolean {
  if (specError(projectRoot, name)) return false;
  // A separator means the spec names a file inside a plugin, not a plugin to purge. Refuse it.
  if (name.includes("/")) return false;
  // Never delete the private cast (a _-prefixed dir).
  if (name.startsWith("_")) return false;
  const dir = join(projectRoot, "plugins", name);
  if (!existsSync(dir)) return false;
  // Only purge a real directory. A spec that somehow resolves to a file is refused, not deleted.
  if (!statSync(dir).isDirectory()) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
