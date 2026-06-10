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

test("OFFICIAL lists the gallery names by convention", () => {
  expect(OFFICIAL).toContain("whenful");
  expect(OFFICIAL).toContain("anti-slop");
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
// dir but does not literally start with "_" (./_personal, guard/../_personal) slipped past it and
// deleted the cast. specError must reject the non-canonical spec before purge runs.

test("purgePlugin refuses './_personal' and the private cast survives (finding 1)", () => {
  const proj = tmpProject();
  mkdirSync(join(proj, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(proj, "plugins", "_personal", "voice.md"), "PRIVATE");
  expect(purgePlugin(proj, "./_personal")).toBe(false);
  expect(existsSync(join(proj, "plugins", "_personal", "voice.md"))).toBe(true);
});

test("purgePlugin refuses 'guard/../_personal' and the private cast survives (finding 1)", () => {
  const proj = tmpProject();
  mkdirSync(join(proj, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(proj, "plugins", "_personal", "voice.md"), "PRIVATE");
  // Resolves to plugins/_personal but does not literally start with "_".
  expect(purgePlugin(proj, "guard/../_personal")).toBe(false);
  expect(existsSync(join(proj, "plugins", "_personal", "voice.md"))).toBe(true);
});

test("purgePlugin refuses a trailing-slash _personal/ spec (finding 1)", () => {
  const proj = tmpProject();
  mkdirSync(join(proj, "plugins", "_personal"), { recursive: true });
  writeFileSync(join(proj, "plugins", "_personal", "voice.md"), "PRIVATE");
  expect(purgePlugin(proj, "_personal/")).toBe(false);
  expect(existsSync(join(proj, "plugins", "_personal", "voice.md"))).toBe(true);
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
