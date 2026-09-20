// The box must not leave a boxed command a path to this account's systemd. The
// user session bus and systemd's private socket live under /run/user and the
// system bus under /run/dbus, and a connection to either takes a start-a-unit
// call from the same account, which runs a process OUTSIDE the box. A fresh
// tmpfs over each directory empties it.
//
// The pure half asserts the rendered Linux argv carries both masks, after the
// pid namespace's /proc and inside the masks the box applies last. It runs on
// either platform because it executes nothing.
//
// The exec half is gated on a working bwrap. From inside a real box built by the
// code's own function, with an emptied environment, a property read against the
// user manager over its own socket and against the system bus must both fail to
// connect. A property read is the whole probe: nothing is started, and no
// mutating method is called. The control is a trivial boxed command that runs,
// so a box that simply broke every command is never mistaken for the fence.

import { test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seam } from "./helpers/cluster.ts";
import { boxGate } from "./helpers/box-gate.ts";
import { plantTrees } from "./helpers/trees.ts";
import { writeRegistry, type RegistrySpec } from "./helpers/registry.ts";
import { loadRegistry } from "../src/registry/load.ts";

const gate = boxGate();

function stage(dir: string) {
  const trees = plantTrees(dir, ["p1", "p2"]);
  const spec: RegistrySpec = {
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: dir, shared_zone: trees.sharedZone },
    machines: [{ id: "pi", os: "linux" }],
    people: trees.people.map((p) => ({ id: p.id, tree: p.tree })),
    presets: { daily: { adapter: "scripted", model: "m", provider: "p", effort: "medium", paid: "plan" } },
    agents: trees.people.map((p, n) => ({ id: `${p.id}-lair`, person: p.id, preset: "daily", chat: `000000000${n}`, door: "door-fake", runner: "runner-pi" })),
    run: [
      { id: "door-fake", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
  };
  return { trees, registry: loadRegistry(writeRegistry(dir, spec)) };
}

test("the rendered Linux box masks the user runtime directory and the system bus directory with a tmpfs, after the pid namespace and among the last masks", async () => {
  const { boxCommand, boxContextFor, RUNTIME_MASKS } = await seam("src/box/index.ts") as {
    boxCommand: Function; boxContextFor: Function; RUNTIME_MASKS: string[];
  };
  const dir = mkdtempSync(join(tmpdir(), "hub-box-bus-"));
  try {
    const ctx = boxContextFor(stage(dir).registry, "p1-lair");
    const { argv } = boxCommand(["/bin/true"], { ...ctx, platform: "linux" }, "linux") as { argv: string[] };
    const tmpfsAt = (path: string) => argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === path);
    const proc = argv.findIndex((a, i) => a === "--proc" && argv[i + 1] === "/proc");
    const sep = argv.lastIndexOf("--");
    // Both directories are named, so a build that dropped one is caught here
    // wherever this runs.
    expect([...RUNTIME_MASKS]).toEqual(["/run/user", "/run/dbus"]);
    for (const path of RUNTIME_MASKS) {
      if (existsSync(path)) {
        expect(tmpfsAt(path), `${path} is masked`).toBeGreaterThan(-1);
        expect(tmpfsAt(path), `${path} is masked after the pid namespace`).toBeGreaterThan(proc);
        expect(tmpfsAt(path), `${path} is masked before the command`).toBeLessThan(sep);
      } else {
        // A machine without the directory must not be handed a mask for it:
        // bwrap cannot make a mount point under the read-only host, so naming it
        // would fail every boxed launch on that machine.
        expect(tmpfsAt(path), `${path} is not on this machine, so it is not named`).toBe(-1);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the rendered Linux box covers the docker socket and the X authority cookie the environment names, each with /dev/null", async () => {
  const { boxCommand, boxContextFor } = await seam("src/box/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "hub-box-control-"));
  const saved = process.env.XAUTHORITY;
  try {
    // A stand-in cookie, so the assertion needs no real one and reads none.
    const cookie = join(dir, "Xauthority");
    writeFileSync(cookie, "synthetic-cookie", { mode: 0o600 });
    process.env.XAUTHORITY = cookie;
    const ctx = (boxContextFor as Function)(stage(dir).registry, "p1-lair");
    const { argv } = (boxCommand as Function)(["/bin/true"], { ...ctx, platform: "linux" }, "linux") as { argv: string[] };
    const nulled = (path: string) => argv.some((a, i) => a === "--ro-bind" && argv[i + 1] === "/dev/null" && argv[i + 2] === realpathSync(path));
    expect(nulled(cookie), "the X authority cookie the environment names is masked").toBe(true);
    // The socket is only on a box that runs the daemon, so it is asserted where
    // it exists and the argv simply skips it where it does not.
    if (existsSync("/run/docker.sock")) expect(nulled("/run/docker.sock"), "the docker socket is masked").toBe(true);
    // Every mask lands before the command.
    const sep = argv.lastIndexOf("--");
    expect(argv.findIndex((a, i) => a === "--ro-bind" && argv[i + 1] === "/dev/null")).toBeLessThan(sep);
  } finally {
    if (saved === undefined) delete process.env.XAUTHORITY; else process.env.XAUTHORITY = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a mask path the system will not resolve still renders a box", async () => {
  const { boxCommand, boxContextFor } = await seam("src/box/index.ts");
  const dir = mkdtempSync(join(tmpdir(), "hub-box-unresolvable-"));
  const saved = process.env.XAUTHORITY;
  try {
    // A symlink whose target is not there: it is present to a check for
    // existence and refuses to resolve, which is the shape of a socket some
    // systems will not answer a resolve for. Rendering must not throw, because a
    // box that cannot be rendered is a loop that cannot start at all.
    const cookie = join(dir, "Xauthority");
    symlinkSync(join(dir, "nowhere"), cookie);
    process.env.XAUTHORITY = cookie;
    const ctx = (boxContextFor as Function)(stage(dir).registry, "p1-lair");
    expect(() => (boxCommand as Function)(["/bin/true"], { ...ctx, platform: "linux" }, "linux")).not.toThrow();
  } finally {
    if (saved === undefined) delete process.env.XAUTHORITY; else process.env.XAUTHORITY = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

beforeAll(() => {
  process.stderr.write(`[box-gate] the bus fence on ${process.platform}: ${gate.ok ? `open (${gate.tool})` : `SKIPPED, ${gate.reason}`}\n`);
});

test.skipIf(!(gate.ok && process.platform === "linux"))(
  `inside a real Linux box the user manager and the system bus do not answer a property read, while a trivial boxed command still runs${gate.ok && process.platform === "linux" ? "" : ` [skipped: ${gate.reason || "not linux"}]`}`,
  async () => {
    const { boxCommand, boxContextFor } = await seam("src/box/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "hub-box-bus-exec-"));
    try {
      const ctx = (boxContextFor as Function)(stage(dir).registry, "p1-lair");
      const uid = process.getuid!();
      const version = "org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager Version";
      const probe = ["/bin/sh", "-c", [
        `echo control-ran`,
        `printf user-bus:; busctl --address=unix:path=/run/user/${uid}/bus get-property ${version} 2>&1 | head -1`,
        `printf system-bus:; busctl --system get-property ${version} 2>&1 | head -1`,
      ].join("; ")];
      const { argv } = (boxCommand as Function)(probe, { ...ctx, platform: "linux" }, "linux") as { argv: string[] };
      const done = Bun.spawnSync(argv, { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "pipe" });
      const out = done.stdout.toString() + done.stderr.toString();
      // The control proves the box runs a command at all.
      expect(out).toContain("control-ran");
      // A version string is only ever returned by a bus that answered. Neither may.
      const userLine = out.split("\n").find((l) => l.startsWith("user-bus:")) ?? "";
      const systemLine = out.split("\n").find((l) => l.startsWith("system-bus:")) ?? "";
      expect(userLine, `the user manager answered: ${userLine}`).not.toMatch(/^user-bus:\s*s\s/);
      expect(systemLine, `the system bus answered: ${systemLine}`).not.toMatch(/^system-bus:\s*s\s/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  },
  120_000,
);

test.skipIf(!(gate.ok && process.platform === "linux"))(
  `inside a real Linux box the docker socket refuses a connect and the X authority cookie does not read, while the same connect and the same read succeed outside it${gate.ok && process.platform === "linux" ? "" : ` [skipped: ${gate.reason || "not linux"}]`}`,
  async () => {
    const { boxCommand, boxContextFor } = await seam("src/box/index.ts");
    const dir = mkdtempSync(join(tmpdir(), "hub-box-control-exec-"));
    const saved = process.env.XAUTHORITY;
    try {
      // A stand-in cookie in the test's own directory, never the real one.
      const cookie = join(dir, "Xauthority");
      writeFileSync(cookie, "synthetic-cookie-sentinel", { mode: 0o600 });
      process.env.XAUTHORITY = cookie;
      // A connect and nothing else: no request is ever sent to the daemon. It
      // goes in a file rather than through -c, because a shell hands a -c
      // program its backslashes and python reads those as line continuations.
      const script = join(dir, "connect.py");
      writeFileSync(script, [
        "import socket",
        "s = socket.socket(socket.AF_UNIX)",
        "try:",
        '    s.connect("/run/docker.sock")',
        '    print("docker:connected")',
        "except Exception as error:",
        '    print("docker:refused", type(error).__name__)',
        "",
      ].join("\n"));
      const probe = ["/bin/sh", "-c", [
        `echo control-ran`,
        `printf cookie:; cat ${cookie} 2>/dev/null || echo UNREADABLE`,
        `python3 ${script} 2>&1 | tail -1`,
      ].join("; ")];
      const ctx = (boxContextFor as Function)(stage(dir).registry, "p1-lair");
      const { argv } = (boxCommand as Function)(probe, { ...ctx, platform: "linux" }, "linux") as { argv: string[] };
      const run = (command: string[]) => {
        const done = Bun.spawnSync(command, { env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, stdout: "pipe", stderr: "pipe" });
        return done.stdout.toString() + done.stderr.toString();
      };
      const outside = run(probe);
      const inside = run(argv);
      expect(inside).toContain("control-ran");
      // The cookie: readable outside, never inside.
      expect(outside, "the control reads the stand-in cookie outside the box").toContain("synthetic-cookie-sentinel");
      expect(inside.includes("synthetic-cookie-sentinel"), `the cookie read inside the box:\n${inside}`).toBe(false);
      // The socket: only judged on a box that runs the daemon, and only when the
      // same connect succeeds outside, which is what makes the refusal the fence.
      if (outside.includes("docker:connected")) {
        expect(inside.includes("docker:connected"), `the docker socket connected inside the box:\n${inside}`).toBe(false);
      } else {
        process.stderr.write(`[box-gate] the docker socket is not connectable on this box, so only the cookie is judged\n`);
      }
    } finally {
      if (saved === undefined) delete process.env.XAUTHORITY; else process.env.XAUTHORITY = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  120_000,
);
