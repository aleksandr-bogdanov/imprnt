import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { tmpdir } from "node:os";
import { listCredentials, listPeople, listRepositories } from "../registry/entries.ts";
import { readSetting, type Registry } from "../registry/load.ts";

export const contains = (root: string, path: string): boolean => root === "/" || path === root || path.startsWith(`${root}/`);
/** Protected code/configuration is never resolved through a replaceable link or a writable parent. */
export function protectedPath(path: string, registry?: Registry, privateFile = false): string {
  if (!isAbsolute(path) || resolve(path) !== path || realpathSync(path) !== path) throw new Error("outbound-path-unprotected");
  const roots = [realpathSync(tmpdir()), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp",
    ...(registry ? [String(readSetting(registry,"hub.state_dir") ?? ""),
      ...listPeople(registry).map(p=>p.tree ?? ""), ...listRepositories(registry).map(r=>r.path),
      ...listCredentials(registry).filter(c=>c.kind==="claude-login").map(c=>dirname(c.file))] : [])].filter(Boolean);
  for (const root of roots) {
    let canonical = resolve(root); try { canonical = realpathSync(root); } catch { /* A missing declaration still protects its lexical path. */ }
    if (contains(canonical,path) || contains(path,canonical)) throw new Error("outbound-path-unprotected");
  }
  const owner = process.getuid?.();
  for (let at=path;;at=dirname(at)) {
    const info=lstatSync(at);
    if (info.isSymbolicLink() || (info.uid!==owner && info.uid!==0) || (info.mode & 0o022)!==0) throw new Error("outbound-path-unprotected");
    if (at==="/") break;
  }
  const info=lstatSync(path);
  if (privateFile && (!info.isFile() || info.uid!==owner || (info.mode & 0o077)!==0)) throw new Error("outbound-config-unprotected");
  return path;
}
export function privateRootFor(file: string, registry: Registry): string {
  protectedPath(file,registry,true);
  const root=dirname(file), info=lstatSync(root);
  if (!info.isDirectory() || info.uid!==process.getuid?.() || (info.mode & 0o077)!==0) throw new Error("outbound-config-unprotected");
  return root;
}
export function privateOptions(options: Record<string,unknown> | undefined, root: string, registry?: Registry): void {
  for (const key of ["module","source_dir","fixtures"]) {
    const path=options?.[key];
    if (path===undefined) continue;
    if (typeof path!=="string" || !contains(root,protectedPath(path,registry))) throw new Error("outbound-private-path-unprotected");
  }
  const argv=options?.token_argv;
  if (argv!==undefined) {
    if (!Array.isArray(argv) || !argv.length || argv.some(v=>typeof v!=="string") || !isAbsolute(argv[0])) throw new Error("outbound-token-command-unprotected");
    for (const arg of argv as string[]) {
      const path=arg.startsWith("/") ? arg : arg.includes("=/") ? arg.slice(arg.indexOf("=")+1) : null;
      if (path) protectedPath(path,registry);
    }
  }
}
