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
/** A TOML key as a person writes it: bare where the grammar allows, quoted otherwise. */
function key(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name);
}

const isTable = (item: unknown): item is Record<string, unknown> =>
  item !== null && typeof item === "object" && !Array.isArray(item);

/** An array of tables, which is what renders as one `[[name]]` block per element. */
const isTableArray = (item: unknown): item is Record<string, unknown>[] =>
  Array.isArray(item) && item.length > 0 && item.every(isTable);

/**
 * The registry as TOML, in the layout the hand-written file uses and the
 * registry editor works on: one `[[table]]` header per entry, one `[table]` per
 * plain table, one `[table.name]` per named sub-table such as a preset, and a
 * `key = value` line per key. A table nested inside an entry, such as a
 * person's `allowed_senders`, is an inline table on that entry's line.
 *
 * The editor locates an entry by its own header line and refuses a file that
 * has none, so a file written any other way could be loaded and never edited.
 */
export function toml(value: Record<string, unknown>): string {
  const atom = (item: any): string => {
    if (Array.isArray(item)) return `[${item.map(atom).join(", ")}]`;
    if (item && typeof item === "object") return `{ ${Object.entries(item).filter(([, v]) => v !== undefined).map(([k, v]) => `${key(k)} = ${atom(v)}`).join(", ")} }`;
    if (["string", "boolean", "number"].includes(typeof item)) return JSON.stringify(item);
    throw new Error("invalid registry value");
  };
  const keyLines = (table: Record<string, unknown>): string[] =>
    Object.entries(table).filter(([, v]) => v !== undefined).map(([k, v]) => `${key(k)} = ${atom(v)}`);
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  const blocks: string[][] = [];
  // Bare keys come first: a key after a header would belong to that table.
  const bare = entries.filter(([, item]) => !isTable(item) && !isTableArray(item));
  if (bare.length > 0) blocks.push(bare.map(([k, item]) => `${key(k)} = ${atom(item)}`));
  for (const [name, item] of entries) {
    if (isTableArray(item)) {
      for (const entry of item) blocks.push([`[[${key(name)}]]`, ...keyLines(entry)]);
    } else if (isTable(item)) {
      const plain = Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined && !isTable(v)));
      const named = Object.entries(item).filter(([, v]) => isTable(v));
      if (Object.keys(plain).length > 0 || named.length === 0) blocks.push([`[${key(name)}]`, ...keyLines(plain)]);
      for (const [sub, table] of named) blocks.push([`[${key(name)}.${key(sub)}]`, ...keyLines(table as Record<string, unknown>)]);
    }
  }
  return blocks.map(block => block.join("\n")).join("\n\n") + "\n";
}
