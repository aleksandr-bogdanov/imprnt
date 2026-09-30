// Only a fake manager is used here: a broken fence must never reach launchctl
// or systemctl while its refusal is being tested.
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OsSeam, RenderContext, UnitFile, UnitState } from "../src/os/types.ts";
import type { RunEntry } from "../src/registry/load.ts";
import { ownedOs } from "./helpers/owned-os.ts";

function fixture(flavour: OsSeam["flavour"]) {
  // Foreign and owned files deliberately share a directory, as on Linux.
  const dir = mkdtempSync(join(tmpdir(), "owned-os-"));
  const manifest = join(dir, "ownership.json");
  const own = "imprnt-hub-fixture-12345678";
  const stale = "imprnt-hub-stale-12345678";
  const stray = "imprnt-stray-12345678";
  const foreign = "imprnt-hub-live-owner";
  const names = [own, stale, stray];
  const publish = () => writeFileSync(manifest, JSON.stringify({ unitDir: dir, names }));
  publish();
  const suffix = flavour === "launchd" ? ".plist" : ".service";
  const unit = (base: string) => flavour === "launchd" ? base : `${base}.service`;
  const file = (base: string): UnitFile => ({ path: join(dir, `${base}${suffix}`), text: flavour === "launchd"
    ? `<plist><dict><key>Label</key><string>${base}</string></dict></plist>` : "[Service]\nExecStart=/usr/bin/true\n" });
  const files = [own, stale, stray, foreign].map(file);
  files.forEach(f => writeFileSync(f.path, f.text));
  const states = [own, stale, stray, foreign, `${own}-other`, `${own}.plist`].map(base => ({ name: unit(base) } as UnitState));
  const calls: string[] = [];
  const inner: OsSeam = {
    flavour,
    render: entry => [file(`imprnt-hub-${entry.id}`)],
    async install(files) { calls.push("install"); return files.map(f => f.path); },
    async start(id) { calls.push(`start:${id}`); }, async stop(id) { calls.push(`stop:${id}`); },
    async restart(id) { calls.push(`restart:${id}`); }, async remove(id) { calls.push(`remove:${id}`); },
    async show(id) { calls.push(`show:${id}`); return { name: unit(`imprnt-hub-${id}`) } as UnitState; },
    async list() { return states; }, async unitFiles() { return files.map(f => f.path); },
    async memory() { return { current_bytes: 0, peak_bytes: 0, source: "ps-rss" }; },
    async available() { return { ok: true, reason: "fake manager" }; },
  };
  return { dir, manifest, own, stale, stray, foreign, names, publish, unit, file, states, files, calls, inner,
    os: ownedOs(inner, dir, manifest), close: () => rmSync(dir, { recursive: true, force: true }) };
}

for (const flavour of ["launchd", "systemd"] as const) {
  test(`${flavour} fixture sees registered stale and stray units but never foreign units sharing its directory`, async () => {
    const f = fixture(flavour);
    try {
      expect((await f.os.list()).map(row => row.name)).toEqual([f.own, f.stale, f.stray].map(f.unit));
      expect(await f.os.unitFiles!()).toEqual([f.own, f.stale, f.stray].map(base => f.file(base).path));
      // No registry is consulted: an owned unit removed from it must still be
      // visible and removable by the real Hub's stale reconciliation.
      await f.os.remove(f.stale.slice("imprnt-hub-".length));
      expect(f.calls).toEqual(["remove:stale-12345678"]);
      f.names.push("imprnt-hub-added-12345678"); f.publish();
      f.states.push({ name: f.unit("imprnt-hub-added-12345678") } as UnitState);
      expect((await f.os.list()).map(row => row.name)).toContain(f.unit("imprnt-hub-added-12345678"));
      await f.os.start("added-12345678");
      expect(f.calls).toContain("start:added-12345678");
    } finally { f.close(); }
  });

  test(`${flavour} fixture denies every foreign mutation and read before delegation`, async () => {
    const f = fixture(flavour);
    try {
      for (const id of ["live-owner", "fixture-12345678-other", "fixture-12345678.service", "../live-owner", f.stray]) {
        for (const verb of ["start", "stop", "restart", "remove", "show"] as const) {
          await expect(f.os[verb](id)).rejects.toThrow("fixture refused foreign unit");
        }
        // Loading a unit is as much the manager's business as starting one.
        await expect(f.os.load!(id, "scheduled")).rejects.toThrow("fixture refused foreign unit");
        expect(() => f.os.render({ id } as RunEntry, {} as RenderContext)).toThrow("fixture refused foreign unit");
      }
      // Validate the whole batch before any owned prefix of it can be installed.
      await expect(f.os.install([f.file(f.own), f.file(f.foreign)])).rejects.toThrow("fixture refused foreign file");
      await expect(f.os.install([f.file(f.stray)])).rejects.toThrow("fixture refused foreign file");
      await expect(f.os.install([{ ...f.file(f.own), path: join(f.dir, "elsewhere", `${f.own}.service`) }])).rejects.toThrow();
      if (flavour === "launchd") {
        await expect(f.os.install([{ ...f.file(f.own), text: f.file(f.foreign).text }])).rejects.toThrow("foreign plist Label");
      } else {
        await expect(f.os.install([{ path: join(f.dir, `${f.own}.timer`), text: `[Timer]\nUnit=${f.foreign}.service\n` }])).rejects.toThrow("foreign timer target");
      }
      rmSync(f.file(f.own).path);
      symlinkSync(f.file(f.foreign).path, f.file(f.own).path);
      await expect(f.os.install([f.file(f.own)])).rejects.toThrow("symlink unit file");
      expect(f.calls).toEqual([]);
    } finally { f.close(); }
  });

  test(`${flavour} owned operations delegate and lost or malformed ownership fails closed`, async () => {
    const f = fixture(flavour);
    try {
      const rendered = f.os.render({ id: "fixture-12345678" } as RunEntry, {} as RenderContext);
      await f.os.install(rendered);
      for (const verb of ["start", "stop", "restart", "remove", "show"] as const) await f.os[verb]("fixture-12345678");
      expect(f.calls).toEqual(["install", "start:fixture-12345678", "stop:fixture-12345678", "restart:fixture-12345678", "remove:fixture-12345678", "show:fixture-12345678"]);
      f.calls.length = 0;
      for (const text of ["{}", "not json", JSON.stringify({ unitDir: "/wrong", names: f.names })]) {
        writeFileSync(f.manifest, text);
        expect(() => ownedOs(f.inner, f.dir, f.manifest)).toThrow();
        for (const verb of ["start", "stop", "restart", "remove"] as const) await expect(f.os[verb]("fixture-12345678")).rejects.toThrow();
        await expect(f.os.install(rendered)).rejects.toThrow();
        await expect(f.os.list()).rejects.toThrow();
      }
      rmSync(f.manifest);
      expect(() => ownedOs(f.inner, f.dir, f.manifest)).toThrow();
      await expect(f.os.start("fixture-12345678")).rejects.toThrow();
      expect(() => ownedOs(f.inner, f.dir, "")).toThrow("ownership paths are required");
      expect(f.calls).toEqual([]);
    } finally { f.close(); }
  });
}
