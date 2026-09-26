import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { StoreLike } from "./connect.ts";

/**
 * An attachment's bytes, kept in the store beside the row that carries it, so
 * a runner on a machine other than the door's can hand the loop the file the
 * person sent.
 *
 * The door saves the file under its own state directory and names that path
 * in the row's body. A runner elsewhere writes the same bytes into its own
 * person inbox, under its own state directory, at the same relative path, and
 * rewrites the path in what it feeds. The hub machine's runner keeps reading
 * the door's file directly.
 */
export interface StoredMedia {
  index: number;
  sha256: string;
  kind: string;
  name: string;
  bytes: Uint8Array;
}

/** What the door's own save recorded on the row's source, per attachment. */
export interface SavedMediaRef {
  path: string;
  failed: boolean;
  kind: string;
  name: string;
  sha256: string;
}

function digest(bytes: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * The door writes the bytes in the SAME transaction as the receipt, so a row
 * never exists whose attachment a spoke could not fetch. A save that failed
 * left no bytes and has no row here: the body already says it failed.
 */
export async function storeMedia(store: StoreLike, args: { inboundId: string; saved: SavedMediaRef[] }): Promise<void> {
  for (const [index, one] of args.saved.entries()) {
    if (one.failed) continue;
    const bytes = readFileSync(one.path);
    await store.sql`insert into media (inbound_id, index, sha256, kind, name, bytes)
                    values (${args.inboundId}, ${index}, ${one.sha256}, ${one.kind}, ${one.name}, ${bytes})
                    on conflict (inbound_id, index) do nothing`;
  }
}

export async function readMedia(store: StoreLike, inboundId: string): Promise<StoredMedia[]> {
  const rows = (await store.sql`select index, sha256, kind, name, bytes from media where inbound_id = ${inboundId} order by index`) as unknown as
    { index: number; sha256: string; kind: string; name: string; bytes: Uint8Array | Buffer }[];
  return rows.map((row) => ({ ...row, index: Number(row.index), bytes: new Uint8Array(row.bytes) }));
}

/**
 * Where the door's file for this attachment lives under THIS machine's state
 * directory: the same layout the door uses, `<person>/inbox/<sha256 of the
 * row id>/<index>.<ext>`, with the extension the door chose.
 */
export function localMediaPath(stateDir: string, person: string, inboundId: string, index: number, doorPath: string): string {
  const ext = extname(basename(doorPath)).slice(1) || "bin";
  return join(resolve(stateDir), person, "inbox", digest(inboundId), `${index}.${ext}`);
}

/**
 * The door's paths mapped to this machine's, for every attachment the door
 * saved. A failed save named a descriptor, not bytes, and stays as written.
 */
export function mediaPathMap(stateDir: string, person: string, inboundId: string, media: unknown[]): Map<string, string> {
  const out = new Map<string, string>();
  media.forEach((one, index) => {
    const ref = one as Partial<SavedMediaRef>;
    if (typeof ref?.path !== "string" || ref.failed) return;
    out.set(ref.path, localMediaPath(stateDir, person, inboundId, index, ref.path));
  });
  return out;
}

export function rewriteMediaPaths(text: string, map: Map<string, string>): string {
  let out = text;
  for (const [from, to] of map) out = out.split(from).join(to);
  return out;
}

function publish(path: string, bytes: Uint8Array): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temporary, path); } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}

/**
 * Every attachment of this row, written into this machine's inbox from the
 * store, each verified against the hash the door recorded, and the door's
 * paths mapped to the local ones. A file already there with the right hash is
 * left alone. Bytes that are missing from the store or do not match are
 * refused rather than fed: a row whose attachment cannot be produced is a row
 * the runner retries, never one answered about a file the loop never saw.
 */
export async function materializeMedia(store: StoreLike, args: { stateDir: string; person: string; inboundId: string; media: unknown[] }): Promise<Map<string, string>> {
  const map = mediaPathMap(args.stateDir, args.person, args.inboundId, args.media);
  if (map.size === 0) return map;
  const stored = await readMedia(store, args.inboundId);
  args.media.forEach((one, index) => {
    const ref = one as Partial<SavedMediaRef>;
    if (typeof ref?.path !== "string" || ref.failed) return;
    const local = map.get(ref.path)!;
    if (existsSync(local) && digest(readFileSync(local)) === ref.sha256) return;
    const bytes = stored.find((row) => row.index === index);
    if (!bytes) throw new Error(`media-missing: ${args.inboundId}[${index}] has no bytes in the store`);
    if (digest(bytes.bytes) !== ref.sha256 || bytes.sha256 !== ref.sha256) {
      throw new Error(`media-mismatch: ${args.inboundId}[${index}] in the store is not the bytes the door saved`);
    }
    publish(local, bytes.bytes);
  });
  return map;
}
