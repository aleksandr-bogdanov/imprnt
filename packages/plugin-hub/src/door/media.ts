import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import type { MediaRef, Platform } from "./platform.ts";
import { safeValue } from "./lines.ts";

export interface SavedMedia {
  path: string;
  failed: boolean;
  kind: MediaRef["kind"];
  name: string;
  sha256: string;
}

function digest(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function syncDirectory(path: string): void {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** Check every component, including existing destinations, before following it. */
function directory(path: string, root: string): void {
  const parent = dirname(path);
  if (path !== root) directory(parent, root);
  if (!existsSync(path)) {
    // lstat also sees a dangling link, which existsSync intentionally does not.
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("media-symlink-refused"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    syncDirectory(parent);
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("media-directory-refused");
}

function noLink(path: string): void {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("media-file-refused");
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

function publish(path: string, bytes: Uint8Array | string): void {
  noLink(path);
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, path); syncDirectory(dirname(path)); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/** Durable files are verified on replay, including a replay after precommit death. */
export async function saveMedia(options: {
  stateDir: string; person: string; inboundId: string; index: number;
  media: MediaRef; maxBytes: number; platform: Pick<Platform, "fetchMedia">;
}): Promise<SavedMedia> {
  const { media, maxBytes } = options;
  if (!options.person || basename(options.person) !== options.person || options.person === "." || options.person === ".." ||
      options.person.includes("\\") || !Number.isSafeInteger(options.index) || options.index < 0) throw new Error("media-path-refused");
  const root = resolve(options.stateDir);
  const dir = join(root, options.person, "inbox", digest(options.inboundId));
  if (!dir.startsWith(root + sep)) throw new Error("media-path-refused");
  directory(dir, root);
  const extension = extname(media.name).slice(1).toLowerCase();
  const ext = /^[a-z0-9]{1,10}$/.test(extension) ? extension : "bin";
  const path = join(dir, `${options.index}.${ext}`);
  const receipt = join(dir, `${options.index}.receipt.json`);
  const descriptor = join(dir, `${options.index}.failure.json`);
  for (const file of [path, receipt, descriptor]) noLink(file);
  const identity = digest(JSON.stringify(media));
  const name = safeValue(media.name);
  try {
    const saved = JSON.parse(readFileSync(receipt, "utf8"));
    const bytes = readFileSync(path);
    if (saved.identity === identity && bytes.length <= maxBytes && digest(bytes) === saved.sha256) {
      return { path, failed: false, kind: media.kind, name, sha256: saved.sha256 };
    }
  } catch { /* A missing or damaged receipt requires another download. */ }
  let bytes: Uint8Array;
  try {
    if (media.name.includes("/") || media.name.includes("\\") || media.name === ".." || /[\x00-\x1f]/.test(media.name)) throw new Error("unsafe-name");
    if (media.bytes !== null && (media.bytes < 0 || media.bytes > maxBytes)) throw new Error("media-size");
    if (!options.platform.fetchMedia) throw new Error("media-unavailable");
    const response = await options.platform.fetchMedia(media);
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("media-unavailable"); }
    const length = response.headers.get("content-length");
    if (length !== null && Number(length) > maxBytes) { await response.body.cancel(); throw new Error("media-size"); }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.length;
        if (size > maxBytes) throw new Error("media-size");
        chunks.push(next.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    // A body shorter than the response's own length, or shorter than what
    // the platform advertised, is cut off. A LONGER body than advertised is
    // whole: Discord reports one size for a phone photo and serves a larger
    // file, so holding the body to that exact number threw every such photo away.
    if ((length !== null && size !== Number(length)) || (media.bytes !== null && size < media.bytes)) throw new Error("media-truncated");
    bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  } catch (error) {
    // Remote failures may include authorization or signed URLs. Never persist
    // them. The door's own named causes carry no such thing, so a record
    // says which check failed; anything else is a bare fetch failure.
    const said = error instanceof Error ? error.message : "";
    const cause = /^media-[a-z-]+$/.test(said) ? said : "media-save-failed";
    process.stderr.write(`media-save-failed: ${media.kind} ${name}: ${cause}\n`);
    const content = JSON.stringify({ kind: media.kind, name, cause }) + "\n";
    publish(descriptor, content);
    return { path: descriptor, failed: true, kind: media.kind, name, sha256: digest(content) };
  }
  const sha256 = digest(bytes);
  publish(path, bytes);
  publish(receipt, JSON.stringify({ identity, sha256 }) + "\n");
  return { path, failed: false, kind: media.kind, name, sha256 };
}
