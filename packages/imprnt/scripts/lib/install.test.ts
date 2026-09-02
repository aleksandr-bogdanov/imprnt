import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installPlugin, purgePlugin, coreChannel, OFFICIAL } from "./install.ts";

// A synthetic plugin PACKAGE source dir: a package.json with files[], the shipped runtime files,
// plus src/ and a stray file that files[] excludes. installPlugin runs `npm pack` on this, so the
// test exercises the exact packing the registry would do.
function mkPluginSrc(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "imprnt-pluginsrc-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `imprnt-plugin-${name}`, version: "0.0.1", files: ["agent.md", "check.js", "proposed"] }),
  );
  writeFileSync(join(dir, "agent.md"), `# ${name} agent\n`);
  writeFileSync(join(dir, "check.js"), `console.log("${name} ok");\n`);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "check.ts"), `console.log("SOURCE - must not ship");\n`);
  mkdirSync(join(dir, "proposed"), { recursive: true });
  writeFileSync(join(dir, "proposed", ".gitkeep"), "");
  writeFileSync(join(dir, "secret.txt"), "SECRET - excluded by files[]\n");
  return dir;
}

function tmpProject(): string {
  const root = mkdtempSync(join(tmpdir(), "imprnt-proj-"));
  mkdirSync(join(root, "plugins"), { recursive: true });
  return root;
}

// A plugin source whose files[] ships ONLY agent.md (no check.js). Models v2 of a package that
// dropped a file v1 used to ship - the --force-refresh case in finding 1.
function mkAgentOnlySrc(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "imprnt-pluginsrc-v2-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: `imprnt-plugin-${name}`, version: "0.0.2", files: ["agent.md"] }),
  );
  writeFileSync(join(dir, "agent.md"), `# ${name} agent v2\n`);
  return dir;
}

test("installPlugin --from copies the shipped tree (agent.md, check.js, proposed/) and nothing else", () => {
  const src = mkPluginSrc("demo");
  const proj = tmpProject();
  const r = installPlugin(proj, "demo", { from: src });
  expect(r.error).toBeUndefined();
  expect(r.copied).toBe(true);
  const dest = join(proj, "plugins", "demo");
  expect(readFileSync(join(dest, "agent.md"), "utf8")).toContain("demo agent");
  expect(existsSync(join(dest, "check.js"))).toBe(true);
  expect(existsSync(join(dest, "proposed", ".gitkeep"))).toBe(true);
  // files[] excluded these; the npm manifest is dropped by the copy filter.
  expect(existsSync(join(dest, "src"))).toBe(false);
  expect(existsSync(join(dest, "secret.txt"))).toBe(false);
  expect(existsSync(join(dest, "package.json"))).toBe(false);
});

test("installPlugin is idempotent: a present agent.md skips re-copy unless force", () => {
  const src = mkPluginSrc("demo");
  const proj = tmpProject();
  installPlugin(proj, "demo", { from: src });
  // Hand-edit the installed copy, then re-install without force: edit must survive (skipped).
  const agent = join(proj, "plugins", "demo", "agent.md");
  writeFileSync(agent, "EDITED");
  const again = installPlugin(proj, "demo", { from: src });
  expect(again.skipped).toBe(true);
  expect(again.copied).toBe(false);
  expect(readFileSync(agent, "utf8")).toBe("EDITED");
  // force overwrites.
  const forced = installPlugin(proj, "demo", { from: src, force: true });
  expect(forced.copied).toBe(true);
  expect(readFileSync(agent, "utf8")).toContain("demo agent");
});

// --- --force is a clean refresh: a file the new tarball dropped must not survive (finding 1) ---
// v1 ships check.js. v2 (--force) ships without it. The contract calls --force a "refresh", and
// `imprnt check --all` globs plugins/*/check.js, so a stale v1 check.js would still RUN (and fail)
// after a v2 refresh. The force/overwrite path must clear the dest first so it is a clean copy of
// the new tarball, never an overlay of old + new.
test("installPlugin --force is a clean refresh: a file the new tarball dropped is gone (finding 1)", () => {
  const v1 = mkPluginSrc("demo"); // ships agent.md + check.js + proposed/
  const v2 = mkAgentOnlySrc("demo"); // ships agent.md only
  const proj = tmpProject();
  installPlugin(proj, "demo", { from: v1 });
  const dest = join(proj, "plugins", "demo");
  expect(existsSync(join(dest, "check.js"))).toBe(true);
  // Force-refresh from v2: the stale check.js (and proposed/) must be cleared, the new agent.md present.
  const forced = installPlugin(proj, "demo", { from: v2, force: true });
  expect(forced.copied).toBe(true);
  expect(existsSync(join(dest, "check.js"))).toBe(false);
  expect(existsSync(join(dest, "proposed"))).toBe(false);
  expect(readFileSync(join(dest, "agent.md"), "utf8")).toContain("demo agent v2");
});

test("installPlugin errors when --from path is missing", () => {
  const proj = tmpProject();
  const r = installPlugin(proj, "ghost", { from: join(tmpdir(), "definitely-not-here-xyz") });
  expect(r.copied).toBe(false);
  expect(r.error).toContain("not found");
});

test("installPlugin errors when the package has no agent.md", () => {
  const dir = mkdtempSync(join(tmpdir(), "imprnt-noagent-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "imprnt-plugin-bad", version: "0.0.1", files: ["check.js"] }));
  writeFileSync(join(dir, "check.js"), "console.log(1);\n");
  const proj = tmpProject();
  const r = installPlugin(proj, "bad", { from: dir });
  expect(r.copied).toBe(false);
  expect(r.error).toContain("no agent.md");
});

test("purgePlugin removes an installed dir, refuses _-prefixed, no-ops when absent", () => {
  const src = mkPluginSrc("demo");
  const proj = tmpProject();
  installPlugin(proj, "demo", { from: src });
  expect(existsSync(join(proj, "plugins", "demo"))).toBe(true);
  expect(purgePlugin(proj, "demo")).toBe(true);
  expect(existsSync(join(proj, "plugins", "demo"))).toBe(false);
  // missing dir -> clean false.
  expect(purgePlugin(proj, "demo")).toBe(false);
  // never delete the private cast, even if it exists.
  mkdirSync(join(proj, "plugins", "_personal"), { recursive: true });
  expect(purgePlugin(proj, "_personal")).toBe(false);
  expect(existsSync(join(proj, "plugins", "_personal"))).toBe(true);
});

test("OFFICIAL lists the release gallery names by convention", () => {
  expect(OFFICIAL).toContain("anti-slop");
  expect(OFFICIAL).toContain("timemachine");
  // Never advertised here: telegram and kleinanzeigen are curated out of the
  // stable set (beta / not ready), and whenful is removed outright (killed
  // 2026-08-28, git history is the archive) - this line guards its return.
  expect(OFFICIAL).not.toContain("whenful");
  expect(OFFICIAL).not.toContain("telegram");
  expect(OFFICIAL).not.toContain("kleinanzeigen");
});

test("coreChannel reads edge from an -edge. version, latest otherwise", () => {
  const edge = mkdtempSync(join(tmpdir(), "imprnt-pkgroot-edge-"));
  writeFileSync(join(edge, "package.json"), JSON.stringify({ name: "imprnt", version: "0.3.3-edge.418" }));
  expect(coreChannel(edge)).toBe("edge");

  const stable = mkdtempSync(join(tmpdir(), "imprnt-pkgroot-stable-"));
  writeFileSync(join(stable, "package.json"), JSON.stringify({ name: "imprnt", version: "0.3.2" }));
  expect(coreChannel(stable)).toBe("latest");
});

test("coreChannel falls back to latest when package.json is missing or unreadable", () => {
  expect(coreChannel(join(tmpdir(), "imprnt-no-such-pkgroot-xyz"))).toBe("latest");
});

// --- case-insensitive collision: reuse the existing dir, never a second copy (finding 2) ---
// On a case-insensitive FS (macOS APFS default), `plugins/Demo` and `plugins/demo` are the SAME
// physical dir. installPlugin's existsSync(agent.md) skip is case-insensitive there, but the
// wired-line match downstream is case-sensitive, so a case-variant add used to skip the copy yet
// wire a SECOND distinct @import line. The fix: a case-variant install reuses the existing dir name
// for the copy target, so there is never a second physical dir, and the reported dest is the
// canonical existing name (which the caller then wires, keeping the line on-disk-consistent).
test("installPlugin reuses an existing dir for a case-variant name, no second dir (finding 2)", () => {
  const src = mkPluginSrc("demo");
  const proj = tmpProject();
  installPlugin(proj, "demo", { from: src });
  expect(existsSync(join(proj, "plugins", "demo"))).toBe(true);
  // Now install the SAME plugin under a different case. It must resolve to the existing "demo" dir.
  const r = installPlugin(proj, "Demo", { from: src });
  // dest reports the canonical existing dir name, so the caller wires @plugins/demo/..., not Demo.
  expect(r.dest).toBe(join(proj, "plugins", "demo"));
  // No second physical dir was created for the variant case.
  const fs = require("node:fs");
  const entries = fs
    .readdirSync(join(proj, "plugins"))
    .filter((e: string) => e.toLowerCase() === "demo");
  expect(entries).toEqual(["demo"]);
});

// --- spec containment: rm/cp must never reach outside plugins/ ---

test("purgePlugin refuses .. and foo/.. (an escape would delete the project / all of plugins/)", () => {
  const proj = tmpProject();
  // Sentinels an escape would take out: the project root itself, and plugins/ wholesale.
  writeFileSync(join(proj, "CLAUDE.md"), "contract");
  mkdirSync(join(proj, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(proj, "plugins", "_personal", "voice.md"), "x");
  expect(purgePlugin(proj, "..")).toBe(false);
  expect(existsSync(join(proj, "CLAUDE.md"))).toBe(true);
  expect(purgePlugin(proj, "foo/..")).toBe(false);
  expect(existsSync(join(proj, "plugins", "_personal", "voice.md"))).toBe(true);
});

test("installPlugin refuses a name that escapes plugins/ (no copy into the project root)", () => {
  const src = mkPluginSrc("demo");
  const proj = tmpProject();
  const r = installPlugin(proj, "..", { from: src });
  expect(r.copied).toBe(false);
  expect(r.error).toContain("invalid plugin spec");
  expect(existsSync(join(proj, "agent.md"))).toBe(false);
});

// --- the _personal cast survives a non-canonical purge spec (finding 1) ---
// The private cast (plugins/_personal/) is gitignored, never published, UNRECOVERABLE. The purge
// guard used to be a literal name.startsWith("_") check, so a spec that RESOLVES to a _-prefixed
// dir but does not literally start with "_" (./_personal, demo/../_personal) slipped past it and
// deleted the cast. specError must reject the non-canonical spec before purge runs.

test("purgePlugin refuses './_personal' and the private cast survives (finding 1)", () => {
  const proj = tmpProject();
  mkdirSync(join(proj, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(proj, "plugins", "_personal", "voice.md"), "PRIVATE");
  expect(purgePlugin(proj, "./_personal")).toBe(false);
  expect(existsSync(join(proj, "plugins", "_personal", "voice.md"))).toBe(true);
});

test("purgePlugin refuses 'demo/../_personal' and the private cast survives (finding 1)", () => {
  const proj = tmpProject();
  mkdirSync(join(proj, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(proj, "plugins", "_personal", "voice.md"), "PRIVATE");
  // Resolves to plugins/_personal but does not literally start with "_".
  expect(purgePlugin(proj, "demo/../_personal")).toBe(false);
  expect(existsSync(join(proj, "plugins", "_personal", "voice.md"))).toBe(true);
});

test("purgePlugin refuses a trailing-slash _personal/ spec (finding 1)", () => {
  const proj = tmpProject();
  mkdirSync(join(proj, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(proj, "plugins", "_personal", "voice.md"), "PRIVATE");
  expect(purgePlugin(proj, "_personal/")).toBe(false);
  expect(existsSync(join(proj, "plugins", "_personal", "voice.md"))).toBe(true);
});

// --- --purge is a directory operation: a file-form spec is a clean refusal (finding: DATA LOSS) ---
// `_personal/voice.md` is canonical (specError passes) and its LEAF basename is `voice.md` (no `_`),
// so the old single-leaf guard let it through and rmSync deleted that one FILE - the gitignored,
// never-published, unrecoverable private voice fragment. --purge deletes a whole plugin DIRECTORY,
// never a file inside one. So a spec with a path separator (a file-form spec) must be refused, and
// the `_`-prefix protection must key on the FIRST path segment (the plugin dir), not the leaf.

test("purgePlugin refuses '_personal/voice.md' and the private file survives (DATA LOSS)", () => {
  const proj = tmpProject();
  mkdirSync(join(proj, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(proj, "plugins", "_personal", "voice.md"), "PRIVATE");
  writeFileSync(join(proj, "plugins", "_personal", "taylor.md"), "PRIVATE");
  expect(purgePlugin(proj, "_personal/voice.md")).toBe(false);
  // The targeted file AND its sibling both survive - purge touched nothing.
  expect(existsSync(join(proj, "plugins", "_personal", "voice.md"))).toBe(true);
  expect(existsSync(join(proj, "plugins", "_personal", "taylor.md"))).toBe(true);
});

test("purgePlugin refuses a non-_ plugin's file-form spec (purge is dir-only)", () => {
  const src = mkPluginSrc("character");
  const proj = tmpProject();
  installPlugin(proj, "character", { from: src });
  writeFileSync(join(proj, "plugins", "character", "extra.md"), "x");
  // A file inside a gallery plugin's dir is not a plugin to purge; refuse cleanly, file survives.
  expect(purgePlugin(proj, "character/extra.md")).toBe(false);
  expect(existsSync(join(proj, "plugins", "character", "extra.md"))).toBe(true);
  expect(existsSync(join(proj, "plugins", "character"))).toBe(true);
});

test("purgePlugin still deletes a real gallery dir (the happy path is unbroken)", () => {
  const src = mkPluginSrc("gallery");
  const proj = tmpProject();
  installPlugin(proj, "gallery", { from: src });
  expect(existsSync(join(proj, "plugins", "gallery"))).toBe(true);
  expect(purgePlugin(proj, "gallery")).toBe(true);
  expect(existsSync(join(proj, "plugins", "gallery"))).toBe(false);
});

// --- npm pack failures carry npm's real reason ---

test("npm pack failure surfaces npm's actual error, not a bare exit code", () => {
  const proj = tmpProject();
  const dir = mkdtempSync(join(tmpdir(), "imprnt-nopkg-")); // exists, but holds no package.json
  const r = installPlugin(proj, "demo", { from: dir });
  expect(r.copied).toBe(false);
  expect(r.error).toMatch(/package\.json/);
});

test("channel:'edge' is ignored for a --from install (local dir wins, still copies)", () => {
  const src = mkPluginSrc("demo");
  const proj = tmpProject();
  // An edge core installing a local plugin must still install from the dir, not chase a registry tag.
  const r = installPlugin(proj, "demo", { from: src, channel: "edge" });
  expect(r.error).toBeUndefined();
  expect(r.copied).toBe(true);
  expect(readFileSync(join(proj, "plugins", "demo", "agent.md"), "utf8")).toContain("demo agent");
});
