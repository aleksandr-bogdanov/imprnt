// Test hubs share a real user manager with the owner. A directory is not an
// ownership boundary (systemd fixtures use its shared search directory).
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import type { OsSeam, UnitFile } from "../../src/os/types.ts";
import { parsePlistDict } from "./plist.ts";

const PREFIX = "imprnt-hub-";

/** Only exact fixture registrations may reach the underlying manager. */
export function ownedOs(inner: OsSeam, unitDir: string, ownershipFile: string): OsSeam {
  if (!isAbsolute(unitDir) || !isAbsolute(ownershipFile)) throw new Error("fixture ownership paths are required");
  const directory = resolve(unitDir);
  const owned = (): Set<string> => {
    const data = JSON.parse(readFileSync(ownershipFile, "utf8"));
    if (data.unitDir !== directory || !Array.isArray(data.names) ||
        data.names.some((name: unknown) => typeof name !== "string" || !/^imprnt-[a-zA-Z0-9_-]+$/.test(name))) {
      throw new Error("invalid fixture ownership manifest");
    }
    return new Set(data.names);
  };
  owned(); // Fail before runHub can open a store or start its reconciliation.
  const baseOf = (name: string): string => inner.flavour === "launchd"
    ? name.replace(/\.plist$/, "") : name.replace(/\.(service|timer)$/, "");
  const requireEntry = (id: string): void => {
    if (!owned().has(`${PREFIX}${id}`)) throw new Error(`fixture refused foreign unit: ${id}`);
  };
  const ownsPath = (path: string, names: Set<string>): boolean => {
    const suffix = inner.flavour === "launchd" ? /\.plist$/ : /\.(service|timer)$/;
    return isAbsolute(path) && dirname(resolve(path)) === directory && suffix.test(path) &&
      names.has(baseOf(basename(path)));
  };
  const checkFiles = (files: UnitFile[]): void => {
    const names = owned();
    for (const file of files) {
      const base = baseOf(basename(file.path));
      if (!base.startsWith(PREFIX) || !ownsPath(file.path, names)) throw new Error(`fixture refused foreign file: ${file.path}`);
      if (lstatSync(file.path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("fixture refused symlink unit file");
      if (inner.flavour === "launchd" && parsePlistDict(file.text).Label !== base) throw new Error("fixture refused foreign plist Label");
      if (file.path.endsWith(".timer")) {
        const targets = [...file.text.matchAll(/^Unit=(.*)$/gm)].map(match => match[1].trim());
        if (targets.length !== 1 || targets[0] !== `${base}.service`) throw new Error("fixture refused foreign timer target");
      }
    }
  };
  return {
    flavour: inner.flavour,
    render(entry, context) { requireEntry(entry.id); const files = inner.render(entry, context); checkFiles(files); return files; },
    async install(files) { checkFiles(files); return await inner.install(files); },
    async start(id) { requireEntry(id); await inner.start(id); },
    async stop(id) { requireEntry(id); await inner.stop(id); },
    async restart(id) { requireEntry(id); await inner.restart(id); },
    async remove(id) { requireEntry(id); await inner.remove(id); },
    async show(id) { requireEntry(id); return await inner.show(id); },
    async list() {
      const names = owned();
      return (await inner.list()).filter(unit => inner.flavour === "launchd"
        ? names.has(unit.name) : /\.(service|timer)$/.test(unit.name) && names.has(baseOf(unit.name)));
    },
    async unitFiles() {
      const names = owned();
      return (await inner.unitFiles?.() ?? []).filter(path => ownsPath(path, names));
    },
    memory: pid => inner.memory(pid),
    available: () => inner.available(),
  };
}
