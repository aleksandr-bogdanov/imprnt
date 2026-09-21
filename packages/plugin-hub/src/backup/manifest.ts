import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The list of what one copy holds, and the comparison a read-back is judged by.
 *
 * THE MANIFEST IS WRITTEN LAST. It names every file of the copy with its size
 * and its sha256, so one written before the copy finished would describe a copy
 * that may never have existed, and the read-back of it would vouch for files
 * that were never there. It also carries the moment the copy was assembled,
 * which makes every copy's manifest different from the one before it: a
 * destination still holding last hour's copy cannot read back this hour's
 * manifest, so an upload that silently did nothing is caught even when no file
 * changed in between.
 */
export const MANIFEST_FILE = "manifest.json";

export interface ManifestEntry {
  /** Relative to the copy's root, with `/` between the parts on every machine. */
  path: string;
  sha256: string;
  size: number;
}

export interface Manifest {
  at: string;
  machine: string;
  files: ManifestEntry[];
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * One entry per regular file under `root`, the manifest itself excepted, sorted
 * by path. A link is not followed and is not a file: it is carried as a link,
 * and following one could reach a tree the copy was never meant to hold.
 */
export function buildManifest(root: string): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      const kind = lstatSync(path);
      if (kind.isDirectory()) walk(path, rel);
      else if (kind.isFile() && rel !== MANIFEST_FILE) {
        const bytes = readFileSync(path);
        out.push({ path: rel, sha256: sha256(bytes), size: bytes.length });
      }
    }
  };
  walk(root, "");
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function renderManifest(manifest: Manifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** A manifest back from its text, or a throw naming what is wrong with it. */
export function readManifest(text: string): Manifest {
  const parsed = JSON.parse(text) as Partial<Manifest>;
  if (typeof parsed?.at !== "string" || typeof parsed.machine !== "string" || !Array.isArray(parsed.files)) {
    throw new Error("manifest-malformed: it needs at, machine and a list of files");
  }
  for (const one of parsed.files) {
    if (typeof one?.path !== "string" || typeof one.sha256 !== "string" || !Number.isSafeInteger(one.size)) {
      throw new Error("manifest-malformed: every file needs a path, a sha256 and a size");
    }
  }
  return parsed as Manifest;
}

/**
 * Whether what came back is exactly what was sent, byte for byte.
 *
 * The one comparison a copy is accepted by, so it compares the bytes and
 * nothing standing in for them: not a length, not a hash computed twice from
 * the local file, not "the command exited zero".
 */
export function sameBytes(sent: Uint8Array, received: Uint8Array): boolean {
  return sent.length === received.length && Buffer.compare(sent, received) === 0;
}
