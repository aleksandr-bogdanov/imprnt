import { constants, lstatSync, realpathSync, statSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { basename, dirname, extname, join, sep } from "node:path";
import { artifactsFor } from "../registry/entries.ts";

/**
 * The static route: what an agent built for a person, served to a reader on the
 * bind address.
 *
 * WHY THE ROUTE EXISTS AT ALL: a link posted in a channel outlives the turn
 * that built it. An agent writes into its own person's tree, which its box
 * already lets it write, so there is no publish verb, nothing a model calls and
 * nothing the hub has to hold.
 *
 * ONE PERSON BY DEFAULT, OPT IN PER PERSON. A person whose entry does not carry
 * `artifacts = true` is not served, which is the behaviour the household has
 * today. Separation between people here is the opt-in and the URL, and it is
 * not a defence against a household member: everyone who can reach the bind
 * address can read what is opted in.
 *
 * THE RULE IS THE REAL PATH, and it is one rule rather than three: the real
 * path of the requested file must sit under the real path of the person's own
 * artifacts directory, which refuses a `..`, a symlink pointing out and a path
 * that is not a file together. No dotfile in any segment, and no listing
 * anywhere, because a listing is enumeration.
 *
 * THE AGENT WRITES THIS TREE, so the tree is not trusted to hold still. Two
 * things follow. The artifacts directory itself must be a real directory and
 * never a link: resolving a linked one would move the allowed root to wherever
 * the link points, and an agent could point it at the other person's chat log
 * or a secret and then fetch the result itself, since its box reaches this
 * address. And the file is OPENED FIRST and only then checked, by what was
 * opened: a path checked and opened later can have a directory swapped for a
 * link in between, which the check never saw.
 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
};

/** The type the name implies, and the one answer for everything else. */
export function contentTypeFor(path: string): string {
  return TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** An open artifact, which the caller streams and closes. */
export interface OpenArtifact {
  handle: FileHandle;
  size: number;
  type: string;
}

/**
 * The file to serve, already open, or null, which is the one 404 for every
 * reason there is.
 *
 * `beforeOpen` runs between the decision about which path to open and the
 * open itself. Production passes nothing. A check lands a directory swap there,
 * which is the one moment a race against the tree could win, so the race is
 * asserted exactly rather than by luck.
 */
export async function serveArtifact(args: {
  registry: unknown;
  person: string;
  path: string;
  beforeOpen?: () => void;
}): Promise<OpenArtifact | null> {
  const root = artifactsFor(args.registry, args.person);
  if (root === null) return null;

  const parts = args.path.split("/").filter((one) => one !== "");
  if (parts.length === 0) return null;
  const asked: string[] = [];
  for (const part of parts) {
    let one: string;
    try {
      one = decodeURIComponent(part);
    } catch {
      return null;
    }
    // A leading dot covers a dotfile, `.` and `..` at once, whether it was
    // written plainly or encoded.
    if (one === "" || one.startsWith(".") || one.includes("/") || one.includes("\\")) return null;
    asked.push(one);
  }

  // The root is the person's tree resolved, plus `artifacts` NOT resolved. The
  // tree is the household's own setting and may sit behind a link of its own
  // (on macOS every temporary directory does), while the artifacts directory
  // is the agent's to write, so it has to be a real directory where it stands.
  let base: string;
  try {
    base = join(realpathSync(dirname(root)), basename(root));
    if (!lstatSync(base).isDirectory()) return null;
  } catch {
    // A directory that is not on this machine.
    return null;
  }

  const wanted = join(base, ...asked);
  args.beforeOpen?.();
  let handle: FileHandle;
  try {
    // Read only, and non-blocking, so a pipe planted where a file should be
    // cannot hold the board on its open. It changes nothing for a regular file.
    handle = await open(wanted, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch {
    // A name that is not there.
    return null;
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("not a file");
    // What was opened must be what the path names NOW, and what it names must
    // be inside. A swap before the open leads outside and fails the prefix, a
    // swap back after it names a different file and fails the identity.
    const real = realpathSync(wanted);
    if (real !== base && !real.startsWith(base + sep)) throw new Error("outside");
    const named = statSync(real);
    if (named.dev !== opened.dev || named.ino !== opened.ino) throw new Error("moved");
    return { handle, size: opened.size, type: contentTypeFor(real) };
  } catch {
    await handle.close();
    return null;
  }
}
