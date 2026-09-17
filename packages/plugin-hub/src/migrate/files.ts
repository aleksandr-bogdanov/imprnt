import { existsSync, readFileSync, realpathSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";

export function absolute(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error("absolute path required");
  return path;
}
export function canonical(path: string): string {
  absolute(path);
  return existsSync(path) ? realpathSync(path) : join(canonical(dirname(path)), path.slice(dirname(path).length + 1));
}
export function within(path: string, root: string): boolean {
  const part = relative(canonical(root), canonical(path));
  return part === "" || (!part.startsWith("../") && !isAbsolute(part));
}
export function digest(bytes: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}
export function version(manifest: { version: number }): void {
  if (manifest.version !== 1) throw new Error("manifest version must be 1");
}
export function verifyInventory(items: { path: string; sha256: string }[]): void {
  for (const item of items) {
    if (digest(readFileSync(absolute(item.path))) !== item.sha256) throw new Error(`source digest changed: ${item.path}`);
  }
}
export function writePrivate(file: string, bytes: string | Uint8Array): void {
  absolute(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temp, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, file);
  const dir = openSync(dirname(file), "r");
  try { fsyncSync(dir); } finally { closeSync(dir); }
}
export function readManifest(file: string): any {
  const value = JSON.parse(readFileSync(absolute(file), "utf8"));
  version(value);
  return value;
}
export function toml(value: Record<string, unknown>): string {
  const atom = (item: any): string => {
    if (Array.isArray(item)) return `[${item.map(atom).join(", ")}]`;
    if (item && typeof item === "object") return `{ ${Object.entries(item).filter(([, v]) => v !== undefined).map(([k, v]) => `${JSON.stringify(k)} = ${atom(v)}`).join(", ")} }`;
    if (["string", "boolean", "number"].includes(typeof item)) return JSON.stringify(item);
    throw new Error("invalid registry value");
  };
  return Object.entries(value).map(([key, item]) => `${JSON.stringify(key)} = ${atom(item)}`).join("\n") + "\n";
}
