// A WSL guest: the view the hub reads of it, the findings it names, and the
// masks the box adds there. (docs/windows-executor.md)
//
// WSL opens three ways out of Linux that no other Linux host has: interop (a
// Windows program started from Linux runs as the Windows account, outside every
// namespace), the Windows drives under /mnt, and the folders WSL shares between
// distros and with WSLg. Each is a way around the box.
//
// PURE, BOTH PLATFORMS. The view is read from supplied sources, because no
// machine this suite runs on is a WSL guest; the real reader is the extra
// control and must say "not WSL" here. Nothing runs bwrap: the argv is the
// claim, and a WSL host running it is listed as unproven in the doc.

import { test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWslView, wslGrantedUnder, wslKeptFiles, wslMaskPaths, wslViewFrom, WSL_RUNTIME_MASKS, type WslSources } from "../src/os/wsl.ts";
import { kernelFindings, wslFindings } from "../src/check/kernel.ts";
import { boxCommand } from "../src/box/index.ts";

// /proc/self/mounts on a WSL 2 Debian with the default wsl.conf, as WSL writes it.
const DEFAULT_MOUNTS = [
  "none /usr/lib/wsl/drivers 9p ro,nosuid,nodev,noatime,dirsync,aname=drivers;fmask=222;dmask=222,mmap,access=client,msize=65536,trans=fd,rfd=7,wfd=7 0 0",
  "/dev/sdc / ext4 rw,relatime,discard,errors=remount-ro,data=ordered 0 0",
  "none /mnt/wsl tmpfs rw,relatime 0 0",
  "drivers /usr/lib/wsl/drivers 9p ro,dirsync,nosuid,nodev,noatime,aname=drivers;fmask=222;dmask=222 0 0",
  "C:\\134 /mnt/c 9p rw,noatime,dirsync,aname=drvfs;path=C:\\;uid=1000;gid=1000;symlinkroot=/mnt/,mmap,access=client,msize=65536,trans=fd,rfd=5,wfd=5 0 0",
  "D:\\134 /mnt/my\\040data 9p rw,noatime,dirsync,aname=drvfs;path=D:\\;uid=1000;gid=1000,trans=fd 0 0",
  "tmpfs /run/user/1000 tmpfs rw,nosuid,nodev,relatime,size=1631484k,mode=700,uid=1000,gid=1000 0 0",
].join("\n");

const WSL2: WslSources = {
  osrelease: "6.6.87.2-microsoft-standard-WSL2\n",
  binfmt: { WSLInterop: "enabled\ninterpreter /init\nflags: PF\noffset 0\nmagic 4d5a\n" },
  mounts: DEFAULT_MOUNTS,
};

test("the view of a WSL 2 guest names its interop registration and its Windows drives, and leaves WSL's own driver share out", () => {
  expect(wslViewFrom(WSL2)).toEqual({
    version: 2, interop: ["WSLInterop"], windowsMounts: ["/mnt/c", "/mnt/my data"],
  });
});

test("the supported setup's view is clean: a disabled or absent registration and no Windows mount", () => {
  const closed = wslViewFrom({ ...WSL2, binfmt: { WSLInterop: "disabled\ninterpreter /init\n" }, mounts: DEFAULT_MOUNTS.split("\n").filter(line => !line.includes("aname=drvfs")).join("\n") });
  expect(closed).toEqual({ version: 2, interop: [], windowsMounts: [] });
  expect(wslViewFrom({ ...WSL2, binfmt: {}, mounts: "" })?.interop).toEqual([]);
  expect(wslFindings(closed, "pc")).toEqual([]);
});

test("a Linux that is not WSL has no view, WSL 1 is told apart, and this machine's real view is none", () => {
  // A Pi carries none of WSL's traces either.
  const pi = { osrelease: "6.12.25+rpt-rpi-2712\n", binfmt: {}, mounts: "/dev/mmcblk0p2 / ext4 rw 0 0", runtime: false };
  expect(wslViewFrom(pi)).toBeNull();
  expect(wslViewFrom({ ...pi, osrelease: null })).toBeNull();
  expect(wslViewFrom({ ...WSL2, osrelease: "4.4.0-19041-Microsoft\n" })?.version).toBe(1);
  // The suite runs on the Mac and on CI's Ubuntu, neither of them a WSL guest.
  expect(readWslView()).toBeNull();
});

test("a WSL 2 guest on a custom kernel whose name says nothing is still found by WSL's own traces, and plain Linux is not", () => {
  const custom = "6.6.87-custom\n";
  const plain = { osrelease: custom, binfmt: {}, mounts: "/dev/sda / ext4 rw 0 0\ntmpfs /run/user/1000 tmpfs rw 0 0", runtime: false };
  expect(wslViewFrom(plain)).toBeNull();
  // Each trace alone is enough, and the guest is WSL 2: WSL 1 runs no kernel of its own.
  expect(wslViewFrom({ ...WSL2, osrelease: custom })).toEqual({ version: 2, interop: ["WSLInterop"], windowsMounts: ["/mnt/c", "/mnt/my data"] });
  expect(wslViewFrom({ ...plain, binfmt: { WSLInterop: "disabled\n" } })).toEqual({ version: 2, interop: [], windowsMounts: [] });
  expect(wslViewFrom({ ...plain, runtime: true })?.version).toBe(2);
  expect(wslViewFrom({ ...plain, mounts: `${plain.mounts}\nnone /mnt/wsl tmpfs rw,relatime 0 0` })?.version).toBe(2);
  expect(wslViewFrom({ ...plain, mounts: `${plain.mounts}\ndrivers /usr/lib/wsl/drivers 9p ro,aname=drivers 0 0` })?.version).toBe(2);
});

test("check names each way around the box with the line that closes it, and only on a WSL view", () => {
  const view = wslViewFrom(WSL2)!;
  const found = wslFindings(view, "pc");
  expect(found.map(f => f.kind)).toEqual(["wsl-interop-open", "wsl-windows-mounts"]);
  for (const one of found) {
    expect(one.id).toBe(`pc/${one.kind}`);
    expect(one.fix).toContain("/etc/wsl.conf");
    expect(one.fix).toContain("wsl.exe --terminate <distro> from Windows (imprnt-hub when the Windows setup made it)");
    // The same words from a unit's environment and from a shell's.
    expect(one.says).not.toContain("imprnt-hub");
  }
  expect(found[0].fix).toContain("enabled = false and appendWindowsPath = false under [interop]");
  expect(found[1].says).toContain("/mnt/c, /mnt/my data");
  expect(found[1].fix).toContain("enabled = false under [automount]");
  expect(wslFindings({ ...view, version: 1, interop: [], windowsMounts: [] }, "pc").map(f => f.kind)).toEqual(["wsl-version"]);
  expect(wslFindings(null, "pc")).toEqual([]);

  // Through the kernel findings `check` runs: the WSL ones ride along, and the
  // memory controller's fix is the .wslconfig line, not a Debian boot setting.
  const kernel = { cmdline: "initrd=\\initrd.img panic=-1", bootFile: null, controllers: ["cpu", "pids"], earlyoom: "active" as const, linger: true };
  const withWsl = kernelFindings({ ...kernel, wsl: view }, "pc");
  expect(withWsl.map(f => f.kind)).toEqual(["kernel-memory-cgroup", "wsl-interop-open", "wsl-windows-mounts"]);
  expect(withWsl[0].fix).toContain("kernelCommandLine = cgroup_no_v1=all under [wsl2]");
  const plain = kernelFindings(kernel, "pi");
  expect(plain.map(f => f.kind)).toEqual(["kernel-memory-cgroup"]);
  expect(plain[0].fix).not.toContain("wslconfig");
});

test("the masks are WSL's runtime folders and the Windows drives that exist, resolved, always, and none off WSL", () => {
  const view = wslViewFrom(WSL2)!;
  const present = new Set(["/run/WSL", "/mnt/wsl", "/mnt/wslg", "/tmp/.X11-unix", "/mnt/c", "/mnt/my data"]);
  const exists = (path: string) => present.has(path);
  // WSLg's X socket directory as a link into its own folder: covered already.
  const resolve = (path: string) => path === "/tmp/.X11-unix" ? "/mnt/wslg/.X11-unix" : path;
  expect([...WSL_RUNTIME_MASKS]).toEqual(["/run/WSL", "/mnt/wsl", "/mnt/wslg", "/tmp/.X11-unix"]);
  const masks = wslMaskPaths(view, exists, resolve);
  expect(masks).toEqual(["/run/WSL", "/mnt/wsl", "/mnt/wslg", "/mnt/c", "/mnt/my data"]);
  // As a mount of its own it is masked on its own.
  expect(wslMaskPaths(view, exists)).toContain("/tmp/.X11-unix");
  expect(wslMaskPaths(view, () => false)).toEqual([]);
  expect(wslMaskPaths(null, exists)).toEqual([]);
  // A grant strictly beneath a mask is bound back on its own; the whole drive, or a grant holding one, never is.
  expect(wslGrantedUnder(masks, "/mnt/c/Users/owner/vault")).toBe(true);
  for (const whole of ["/mnt/c", "/mnt/c/", "/mnt", "/", "/home/imprnt/vault", "/mnt/cx/vault", ""]) expect(wslGrantedUnder(masks, whole), whole).toBe(false);
  // The name service's file is kept where WSL links it into its shared folder, and only there.
  const link = (path: string) => path === "/etc/resolv.conf" ? "/mnt/wsl/resolv.conf" : path;
  expect(wslKeptFiles(masks, () => true, link)).toEqual(["/mnt/wsl/resolv.conf"]);
  expect(wslKeptFiles(masks, () => true, path => path)).toEqual([]);
  expect(wslKeptFiles(masks, () => false, link)).toEqual([]);
  expect(wslKeptFiles([], () => true, link)).toEqual([]);
});

test("the rendered Linux box empties every Windows mount, binds back only a granted child in its own mode, re-masks another person under it, and adds nothing without a view", () => {
  // As the file system names it: the box resolves every path it masks.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hub-wsl-box-")));
  try {
    // Real directories stand in for the drives, because the box asks the file
    // system whether a mount point is there.
    const drive = join(dir, "mnt-c"), other = join(dir, "mnt-d"), tree = join(other, "vault"), stranger = join(other, "vault", "people", "p2");
    const prompt = join(other, "prompts"), session = join(dir, "state", "p1", "session");
    for (const path of [drive, tree, stranger, prompt, session]) mkdirSync(path, { recursive: true });
    const ctx = { agent: "a1", person: "p1", tree, otherTrees: [stranger], secretPaths: [], readPaths: [prompt], sessionDir: session };
    const view = { version: 2 as const, interop: [], windowsMounts: [drive, other] };
    const { argv } = boxCommand(["/bin/true"], ctx, "linux", { wsl: view });
    const at = (flag: string, path: string, from = 0) => argv.findIndex((a, i) => i >= from && a === flag && argv[i + 1] === path);
    const proc = at("--proc", "/proc");
    // Both drives are emptied, the one holding the tree included, after the host and the grants.
    for (const mount of [drive, other]) {
      expect(at("--tmpfs", mount)).toBeGreaterThan(proc);
      expect(at("--tmpfs", mount)).toBeGreaterThan(argv.indexOf(tree));
      expect(at("--tmpfs", mount)).toBeLessThan(argv.lastIndexOf("--"));
    }
    // Then the tree comes back writable, the prompt read-only, and nothing else of that drive.
    const masked = at("--tmpfs", other);
    expect(at("--bind", tree, masked)).toBeGreaterThan(masked);
    expect(at("--ro-bind", prompt, masked)).toBeGreaterThan(masked);
    expect(at("--bind", other, masked)).toBe(-1);
    expect(at("--ro-bind", other, masked)).toBe(-1);
    // The session is not under a mask and is not bound twice.
    expect(argv.filter((a, i) => a === session && argv[i - 1] === "--bind")).toHaveLength(1);
    // Another person's tree beneath the restored grant is emptied again, after it.
    expect(at("--tmpfs", stranger, at("--bind", tree, masked))).toBeGreaterThan(at("--bind", tree, masked));
    // A harvest keeps the restored tree read-only, as it does everywhere else.
    const harvest = boxCommand(["/bin/true"], { ...ctx, purpose: "harvest" }, "linux", { wsl: view }).argv;
    const hMasked = harvest.findIndex((a, i) => a === "--tmpfs" && harvest[i + 1] === other);
    expect(harvest.findIndex((a, i) => i > hMasked && a === "--ro-bind" && harvest[i + 1] === tree)).toBeGreaterThan(hMasked);
    expect(harvest.findIndex((a, i) => i > hMasked && a === "--bind" && harvest[i + 1] === tree)).toBe(-1);
    // A tree that IS a whole drive is never bound back over its mask.
    const whole = boxCommand(["/bin/true"], { ...ctx, tree: drive, otherTrees: [] }, "linux", { wsl: view }).argv;
    const wMasked = whole.findIndex((a, i) => a === "--tmpfs" && whole[i + 1] === drive);
    expect(wMasked).toBeGreaterThan(-1);
    expect(whole.findIndex((a, i) => i > wMasked && (a === "--bind" || a === "--ro-bind") && whole[i + 1] === drive)).toBe(-1);
    const without = boxCommand(["/bin/true"], ctx, "linux", { wsl: null }).argv;
    expect(without.includes(drive)).toBe(false);
    expect(without.includes(other)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// REAL bwrap, where there is one (CI's Ubuntu installs it): a stand-in "drive" is emptied, and only the
// granted tree and one granted FILE come back, which is the same bind a kept resolv.conf is.
const bwrapWorks = process.platform === "linux" && existsSync("/usr/bin/bwrap") &&
  Bun.spawnSync(["/usr/bin/bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "/bin/true"]).exitCode === 0;
test.skipIf(!bwrapWorks)("inside a real bwrap box a masked drive shows only its granted children, writable as granted, and another person stays empty (skipped: no working bwrap here)", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hub-wsl-real-")));
  try {
    const drive = join(dir, "drive"), tree = join(drive, "vault"), stranger = join(tree, "people", "p2"), prompt = join(drive, "prompts", "p.md");
    for (const path of [tree, stranger, join(drive, "prompts")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(drive, "secret.txt"), "the rest of the drive");
    writeFileSync(join(tree, "note.txt"), "the tree");
    writeFileSync(join(stranger, "theirs.txt"), "another person");
    writeFileSync(prompt, "the prompt");
    const view = { version: 2 as const, interop: [], windowsMounts: [drive] };
    const script = [`cat ${tree}/note.txt; echo`, `cat ${prompt}; echo`, `ls -A ${drive} | tr '\\n' ' '; echo`,
      `cat ${drive}/secret.txt 2>&1; echo`, `ls -A ${stranger} | wc -l`, `touch ${tree}/made && echo wrote`].join("; ");
    const { argv } = boxCommand(["/bin/sh", "-c", script], { agent: "a1", person: "p1", tree, otherTrees: [stranger], secretPaths: [], readPaths: [prompt] }, "linux", { wsl: view });
    const ran = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
    const said = ran.stdout.toString().split("\n");
    expect({ code: ran.exitCode, err: ran.stderr.toString() }).toEqual({ code: 0, err: "" });
    expect(said[0]).toBe("the tree");
    expect(said[1]).toBe("the prompt");
    expect(said[2].trim().split(" ").sort()).toEqual(["prompts", "vault"]);
    expect(said[3]).not.toContain("the rest of the drive");
    expect(said[4].trim()).toBe("0");
    expect(said[5]).toBe("wrote");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
