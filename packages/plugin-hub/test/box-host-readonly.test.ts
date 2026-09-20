// The Linux box binds the whole host read-only, so a boxed command cannot
// rewrite the registry, drop a unit under the user systemd directory or edit a
// shell startup file that later runs outside the box with the account's
// privileges behind it. Only four paths are writable: the agent's own tree, its
// session directory, its declared repositories and the launched login's own
// directory (the model CLI rotates its token in place there).
//
// The pure half asserts the rendered argv: the host bound with --ro-bind and a
// fresh --dev on top, the tree bound writable for an ordinary turn and read-only
// for a harvest, the state root read-only, and the session and write paths bound
// writable. It runs on either platform because it executes nothing.
//
// The exec half is gated on a working bwrap. From inside a real box a write to a
// fixture registry file and to a fixture directory standing in for the user unit
// directory, both outside the grants, must fail, while the tree, the session and
// the login directory take a write. The fixtures are the test's own temp files:
// nothing real is ever written.

import { test, expect, beforeAll } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { boxGate } from "./helpers/box-gate.ts";

const gate = boxGate();

/** A household laid out so the tree, the state root and the login directory are
 *  distinct paths, plus two fixture paths outside every grant. */
function household() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hub-host-ro-")));
  const tree = join(root, "tree");
  const stateRoot = join(root, "state");
  const sessionDir = join(stateRoot, "session");
  const loginDir = join(root, "login");
  const registryFixture = join(root, "registry.toml");
  const unitDir = join(root, "systemd-user");
  for (const dir of [tree, stateRoot, sessionDir, loginDir, unitDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(registryFixture, "original\n");
  const ctx = { agent: "p1-lair", person: "p1", tree, otherTrees: [] as string[],
    stateRoot, sessionDir, writePaths: [loginDir], purpose: "ordinary" as const };
  return { root, tree, stateRoot, sessionDir, loginDir, registryFixture, unitDir, ctx };
}

test("the rendered Linux box binds the host read-only with a fresh /dev, binds the tree writable for a turn and read-only for a harvest, and keeps the state root read-only while the session and the write paths are writable", async () => {
  const { boxCommand } = await seam("src/box/index.ts");
  const h = household();
  try {
    const has = (argv: string[], verb: string, path: string) =>
      argv.some((a, i) => a === verb && argv[i + 1] === path && argv[i + 2] === path);
    const ordinary = ((boxCommand as Function)(["/bin/true"], { ...h.ctx, platform: "linux" }, "linux") as { argv: string[] }).argv;
    // The host is read-only, never a --dev-bind, and /dev is a fresh mount on top.
    expect(ordinary).not.toContain("--dev-bind");
    const hostBind = ordinary.findIndex((a, i) => a === "--ro-bind" && ordinary[i + 1] === "/" && ordinary[i + 2] === "/");
    expect(hostBind).toBeGreaterThanOrEqual(0);
    expect(ordinary.findIndex((a, i) => a === "--dev" && ordinary[i + 1] === "/dev")).toBeGreaterThan(hostBind);
    // Writers, and the read-only state root between the tree and its session.
    expect(has(ordinary, "--bind", h.tree)).toBe(true);
    expect(has(ordinary, "--ro-bind", h.stateRoot)).toBe(true);
    expect(has(ordinary, "--bind", h.sessionDir)).toBe(true);
    expect(has(ordinary, "--bind", h.loginDir)).toBe(true);
    // The tree bind comes before the read-only state root, so a fixture where the
    // two are the same directory reads as read-only.
    const treeAt = ordinary.findIndex((a, i) => a === "--bind" && ordinary[i + 1] === h.tree);
    const stateAt = ordinary.findIndex((a, i) => a === "--ro-bind" && ordinary[i + 1] === h.stateRoot);
    expect(treeAt).toBeLessThan(stateAt);

    // A harvest only reads the tree.
    const harvest = ((boxCommand as Function)(["/bin/true"], { ...h.ctx, purpose: "harvest", platform: "linux" }, "linux") as { argv: string[] }).argv;
    expect(has(harvest, "--ro-bind", h.tree)).toBe(true);
    expect(has(harvest, "--bind", h.tree)).toBe(false);
  } finally { rmSync(h.root, { recursive: true, force: true }); }
});

beforeAll(() => {
  process.stderr.write(`[box-gate] the read-only host on ${process.platform}: ${gate.ok ? `open (${gate.tool})` : `SKIPPED, ${gate.reason}`}\n`);
});

test.skipIf(!(gate.ok && process.platform === "linux"))(
  `inside a real Linux box a write to a fixture registry and to a fixture user unit directory fail, while the tree, the session and the login directory take a write${gate.ok && process.platform === "linux" ? "" : ` [skipped: ${gate.reason || "not linux"}]`}`,
  async () => {
    const { boxCommand } = await seam("src/box/index.ts");
    const h = household();
    try {
      const probe = ["/bin/sh", "-c", [
        `printf registry:; (echo rewritten > ${h.registryFixture}) 2>/dev/null && echo OK || echo DENIED`,
        `printf unit:; (echo unit > ${h.unitDir}/injected.service) 2>/dev/null && echo OK || echo DENIED`,
        `printf tree:; (echo x > ${h.tree}/w) 2>/dev/null && echo OK || echo DENIED`,
        `printf session:; (echo x > ${h.sessionDir}/w) 2>/dev/null && echo OK || echo DENIED`,
        `printf login:; (echo x > ${h.loginDir}/w) 2>/dev/null && echo OK || echo DENIED`,
      ].join("; ")];
      const { argv } = (boxCommand as Function)(probe, { ...h.ctx, platform: "linux" }, "linux") as { argv: string[] };
      const done = Bun.spawnSync(argv, { env: { PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" });
      const out = done.stdout.toString() + done.stderr.toString();
      const said = (label: string) => (out.split("\n").find((l) => l.startsWith(`${label}:`)) ?? "").slice(label.length + 1);
      // The host is read-only: neither write lands.
      expect(said("registry"), out).toBe("DENIED");
      expect(said("unit"), out).toBe("DENIED");
      expect(readFileSync(h.registryFixture, "utf8")).toBe("original\n");
      expect(existsSync(join(h.unitDir, "injected.service"))).toBe(false);
      // Control: the writers are writable, or the box has simply broken every write.
      expect(said("tree"), out).toBe("OK");
      expect(said("session"), out).toBe("OK");
      expect(said("login"), out).toBe("OK");
    } finally { rmSync(h.root, { recursive: true, force: true }); }
  },
  120_000,
);
