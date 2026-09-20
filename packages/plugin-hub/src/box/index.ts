import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { listAgents, listCredentials, listPeople, listRepositories, listRunEntries, personOf } from "../registry/entries.ts";
import { readSetting } from "../registry/load.ts";
import { secretsDirOf } from "../store/secrets.ts";
import type { BoxContext, BoxedCommand } from "./types.ts";

export type { BoxContext, BoxedCommand } from "./types.ts";

/** No box tool on this platform, or the one it has will not run. */
export class BoxUnavailable extends Error {
  readonly tool: string;
  readonly reason: string;

  constructor(tool: string, reason: string) {
    super(`${tool}: ${reason}`);
    this.name = "BoxUnavailable";
    this.tool = tool;
    this.reason = reason;
  }
}

/**
 * The system paths a command needs before it can run at all, on macOS.
 *
 * Deliberately NOT `/var`, `/private` or `/tmp`: a tree lives under one of
 * those on one platform or the other, and a grant on an ancestor hands over
 * every vault on the box as surely as naming one does.
 *
 * `/private/var/db` whole, rather than the two directories under it:
 * MEASURED by bisecting the grants against the real loop, which does not start
 * without all of it. Nothing a person owns lives there.
 */
const MAC_SYSTEM = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/dev",
  "/private/etc",
  "/private/var/db",
];

/**
 * Where the tools a loop is made of live, on macOS: the household's own package
 * manager, the user-local install directory a loop puts itself in, and the
 * runtime this hub runs on. A boxed command that cannot read the binary it IS
 * never starts, and "the box broke the loop" is indistinguishable from "the box
 * worked" to every probe that matters.
 */
function macTools(): string[] {
  return [brewPrefix(), join(homedir(), ".local"), join(homedir(), ".bun")];
}

/**
 * Where Homebrew is on THIS Mac, asked rather than assumed.
 *
 * `/opt/homebrew` is Apple Silicon's prefix and `/usr/local` is Intel's, and a
 * box whose profile names the wrong one is a box that denies the loop the tools
 * it is made of, which on macOS is a child that dies at startup with "An
 * unknown error occurred" and nothing else (entry 5). So brew is asked for its
 * own prefix, and only a box with no brew on it falls back to the prefix its
 * architecture ships with. Asked once and remembered, because a profile is
 * rendered per agent per spawn and this is a process spawn.
 */
let brewPrefixSaid: string | null = null;
function brewPrefix(): string {
  if (brewPrefixSaid !== null) return brewPrefixSaid;
  try {
    const asked = Bun.spawnSync(["brew", "--prefix"], { stdout: "pipe", stderr: "pipe" });
    const said = (asked.stdout?.toString() ?? "").trim();
    if ((asked.exitCode ?? 1) === 0 && said.startsWith("/")) {
      brewPrefixSaid = said;
      return said;
    }
  } catch {
    // No brew on this box at all, which the fallback below is for.
  }
  brewPrefixSaid = process.arch === "arm64" ? "/opt/homebrew" : "/usr/local";
  return brewPrefixSaid;
}

/**
 * The loop's own login, which SPEC section 5 names as the one thing inside the
 * box that is not the person's. MEASURED by bisecting the grants: without the
 * keychain the real loop starts and says "Not logged in", and with it and
 * nothing else of the home directory it answers on the cheap model. The
 * preference and loop-state grants are not needed and are not here.
 */
const MAC_LOGIN = [join(homedir(), "Library", "Keychains")];

/**
 * The runtime sockets a boxed command must not reach on Linux: the user session
 * bus and systemd's private socket (both under /run/user) and the system bus
 * (/run/dbus). Either bus takes a start-a-unit call from this account, and that
 * unit runs outside the box. A fresh tmpfs over each directory empties it, and
 * the parent /run/user is covered rather than the per-uid directory inside it,
 * so the mask is the same on every box and needs no uid.
 *
 * Each is used only where it exists. A machine with no such directory has
 * nothing there to hide, and under the read-only host a boxed command cannot
 * create one either. Naming a missing directory would be worse than useless:
 * bwrap cannot make a mount point on a read-only root, so every boxed launch on
 * a machine without it would fail outright.
 */
export const RUNTIME_MASKS = ["/run/user", "/run/dbus"];

/**
 * Two more things on a Linux host that hand a boxed command the machine, each a
 * single file rather than a directory the loop can spare, so each is masked on
 * its own.
 *
 * The docker socket: a connect to it needs nothing but membership of the group
 * that owns it, and a container started through it can bind the host's root
 * directory and write to it as root, which is a way out of the box and up to
 * root in one step.
 *
 * The account's X authority cookie: holding it makes a boxed command an
 * authorised client of the desktop's X server, which can read the screen and
 * type into whatever is open there, including a terminal. Masking the cookie is
 * the half of this that a filesystem can close. The X server's own socket is an
 * abstract socket, which lives in the network namespace, and the loop shares the
 * host's network namespace because it needs the model API, so no mount hides it.
 *
 * A file mask is a bind over one directory entry: if whoever owns the file
 * replaces it, the mask is lifted for boxes already running. So this stops an
 * agent reaching these from inside a box, and a daemon that recreates its socket
 * while a box is running opens it again until the next launch.
 */
function hostControlMasks(): string[] {
  const named = process.env.XAUTHORITY;
  return [
    "/run/docker.sock",
    "/var/run/docker.sock",
    join(homedir(), ".Xauthority"),
    ...(named && isAbsolute(named) ? [named] : []),
  ];
}

/**
 * Every path in this household that holds a secret an agent must not
 * read: the directory the store roles' passwords are in, every door's token
 * file, and every declared credential file. The box shares the machine's
 * network and, on Linux, the machine's whole filesystem, so a password or a
 * token an agent could read is a store login or a bot it could post as, for
 * any agent steered by outside content it read.
 */
function secretPathsOf(registry: unknown): string[] {
  // Every door's token, including a door no agent is served by yet: it is a
  // bot all the same, and a token is masked whether or not it is in use.
  return [...new Set([
    secretsDirOf(registry) ?? "",
    ...listRunEntries(registry).map((one) => typeof one.token_file === "string" ? one.token_file : ""),
    ...listCredentials(registry).map((one) => one.file),
  ].filter((path) => path !== ""))];
}

/** Everything the box needs about one agent, read off the registry and nothing else. */
export function boxContextFor(registry: unknown, agentId: string): BoxContext {
  const agent = listAgents(registry).find((one) => one.id === agentId);
  if (!agent) throw new BoxUnavailable("registry", `${agentId} is not an agent of this registry`);
  const person = personOf(registry, agentId);
  return {
    stateRoot: join(String(readSetting(registry, "hub.state_dir") ?? ""), agent.person),
    otherStateRoots: listPeople(registry).filter(one => one.id !== agent.person)
      .map(one => join(String(readSetting(registry, "hub.state_dir") ?? ""), one.id)),
    agent: agentId,
    person: agent.person,
    tree: person?.tree ?? "",
    // Every OTHER declared person, and never the agent's own: a box that masked
    // its own tree is a box the agent cannot work in, and one that forgot
    // another person is the leak this exists to close.
    otherTrees: listPeople(registry)
      .filter((one) => one.id !== agent.person)
      .map((one) => one.tree)
      .filter((tree) => tree !== ""),
    // This person's declared repositories are working copies the agent edits, so
    // they stay writable under the read-only host. One under the person's tree is
    // already covered by the tree's own write bind, so this only adds any that
    // sit elsewhere.
    writePaths: listRepositories(registry)
      .filter((repo) => repo.person === agent.person && repo.path !== "")
      .map((repo) => repo.path),
    secretPaths: secretPathsOf(registry),
  };
}

/**
 * The secret paths this box masks, and how. A directory is covered whole, a
 * file on its own. A path that is not there has nothing to read yet, and one
 * that is a device (a fixture's `/dev/null` token) is not a secret. A path
 * inside a masked directory is covered by that directory.
 *
 * On Linux a file is masked by binding `/dev/null` over it, and that mount sits
 * on the file's directory entry: if the host later REPLACES the file by
 * renaming a new one over it, the kernel lifts the mask in every box already
 * running (measured on the hub box, bwrap 0.8). A file edited in place stays
 * masked. A token kept inside the secrets directory is covered by the
 * directory's mask and is safe from both.
 */
function secretMasks(ctx: BoxContext): { path: string; directory: boolean }[] {
  const found: { path: string; directory: boolean }[] = [];
  for (const path of ctx.secretPaths ?? []) {
    if (!existsSync(path)) continue;
    const kind = statSync(path);
    if (!kind.isDirectory() && !kind.isFile()) continue;
    found.push({ path, directory: kind.isDirectory() });
  }
  const directories = found.filter((one) => one.directory).map((one) => one.path);
  return found.filter((one) => !directories.some((dir) => one.path !== dir && one.path.startsWith(`${dir}/`)));
}

/**
 * The profile, per agent.
 *
 * THE SET IS BISECTED, not guessed: it was cut back against the real loop one
 * cheap call at a time, so every rule below either failed the
 * loop when it was taken out, or is a tool path a boxed command needs to exist
 * at all, or is one of the three the tenancy check pins by name. A rule added
 * here without that test is a grant nobody has shown the loop needs.
 */
function profileText(ctx: BoxContext): string {
  const lines = [
    "(version 1)",
    `; the box for ${ctx.agent}, whose boundary is the person ${ctx.person}`,
    "(deny default)",
    // Measured: without this, nothing starts at all.
    '(allow file-read* (literal "/"))',
    ...MAC_SYSTEM.map((path) => `(allow file-read* (subpath "${path}"))`),
    ...macTools().map((path) => `(allow file-read* (subpath "${path}"))`),
    ...(ctx.sessionDir ? [] : MAC_LOGIN).map((path) => `(allow file-read* (subpath "${path}"))`),
    // A scratch directory is not anybody's vault and every tool expects one.
    '(allow file-read* file-write* (subpath "/private/tmp"))',
    '(allow file-read* file-write* (subpath "/dev"))',
    // MEASURED: the loop does not start without this one, and it grants no
    // path a person's own files are under.
    "(allow file-read-metadata)",
  ];
  // State stays readable, but only the isolated session is writable.
  if (ctx.stateRoot) lines.push(`(allow file-read* (subpath ${JSON.stringify(ctx.stateRoot)}))`);
  for (const path of ctx.readPaths ?? []) lines.push(`(allow file-read* (subpath ${JSON.stringify(path)}))`);
  // The agent WORKS in its own tree, so that one is read AND write.
  if (ctx.tree !== "") lines.push(`(allow file-read* file-write* (subpath ${JSON.stringify(ctx.tree)}))`);
  // The declared repositories and the launched login's directory are the other
  // paths a turn writes to. The login directory is writable because the model
  // CLI rotates its token in place there, and this grant is after the read-only
  // grant for the same directory so the writable rule is the one that wins.
  for (const path of ctx.writePaths ?? []) if (path !== "") lines.push(`(allow file-read* file-write* (subpath ${JSON.stringify(path)}))`);
  lines.push(
    "(allow process-exec process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    // A boxed command may spawn its own children and it may not hand work to
    // launchd. mach-lookup has to stay open for the loop to start at all, and it
    // reaches the user launchd, which would run a submitted job OUTSIDE the box
    // and so outside the fence around this person's tree. Measured: this refuses
    // a submitted job while leaving reads of launchd's own state and ordinary
    // spawning alone.
    "(deny job-creation)",
    // The loop talks to a model over the network and to the tailnet. Measured:
    // without it the loop starts and every turn fails.
    "(allow network*)",
  );
  // Last, because the sandbox takes the last matching rule: every other
  // person's tree is denied by name, whatever a broader allow above said, and
  // the deny covers writing as well as reading.
  for (const path of [ctx.stateRoot, ...(ctx.purpose === "harvest" ? [ctx.tree] : [])]) {
    if (path) lines.push(`(deny file-write* (subpath ${JSON.stringify(path)}))`);
  }
  if (ctx.sessionDir) lines.push(`(allow file-read* file-write* (subpath ${JSON.stringify(ctx.sessionDir)}))`);
  for (const tree of new Set([...ctx.otherTrees, ...(ctx.otherStateRoots ?? [])])) {
    lines.push(`(deny file-read* file-write* (subpath ${JSON.stringify(tree)}))`);
  }
  // Last of all, so no allow above can hand one back: a token beside the model
  // login sits under the login directory the launch grants. The match is by path
  // at every access, so a file replaced by a rename stays denied here.
  for (const { path } of secretMasks(ctx)) {
    lines.push(`(deny file-read* file-write* (subpath ${JSON.stringify(path)}))`);
  }
  return `${lines.join("\n")}\n`;
}

function profilePath(ctx: BoxContext): string {
  const mark = new Bun.CryptoHasher("sha256")
    .update([ctx.agent, ctx.tree, ctx.stateRoot, ctx.sessionDir, ctx.purpose, ...(ctx.otherStateRoots ?? []), ...(ctx.readPaths ?? []), ...(ctx.writePaths ?? [])].join("|"))
    .digest("hex")
    .slice(0, 12);
  return join(tmpdir(), `imprnt-hub-box-${ctx.agent}-${mark}.sb`);
}

/**
 * The argv that runs this command inside the agent's box.
 *
 * Linux: the ORDER is what makes it work. The host is bound read-only with a
 * fresh /dev on top, then `--proc /proc` comes AFTER that bind, because the
 * reverse binds the host's `/proc` back over the namespace's and the pid
 * namespace then hides nothing, which looks exactly like a working box from the
 * outside. Only the tree, the session, the declared repositories and the login
 * directory are then bound writable. The network namespace stays shared: the
 * loop needs the model API and the tailnet.
 *
 * macOS: a generated `(deny default)` profile. MEASURED: macOS has no
 * pid namespace and no sandbox rule produces one, so the process list is NOT
 * fenced there. The tree, its files and its origin are fenced on both.
 */
export function boxCommand(argv: string[], ctx: BoxContext, platform?: string): BoxedCommand {
  // A path is resolved to what it really is, so two spellings of one file are
  // one mask. A path the system will not resolve is used as it was written
  // rather than throwing: some sockets refuse the call, and a box that cannot be
  // rendered is a loop that cannot start.
  const canonical = (path: string) => {
    if (!path || !existsSync(path)) return path;
    try { return realpathSync(path); } catch { return path; }
  };
  ctx = { ...ctx, tree: canonical(ctx.tree),
    stateRoot: ctx.stateRoot && canonical(ctx.stateRoot), sessionDir: ctx.sessionDir && canonical(ctx.sessionDir),
    otherTrees: ctx.otherTrees.map(canonical), otherStateRoots: ctx.otherStateRoots?.map(canonical),
    readPaths: ctx.readPaths?.map(canonical), writePaths: ctx.writePaths?.map(canonical),
    secretPaths: ctx.secretPaths?.map(canonical) };
  // The caller may name the box flavour, for a check that renders the other
  // machine's command. Unnamed, it is the one this process is running on.
  const flavour = String(platform ?? process.platform);
  if (flavour === "linux") {
    return {
      tool: "bwrap",
      argv: [
        "/usr/bin/bwrap",
        "--unshare-pid",
        "--die-with-parent",
        // The whole host is bound READ-ONLY, with a fresh /dev on top. A writable
        // host let a boxed command rewrite the registry, drop a unit under the
        // user systemd directory or edit a shell startup file, each of which then
        // runs outside the box. Only the paths bound writable below can change.
        "--ro-bind",
        "/",
        "/",
        "--dev",
        "/dev",
        // /proc AFTER the host bind, or the host's /proc is bound back over the
        // pid namespace's and the namespace hides nothing.
        "--proc",
        "/proc",
        // The agent WORKS in its own tree, so an ordinary turn binds it writable.
        // A harvest only reads it.
        ...(ctx.tree && existsSync(ctx.tree)
          ? [ctx.purpose === "harvest" ? "--ro-bind" : "--bind", ctx.tree, ctx.tree]
          : []),
        // State stays readable, never writable. This comes after the tree bind so
        // that when a person's tree and state root are the same directory the
        // read-only rule wins, the way it does on the other flavour.
        ...[ctx.stateRoot]
          .filter((path): path is string => Boolean(path) && existsSync(path!))
          .flatMap(path => ["--ro-bind", path, path]),
        // The isolated session, under the state root, is the one part of it that
        // is writable, so it binds after the read-only state root.
        ...(ctx.sessionDir ? ["--bind", ctx.sessionDir, ctx.sessionDir] : []),
        // The declared repositories and the launched login's directory, the only
        // other paths a turn writes to (the CLI rotates its token in place).
        ...[...new Set(ctx.writePaths ?? [])]
          .filter((path) => path !== "" && existsSync(path))
          .flatMap(path => ["--bind", path, path]),
        // A tmpfs empties another person's tree and state root. Under the
        // read-only host bwrap cannot create a missing mount point, so a path
        // that is not there is skipped: it holds nothing to hide, and the host
        // being read-only means a boxed command cannot create it either.
        ...[...new Set([...ctx.otherTrees, ...(ctx.otherStateRoots ?? [])])]
          .filter(tree => tree !== "" && existsSync(tree))
          .flatMap(tree => ["--tmpfs", tree]),
        // A fresh empty tmpfs over the user runtime directory and the system
        // bus directory. The user session bus and systemd's own private socket
        // both live under /run/user, and a process that reaches either can ask
        // this account's systemd to start a unit that then runs OUTSIDE the box.
        // The loop's environment carries no runtime directory, so nothing it
        // needs is there. Skipped where it is not there, for the same reason the
        // other-tree masks are: nothing to hide, and no way to create it.
        ...RUNTIME_MASKS.filter(existsSync).flatMap(path => ["--tmpfs", path]),
        // The docker socket and the X authority cookie, each covered with
        // /dev/null. A path that is not on this box is skipped, and the two
        // spellings of the socket are one path once the symlink is resolved.
        ...[...new Set(hostControlMasks().filter(existsSync).map(canonical))]
          .flatMap(path => ["--ro-bind", "/dev/null", path]),
        // Masks come after everything above, so nothing bound later uncovers one.
        ...secretMasks(ctx).flatMap(({ path, directory }) =>
          directory ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path]),
        "--",
        ...argv,
      ],
    };
  }
  if (flavour === "darwin" || flavour === "macos") {
    const profile = { path: profilePath(ctx), text: profileText(ctx) };
    return {
      tool: "sandbox-exec",
      argv: [
        "/usr/bin/sandbox-exec",
        "-f",
        profile.path,
        // Enter the selected session directory when launch preparation supplied it.
        "/bin/sh",
        "-c",
        ctx.sessionDir ? 'cd "$1" || exit; shift; exec "$@"' : 'cd "$1" 2>/dev/null || cd /; shift; exec "$@"',
        "sh",
        ctx.sessionDir ?? (ctx.tree === "" ? "/" : ctx.tree),
        ...argv,
      ],
      profile,
    };
  }
  throw new BoxUnavailable(
    flavour,
    "this hub boxes with bwrap and with sandbox-exec, and with nothing else",
  );
}
