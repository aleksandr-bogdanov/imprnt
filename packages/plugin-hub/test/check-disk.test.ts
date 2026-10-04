// Check: a filesystem this machine writes the household onto is running out of room.
//
// PURE, BOTH PLATFORMS, NO STORE. The calculation is asked directly, and the
// findings are asked through a planted seam, because the box running the suite
// has whatever room it has and a check that read it could only assert that.
// The real seam is read once as a control: it must answer for the suite's own
// temporary directory, and what it answers must be a reading the calculation
// accepts.

import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diskFindings, diskVerdict, realDiskSeam, type DiskSeam, type DiskStat } from "../src/check/disk.ts";
import { loadRegistry, readSetting, RegistryRefused } from "../src/registry/load.ts";

const MIB = 1024n * 1024n;
const GIB = 1024n * MIB;

/** A seam over planted filesystems: `devices` maps an existing path to its filesystem, `stats` a filesystem to its counters. */
function planted(
  devices: Record<string, string>,
  stats: Record<string, DiskStat | Error>,
  errors: Record<string, string> = {},
): DiskSeam & { statted: string[] } {
  const statted: string[] = [];
  const fail = (code: string) => Object.assign(new Error(`${code}: planted`), { code });
  return {
    statted,
    device(path) {
      if (errors[path]) throw fail(errors[path]);
      const found = devices[path];
      if (found === undefined) throw fail("ENOENT");
      return found;
    },
    statfs(path) {
      statted.push(path);
      const stat = stats[devices[path]];
      if (stat instanceof Error) throw stat;
      return stat;
    },
  };
}

const base = { minMb: 5120, minPercent: 10, machine: "pi", registryFile: "/etc/hub.toml" };

test("the byte floor: exactly 5 GiB available is not low, one byte under it is, and the percentage is judged on its own", () => {
  // A one-byte block makes the edge exact to the byte, and a total five times the room keeps the percentage at 20%.
  const at = diskVerdict({ bsize: 1n, blocks: 5n * 5120n * MIB, bavail: 5120n * MIB }, 5120, 10);
  expect(at).toMatchObject({ valid: true, low: false, byBytes: false, byPercent: false });
  const under = diskVerdict({ bsize: 1n, blocks: 5n * 5120n * MIB, bavail: 5120n * MIB - 1n }, 5120, 10);
  expect(under).toMatchObject({ valid: true, low: true, byBytes: true, byPercent: false });
});

test("the percentage floor: exactly 10% is not low, one block under it is, with plenty of bytes either way", () => {
  const at = diskVerdict({ bsize: GIB, blocks: 1000n, bavail: 100n }, 5120, 10);
  expect(at).toMatchObject({ valid: true, low: false, byBytes: false, byPercent: false });
  const under = diskVerdict({ bsize: GIB, blocks: 1000n, bavail: 99n }, 5120, 10);
  expect(under).toMatchObject({ valid: true, low: true, byBytes: false, byPercent: true });
  // Both at once, and both are said.
  const both = diskVerdict({ bsize: MIB, blocks: 100_000n, bavail: 1000n }, 5120, 10);
  expect(both).toMatchObject({ valid: true, low: true, byBytes: true, byPercent: true });
});

test("block counts past 2^53 are compared exactly: one block under 10% of 10^18 blocks is low, where a float would round it to the floor", () => {
  const blocks = 10n ** 18n;
  expect(Number(blocks / 10n - 1n) * 10 === Number(blocks)).toBe(true); // the float cannot tell them apart
  const at = diskVerdict({ bsize: 4096n, blocks, bavail: blocks / 10n }, 5120, 10);
  expect(at).toMatchObject({ valid: true, low: false });
  const under = diskVerdict({ bsize: 4096n, blocks, bavail: blocks / 10n - 1n }, 5120, 10);
  expect(under).toMatchObject({ valid: true, low: true, byPercent: true, byBytes: false });
  if (under.valid) expect(under.availableBytes).toBe((blocks / 10n - 1n) * 4096n);
});

test("plain numbers are read the same as bigints", () => {
  expect(diskVerdict({ bsize: 4096, blocks: 1_000_000, bavail: 50_000 }, 5120, 10)).toMatchObject({ valid: true, low: true });
  expect(diskVerdict({ bsize: 4096, blocks: 10_000_000, bavail: 5_000_000 }, 5120, 10)).toMatchObject({ valid: true, low: false });
});

test("a reading that cannot be judged is neither full nor empty: no size, no block size, more available than total, or counts that are not whole", () => {
  for (const stat of [
    { bsize: 4096n, blocks: 0n, bavail: 0n },
    { bsize: 0n, blocks: 100n, bavail: 10n },
    { bsize: 4096n, blocks: 100n, bavail: 101n },
    { bsize: 4096n, blocks: 100n, bavail: -1n },
    { bsize: 4096, blocks: Number.NaN, bavail: 1 },
    { bsize: 4096, blocks: 100.5, bavail: 1 },
    { bsize: 4096, blocks: 2 ** 60, bavail: 1 },
    undefined as unknown as DiskStat,
  ]) {
    const verdict = diskVerdict(stat, 5120, 10);
    expect(verdict.valid).toBe(false);
    if (!verdict.valid) expect(verdict.reason.length).toBeGreaterThan(0);
  }
  // A completely full filesystem is a reading, and a low one.
  expect(diskVerdict({ bsize: 4096n, blocks: 100n, bavail: 0n }, 5120, 10)).toMatchObject({ valid: true, low: true });
});

test("paths on one filesystem are read once and reported once, by the first path, naming the others", () => {
  const seam = planted(
    { "/var/lib/hub": "sd", "/var/lib/hub/secrets": "sd", "/home/p1/tree": "sd", "/mnt/usb/vault": "usb" },
    { sd: { bsize: 4096n, blocks: 7_000_000n, bavail: 100_000n }, usb: { bsize: 4096n, blocks: 100_000_000n, bavail: 50_000_000n } },
  );
  const out = diskFindings({ ...base, seam, paths: ["/var/lib/hub", "/var/lib/hub/secrets", "/home/p1/tree", "/mnt/usb/vault", "/var/lib/hub"] });
  expect(seam.statted).toEqual(["/var/lib/hub", "/mnt/usb/vault"]);
  expect(out.length).toBe(1);
  const [low] = out;
  expect(low.kind).toBe("disk-low");
  expect(low.id).toBe("pi/disk-low:/var/lib/hub");
  expect(low.subject).toBe("/var/lib/hub");
  expect(low.machine).toBe("pi");
  expect(low.says).toContain("/var/lib/hub/secrets, /home/p1/tree");
  expect(low.says).toContain("0.3 GiB");
  expect(low.says).toContain("1.4%");
  expect(low.says).toContain("5120 MiB and 10%");
  expect(low.fix).toContain("hub.disk_free_min_mb");
  expect(low.fix).toContain("/etc/hub.toml");
});

test("a healthy filesystem says nothing, and an empty or relative path is never read", () => {
  const seam = planted({ "/var/lib/hub": "sd" }, { sd: { bsize: 4096n, blocks: 10_000_000n, bavail: 5_000_000n } });
  expect(diskFindings({ ...base, seam, paths: ["/var/lib/hub", "", "relative/tree"] })).toEqual([]);
  expect(seam.statted).toEqual(["/var/lib/hub"]);
  expect(diskFindings({ ...base, seam, paths: [] })).toEqual([]);
});

test("a directory not made yet is read on its nearest existing parent's filesystem, and joins that parent's group", () => {
  const seam = planted({ "/var/lib": "sd" }, { sd: { bsize: 4096n, blocks: 1000n, bavail: 1n } });
  const out = diskFindings({ ...base, seam, paths: ["/var/lib/hub/new/deeper", "/var/lib/hub/also"] });
  expect(seam.statted).toEqual(["/var/lib"]);
  expect(out.map((f) => f.id)).toEqual(["pi/disk-low:/var/lib/hub/new/deeper"]);
  expect(out[0].says).toContain("/var/lib/hub/also");
});

test("an unreadable path or filesystem is its own bounded finding, and the readable ones are still judged", () => {
  const seam = planted(
    { "/a": "fa", "/b": "fb", "/c": "fc", "/e": "fe" },
    {
      fa: Object.assign(new Error("statfs is not here"), { code: "ENOSYS" }),
      fb: { bsize: 4096n, blocks: 0n, bavail: 0n },
      fc: { bsize: 4096n, blocks: 1000n, bavail: 1n },
      fe: { bsize: 4096n, blocks: 10_000_000n, bavail: 5_000_000n },
    },
    { "/d": "EACCES" },
  );
  const out = diskFindings({ ...base, seam, paths: ["/a", "/b", "/c", "/d", "/e", "/nowhere/at/all"] });
  const by = new Map(out.map((f) => [f.subject, f]));
  expect(by.get("/a")?.kind).toBe("disk-unreadable");
  expect(by.get("/a")?.says).toContain("ENOSYS");
  expect(by.get("/b")?.kind).toBe("disk-unreadable");
  expect(by.get("/b")?.says).toContain("no size");
  expect(by.get("/c")?.kind).toBe("disk-low");
  expect(by.get("/d")?.kind).toBe("disk-unreadable");
  expect(by.get("/d")?.says).toContain("EACCES");
  expect(by.has("/e")).toBe(false);
  // Every parent up to the root was missing: said, and not thrown.
  expect(by.get("/nowhere/at/all")?.kind).toBe("disk-unreadable");
  expect(out.length).toBe(5);
});

test("the fix quotes a path a person pastes, so a shell reads it as a path and nothing else", () => {
  const nasty = "/srv/it's $(touch x) `y`";
  const seam = planted({}, {}, { [nasty]: "EACCES" });
  const [one] = diskFindings({ ...base, seam, paths: [nasty] });
  expect(one.fix).toContain(`df -h '/srv/it'\\''s $(touch x) \`y\`'`);
});

test("the two settings default for a file that sets neither, are read when set, and a percentage over 100 is refused by key", () => {
  const dir = mkdtempSync(join(tmpdir(), "hub-disk-"));
  try {
    const write = (lines: string[]) => {
      const file = join(dir, `${Math.random().toString(36).slice(2)}.toml`);
      writeFileSync(file, lines.join("\n") + "\n");
      return file;
    };
    const bare = loadRegistry(write(["[hub]", "tick_seconds = 5"]));
    expect(readSetting(bare, "hub.disk_free_min_mb")).toBe(5120);
    expect(readSetting(bare, "hub.disk_free_min_percent")).toBe(10);
    const set = loadRegistry(write(["[hub]", "tick_seconds = 5", "disk_free_min_mb = 1024", "disk_free_min_percent = 100"]));
    expect(readSetting(set, "hub.disk_free_min_mb")).toBe(1024);
    expect(readSetting(set, "hub.disk_free_min_percent")).toBe(100);
    for (const bad of ["disk_free_min_percent = 101", "disk_free_min_percent = 0", "disk_free_min_mb = -1", 'disk_free_min_mb = "5G"']) {
      let refused: unknown;
      try { loadRegistry(write(["[hub]", "tick_seconds = 5", bad])); } catch (error) { refused = error; }
      expect(refused).toBeInstanceOf(RegistryRefused);
      expect((refused as RegistryRefused).key).toBe(`hub.${bad.split(" ")[0]}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the real box answers for the suite's own temporary directory with a reading the calculation accepts", () => {
  const seam = realDiskSeam();
  const dir = mkdtempSync(join(tmpdir(), "hub-disk-real-"));
  try {
    expect(typeof seam.device(dir)).toBe("string");
    const verdict = diskVerdict(seam.statfs(dir), 5120, 10);
    expect(verdict.valid).toBe(true);
    // Whatever room this box has, the findings are one at most, and never an unreadable one.
    const out = diskFindings({ ...base, seam, paths: [dir, join(dir, "not-made-yet")] });
    expect(out.length).toBeLessThanOrEqual(1);
    expect(out.every((f) => f.kind === "disk-low")).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
