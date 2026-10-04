import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";

/**
 * A Linux machine that is a WSL guest on a Windows PC, as the hub sees it.
 *
 * The hub runs on such a machine exactly as it runs on any Linux: systemd user
 * units, bwrap boxes, the same registry with `os = "linux"`. What WSL adds is
 * three routes OUT of Linux that no other Linux host has, and each one is a way
 * around the box:
 *
 * - interop: a Linux process can start a Windows program (`cmd.exe`,
 *   `powershell.exe`), which runs as the Windows account, outside every
 *   namespace bwrap made. The kernel hands a Windows executable to WSL's
 *   `/init` through a binfmt_misc registration, and `/init` asks Windows to run
 *   it over a socket under `/run/WSL`.
 * - the Windows drives: `C:` mounted at `/mnt/c` is the Windows account's whole
 *   profile, browser data included, readable through the box's read-only host.
 * - the shared folders WSL itself keeps: `/mnt/wsl`, shared with every other
 *   distro of the account, and WSLg's display sockets.
 *
 * The supported setup closes the first two in `/etc/wsl.conf` (interop off,
 * automount off), `check` says so when they are open, and the box masks all of
 * them regardless, so a distro set up by hand is fenced the same way.
 *
 * MEASURED NOWHERE YET: no WSL host has run this code. The paths and the
 * binfmt names are WSL's documented and commonly observed ones; the Windows
 * machine this was written for was offline.
 */
export interface WslView {
  /** `1` has no namespaces bwrap can use and no systemd, so the hub cannot run there. */
  version: 1 | 2;
  /** Every interop registration that is switched on, by its binfmt_misc name. */
  interop: string[];
  /** Mount points of a Windows file system, WSL's own read-only driver share left out. */
  windowsMounts: string[];
}

/** What the reader looks at, supplied by a check and real by default. */
export interface WslSources {
  osrelease: string | null;
  /** binfmt_misc entry name to its file's text. */
  binfmt: Record<string, string>;
  mounts: string;
  /** Whether `/run/WSL`, the directory WSL's own init keeps, is there. */
  runtime?: boolean;
}

/** WSL's own share of the Windows driver store: read-only system files, never a person's. */
const DRIVER_SHARE = "/usr/lib/wsl";

/**
 * The directories WSL keeps for itself that a boxed command must not reach:
 * the interop sockets, the folder every distro of the account shares, and
 * WSLg's display (its X socket directory too, which is a link into it).
 */
export const WSL_RUNTIME_MASKS = ["/run/WSL", "/mnt/wsl", "/mnt/wslg", "/tmp/.X11-unix"];

function readOr(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

function realSources(): WslSources {
  const binfmt: Record<string, string> = {};
  try {
    for (const name of readdirSync("/proc/sys/fs/binfmt_misc")) {
      if (!/^WSLInterop/i.test(name)) continue;
      binfmt[name] = readOr(`/proc/sys/fs/binfmt_misc/${name}`) ?? "";
    }
  } catch {
    // No binfmt_misc mounted: nothing is registered that this process can see.
  }
  return {
    osrelease: readOr("/proc/sys/kernel/osrelease"),
    binfmt,
    mounts: readOr("/proc/self/mounts") ?? "",
    runtime: existsSync("/run/WSL"),
  };
}

/** `/proc/self/mounts` writes a space in a path as `\040`, and so on. */
function unescapeMount(path: string): string {
  return path.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

/**
 * Whether one mount line is a Windows file system. WSL mounts a drive as
 * `drvfs` on WSL 1 and as `9p` (or `virtiofs`) naming `aname=drvfs` on WSL 2,
 * with the drive letter as the source.
 */
function isWindowsMount(source: string, type: string, options: string): boolean {
  if (type === "drvfs") return true;
  if (type !== "9p" && type !== "virtiofs") return false;
  return /(^|[,;])aname=drvfs([,;]|$)/.test(options) || /^[A-Za-z]:/.test(source) || /^drvfs/i.test(source);
}

/**
 * The view from supplied sources: null when this Linux is not a WSL guest at all.
 *
 * NOT BY THE KERNEL'S NAME ALONE. A custom kernel named in `.wslconfig` calls
 * itself whatever it was built as, and a guest the reader took for plain Linux
 * gets no masks and no findings, silently. So WSL's own traces count as well:
 * an interop registration (switched on or not), `/run/WSL`, and the mounts WSL
 * makes for itself (`/mnt/wsl`, its driver share under `/usr/lib/wsl`). Only
 * WSL 1 runs no kernel of its own, and it always names itself `Microsoft`, so a
 * guest found by its traces alone is WSL 2.
 */
export function wslViewFrom(sources: WslSources): WslView | null {
  const release = sources.osrelease ?? "";
  const named = /microsoft|wsl/i.test(release);
  const points = sources.mounts.split("\n").map(line => unescapeMount(line.split(" ")[1] ?? ""));
  const traced = Object.keys(sources.binfmt).length > 0 || sources.runtime === true ||
    points.some(point => point === "/mnt/wsl" || point === DRIVER_SHARE || point.startsWith(`${DRIVER_SHARE}/`));
  if (!named && !traced) return null;
  // WSL 2's kernel names itself `...-microsoft-standard-WSL2`; WSL 1 reports
  // the Windows build behind a `-Microsoft` suffix and nothing else.
  const version = !named || /wsl2|standard/i.test(release) ? 2 : 1;
  const interop = Object.entries(sources.binfmt)
    .filter(([, text]) => text.split("\n")[0]?.trim() === "enabled")
    .map(([name]) => name)
    .sort();
  const windowsMounts: string[] = [];
  for (const line of sources.mounts.split("\n")) {
    const [source, point, type, options] = line.split(" ");
    if (!point || !type) continue;
    const path = unescapeMount(point);
    if (path === DRIVER_SHARE || path.startsWith(`${DRIVER_SHARE}/`)) continue;
    if (isWindowsMount(source ?? "", type, options ?? "") && !windowsMounts.includes(path)) windowsMounts.push(path);
  }
  return { version, interop, windowsMounts };
}

/** This machine's view, or null off WSL (and always off Linux). */
export function readWslView(): WslView | null {
  if (process.platform !== "linux") return null;
  return wslViewFrom(realSources());
}

/**
 * What the box empties on a WSL host: WSL's own runtime directories and every
 * Windows mount, each only where it exists, ALWAYS, granted paths or not.
 *
 * A path the launch grants under one of these (a person's tree kept on a
 * Windows drive, say) is bound back on its own after the masks, and nothing
 * else of that drive is (`wslGrantedUnder`). A grant that IS a whole drive, or
 * holds one, gets the empty mask: the box never hands an agent a whole Windows
 * drive, and `check` still reports the drive as mounted; the supported setup
 * mounts none.
 */
export function wslMaskPaths(
  view: WslView | null,
  exists: (path: string) => boolean = existsSync,
  resolve: (path: string) => string = realOr,
): string[] {
  if (view === null) return [];
  // As the file system names it: WSLg's X socket directory is a link into its
  // own folder on some builds, and a tmpfs mounted through a link that an
  // earlier mask already emptied has nowhere to go. One that is covered by
  // another mask in the list is covered already.
  const masks = [...new Set([...WSL_RUNTIME_MASKS, ...view.windowsMounts]
    .filter(path => path !== "/" && exists(path))
    .map(resolve))];
  return masks.filter(mask => !masks.some(other => other !== mask && covers(other, mask)));
}

/** Whether a path is a mask or anything under it. */
function covers(mask: string, path: string): boolean {
  return path === mask || path.startsWith(`${mask.replace(/\/+$/, "")}/`);
}

/** Whether a path lies strictly beneath one of the masks: a part of it, never the whole. */
export function wslGrantedUnder(masks: string[], path: string): boolean {
  const named = path.replace(/\/+$/, "");
  return named !== "" && masks.some(mask => named !== mask.replace(/\/+$/, "") && covers(mask, named));
}

/**
 * The name service's own file where a mask would empty it. WSL writes
 * `/etc/resolv.conf` as a link to `/mnt/wsl/resolv.conf` by default, and a box
 * that masks `/mnt/wsl` would then resolve no name at all: no model API, no
 * turn. The one file is bound back read-only, and nothing else of the folder.
 */
export function wslKeptFiles(
  masks: string[],
  exists: (path: string) => boolean = existsSync,
  resolve: (path: string) => string = realOr,
): string[] {
  const kept: string[] = [];
  for (const file of ["/etc/resolv.conf"]) {
    if (!exists(file)) continue;
    const real = resolve(file);
    if (wslGrantedUnder(masks, real) && !kept.includes(real)) kept.push(real);
  }
  return kept;
}

function realOr(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}
