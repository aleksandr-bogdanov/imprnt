import { tmpdir } from "node:os";
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
 */
const MAC_SYSTEM = [
  "/usr",
  "/bin",
  "/sbin",
  "/System",
  "/Library",
  "/dev",
  "/private/etc",
  "/private/var/db/dyld",
  "/private/var/db/timezone",
];

function flavourOf(ctx: BoxContext, platform?: string): string {
  return String(platform ?? ctx.platform ?? process.platform);
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

function profileText(ctx: BoxContext): string {
  const lines = [
    "(version 1)",
    `; the box for ${ctx.agent}, whose boundary is the person ${ctx.person}`,
    "(deny default)",
    // Measured: without this, nothing starts at all.
    '(allow file-read* (literal "/"))',
    ...MAC_SYSTEM.map((path) => `(allow file-read* (subpath "${path}"))`),
  ];
  if (ctx.tree !== "") lines.push(`(allow file-read* (subpath "${ctx.tree}"))`);
  if (ctx.sharedZone !== "") lines.push(`(allow file-read* (subpath "${ctx.sharedZone}"))`);
  lines.push("(allow process-exec process-fork)", "(allow sysctl-read)", "(allow mach-lookup)");
  // Last, because the sandbox takes the last matching rule: every other
  // person's tree is denied by name, whatever a broader allow above said.
  for (const tree of ctx.otherTrees) lines.push(`(deny file-read* (subpath "${tree}"))`);
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
      argv: ["/usr/bin/sandbox-exec", "-f", profile.path, ...argv],
      profile,
    };
  }
  throw new BoxUnavailable(
    flavour,
    "this hub boxes with bwrap and with sandbox-exec, and with nothing else",
  );
}
