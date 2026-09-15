import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { listAgents, listPeople, personOf } from "../registry/entries.ts";
import { readSetting } from "../registry/load.ts";
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
 * `/private/var/db` rather than the two directories under it phase 3 named:
 * MEASURED, 03b item 1's bisect, the loop does not start without the whole of
 * it. Nothing a person owns lives there.
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
 * box that is not the person's. MEASURED by 03b item 1's bisect: without the
 * keychain the real loop starts and says "Not logged in", and with it and
 * nothing else of the home directory it answers on the cheap model. The
 * preference and loop-state grants the evening's measurement carried turned out
 * not to be needed and are not here.
 */
const MAC_LOGIN = [join(homedir(), "Library", "Keychains")];

function flavourOf(ctx: BoxContext, platform?: string): string {
  return String(platform ?? process.platform);
}

/** Everything the box needs about one agent, read off the registry and nothing else. */
export function boxContextFor(registry: unknown, agentId: string): BoxContext {
  const agent = listAgents(registry).find((one) => one.id === agentId);
  if (!agent) throw new BoxUnavailable("registry", `${agentId} is not an agent of this registry`);
  const person = personOf(registry, agentId);
  const zone = readSetting(registry, "hub.shared_zone");
  return {
    agent: agentId,
    person: agent.person,
    tree: person?.tree ?? "",
    sharedZone: zone === undefined || zone === null ? "" : String(zone),
    // Every OTHER declared person, and never the agent's own: a box that masked
    // its own tree is a box the agent cannot work in, and one that forgot
    // another person is the leak this exists to close.
    otherTrees: listPeople(registry)
      .filter((one) => one.id !== agent.person)
      .map((one) => one.tree)
      .filter((tree) => tree !== ""),
  };
}

/**
 * The profile, per agent.
 *
 * 03b item 1 widened it from phase 3's read-only skeleton, which nothing
 * loop-shaped could start under, to the set the REAL loop needs, and then
 * bisected that set against the real loop one cheap call at a time. What the
 * bisect removed is recorded in BUILD-NOTES: every rule below either failed the
 * loop when it was taken out, or is a tool path a boxed command needs to exist
 * at all, or is one of the three the tenancy check pins by name.
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
    ...MAC_LOGIN.map((path) => `(allow file-read* (subpath "${path}"))`),
    // A scratch directory is not anybody's vault and every tool expects one.
    '(allow file-read* file-write* (subpath "/private/tmp"))',
    '(allow file-read* file-write* (subpath "/dev"))',
    // MEASURED: the loop does not start without this one, and it grants no
    // path a person's own files are under.
    "(allow file-read-metadata)",
  ];
  // The agent WORKS in its own tree, so that one is read AND write.
  if (ctx.tree !== "") lines.push(`(allow file-read* file-write* (subpath "${ctx.tree}"))`);
  if (ctx.sharedZone !== "") lines.push(`(allow file-read* (subpath "${ctx.sharedZone}"))`);
  lines.push(
    "(allow process-exec process-fork)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    // The loop talks to a model over the network and to the tailnet. Measured:
    // without it the loop starts and every turn fails.
    "(allow network*)",
  );
  // Last, because the sandbox takes the last matching rule: every other
  // person's tree is denied by name, whatever a broader allow above said, and
  // the deny covers writing as well as reading.
  for (const tree of ctx.otherTrees) {
    lines.push(`(deny file-read* file-write* (subpath "${tree}"))`);
  }
  return `${lines.join("\n")}\n`;
}

function profilePath(ctx: BoxContext): string {
  const mark = new Bun.CryptoHasher("sha256")
    .update([ctx.agent, ctx.tree, ctx.sharedZone].join("|"))
    .digest("hex")
    .slice(0, 12);
  return join(tmpdir(), `imprnt-hub-box-${ctx.agent}-${mark}.sb`);
}

/**
 * The argv that runs this command inside the agent's box.
 *
 * Linux: the ORDER is what makes it work. `--proc /proc` comes AFTER
 * `--dev-bind / /`, because the reverse binds the host's `/proc` back over the
 * namespace's and the pid namespace then hides nothing, which looks exactly
 * like a working box from the outside. The network namespace stays shared: the
 * loop needs the model API and the tailnet.
 *
 * macOS: a generated `(deny default)` profile. D-106, measured: macOS has no
 * pid namespace and no sandbox rule produces one, so the process list is NOT
 * fenced there. The tree, its files and its origin are fenced on both.
 */
export function boxCommand(argv: string[], ctx: BoxContext, platform?: string): BoxedCommand {
  const flavour = flavourOf(ctx, platform);
  if (flavour === "linux") {
    return {
      tool: "bwrap",
      argv: [
        "/usr/bin/bwrap",
        "--unshare-pid",
        "--die-with-parent",
        "--dev-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        ...ctx.otherTrees.flatMap((tree) => ["--tmpfs", tree]),
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
        // THE BOX PUTS THE COMMAND WHERE IT CAN SEE. MEASURED, 03b item 1: a
        // process whose working directory the profile denies dies at startup
        // with "An unknown error occurred" the moment it reads anything
        // relative to it, and a caller that spawned it from its own directory
        // has no way to know that is what happened. `sandbox-exec` execs in
        // place and cannot change directory, so the change is the first thing
        // the boxed argv does, and `exec` means the pid the caller holds is
        // still the command's. bwrap has this for free: `--dev-bind / /` keeps
        // every directory readable, including the one it inherited.
        "/bin/sh",
        "-c",
        'cd "$1" 2>/dev/null || cd /; shift; exec "$@"',
        "sh",
        ctx.tree === "" ? "/" : ctx.tree,
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
