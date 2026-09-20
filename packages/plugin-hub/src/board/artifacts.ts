import { realpathSync, statSync } from "node:fs";
import { extname, join, sep } from "node:path";
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

/** The file to serve, or null, which is the one 404 for every reason there is. */
export function serveArtifact(args: {
  registry: unknown;
  person: string;
  path: string;
}): { path: string; type: string } | null {
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

  let real: string;
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
    real = realpathSync(join(root, ...asked));
  } catch {
    // A directory that is not on this machine, and a name that is not there.
    return null;
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return { path: real, type: contentTypeFor(real) };
}
