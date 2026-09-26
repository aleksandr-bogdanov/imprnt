import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

/**
 * Where a declared repository's remote really is, read off the checkout's own
 * git configuration as a FILE and never through git.
 *
 * Two readers need the answer and neither may start a program to get it. The
 * box builder asks so it can hide another person's git copy of their vault:
 * the household's ordinary layout keeps the bare repositories outside the
 * people's trees, and a box that hid the trees alone left the other person's
 * whole history one read away. The off-box copy asks so it can leave out a
 * repository that already lives on another host, which was most of a daily
 * copy for nothing.
 *
 * `.git` may be a file pointing at the real directory, which is what a
 * worktree carries, and that pointer is followed once. A repository with no
 * configuration answers null, and so does one whose remote is not named.
 */
export function remoteUrlOf(repoPath: string, remote: string): string | null {
  const config = gitConfigOf(repoPath);
  if (config === null) return null;
  let text: string;
  try { text = readFileSync(config, "utf8"); } catch { return null; }
  let inside = false;
  let url: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const section = /^\[remote\s+"((?:[^"\\]|\\.)*)"\]$/.exec(line);
    if (section) { inside = section[1].replace(/\\(.)/g, "$1") === remote; continue; }
    if (line.startsWith("[")) { inside = false; continue; }
    if (!inside) continue;
    const pair = /^url\s*=\s*(.*)$/i.exec(line);
    // The last value wins, which is git's own rule for a single-valued key.
    if (pair) url = unquote(pair[1]);
  }
  return url;
}

/**
 * The directory a remote url names on THIS box, or null when the remote is
 * somewhere else. A local remote is an absolute path, a path relative to the
 * checkout, or a `file://` url. Anything with another scheme, or the
 * `host:path` shape ssh reads, lives off the box.
 */
export function localRemotePath(repoPath: string, remote: string): string | null {
  const url = remoteUrlOf(repoPath, remote);
  if (url === null) return null;
  if (url.startsWith("file://")) return decodeURIComponent(url.slice("file://".length).replace(/^localhost/, ""));
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return null;
  if (isAbsolute(url)) return url;
  // `host:path` is ssh, and a relative path never carries a colon before a slash.
  if (/^[^/]+:/.test(url)) return null;
  return resolve(repoPath, url);
}

/** The repository's configuration file, or null when there is none to read. */
function gitConfigOf(repoPath: string): string | null {
  const dotGit = join(repoPath, ".git");
  let gitDir = dotGit;
  try {
    if (statSync(dotGit).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!pointer) return null;
      gitDir = isAbsolute(pointer[1].trim()) ? pointer[1].trim() : resolve(dirname(dotGit), pointer[1].trim());
    }
  } catch {
    // A bare repository keeps its configuration at its own root.
    gitDir = repoPath;
  }
  // A linked worktree's directory holds no configuration of its own: it names
  // the main repository's, and the remotes live there.
  const commondir = join(gitDir, "commondir");
  if (existsSync(commondir)) {
    try {
      const common = readFileSync(commondir, "utf8").trim();
      gitDir = isAbsolute(common) ? common : resolve(gitDir, common);
    } catch { /* an unreadable pointer is no configuration */ }
  }
  const config = join(gitDir, "config");
  return existsSync(config) ? config : null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return trimmed;
}
