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
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readWslView, wslMaskPaths, wslViewFrom, WSL_RUNTIME_MASKS, type WslSources } from "../src/os/wsl.ts";
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
  expect(wslViewFrom({ ...WSL2, osrelease: "6.12.25+rpt-rpi-2712\n" })).toBeNull();
  expect(wslViewFrom({ ...WSL2, osrelease: null })).toBeNull();
  expect(wslViewFrom({ ...WSL2, osrelease: "4.4.0-19041-Microsoft\n" })?.version).toBe(1);
  // The suite runs on the Mac and on CI's Ubuntu, neither of them a WSL guest.
  expect(readWslView()).toBeNull();
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

test("the masks are WSL's runtime folders and the Windows drives that exist, resolved, never over a granted path, and none off WSL", () => {
  const view = wslViewFrom(WSL2)!;
  const present = new Set(["/run/WSL", "/mnt/wsl", "/mnt/wslg", "/tmp/.X11-unix", "/mnt/c", "/mnt/my data"]);
  const exists = (path: string) => present.has(path);
  // WSLg's X socket directory as a link into its own folder: covered already.
  const resolve = (path: string) => path === "/tmp/.X11-unix" ? "/mnt/wslg/.X11-unix" : path;
  expect([...WSL_RUNTIME_MASKS]).toEqual(["/run/WSL", "/mnt/wsl", "/mnt/wslg", "/tmp/.X11-unix"]);
  expect(wslMaskPaths(view, ["/home/imprnt/vault"], exists, resolve)).toEqual(["/run/WSL", "/mnt/wsl", "/mnt/wslg", "/mnt/c", "/mnt/my data"]);
  // As a mount of its own it is masked on its own.
  expect(wslMaskPaths(view, [], exists)).toContain("/tmp/.X11-unix");
  // A tree kept on a Windows drive stays reachable: that drive is not masked.
  expect(wslMaskPaths(view, ["/mnt/c/Users/owner/vault"], exists, resolve)).toEqual(["/run/WSL", "/mnt/wsl", "/mnt/wslg", "/mnt/my data"]);
  expect(wslMaskPaths(view, [], () => false)).toEqual([]);
  expect(wslMaskPaths(null, [], exists)).toEqual([]);
});

test("the rendered Linux box empties a WSL host's Windows mount with a tmpfs among the last masks, keeps a granted one, and adds nothing without a view", () => {
  // As the file system names it: the box resolves every path it masks.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hub-wsl-box-")));
  try {
    // Real directories stand in for the drives, because the box asks the file
    // system whether a mount point is there.
    const drive = join(dir, "mnt-c"), other = join(dir, "mnt-d"), tree = join(dir, "mnt-d", "vault");
    for (const path of [drive, tree]) mkdirSync(path, { recursive: true });
    const ctx = { agent: "a1", person: "p1", tree, otherTrees: [], secretPaths: [] };
    const view = { version: 2 as const, interop: [], windowsMounts: [drive, other] };
    const { argv } = boxCommand(["/bin/true"], ctx, "linux", { wsl: view });
    const tmpfsAt = (path: string) => argv.findIndex((a, i) => a === "--tmpfs" && argv[i + 1] === path);
    expect(tmpfsAt(drive)).toBeGreaterThan(argv.findIndex((a, i) => a === "--proc" && argv[i + 1] === "/proc"));
    expect(tmpfsAt(drive)).toBeGreaterThan(argv.indexOf(tree));
    expect(tmpfsAt(drive)).toBeLessThan(argv.lastIndexOf("--"));
    expect(tmpfsAt(other)).toBe(-1);
    const without = boxCommand(["/bin/true"], ctx, "linux", { wsl: null }).argv;
    expect(without.includes(drive)).toBe(false);
    expect(argv.length - without.length).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
