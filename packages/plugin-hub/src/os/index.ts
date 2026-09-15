import { launchd } from "./launchd.ts";
import { systemd } from "./systemd.ts";
import type { OsSeam } from "./types.ts";

export * from "./types.ts";

/** No manager for this platform, or the one it has does not answer. */
export class OsUnavailable extends Error {
  readonly platform: string;
  readonly reason: string;

  constructor(platform: string, reason: string) {
    super(`${platform}: ${reason}`);
    this.name = "OsUnavailable";
    this.platform = platform;
    this.reason = reason;
  }
}

/**
 * The seam for a named platform. Both are built from the same registry on
 * whichever box asks, which is what lets the rendering be checked on one machine
 * for the other.
 *
 * 03b item 7: `bin` is the manager binary, defaulting to the bare name PATH
 * resolves. It is the whole fence around "check reaches no manager but the seam
 * it was handed", because a caller that spawned the real binary by absolute
 * path would never meet a shim fronted on PATH.
 */
export function osFor(
  platform: string,
  options: { unitDir?: string; bin?: string } = {},
): OsSeam {
  if (platform === "darwin" || platform === "macos") return launchd(options);
  if (platform === "linux") return systemd(options);
  throw new OsUnavailable(platform, "this hub has launchd and systemd, and nothing else");
}

export function thisOs(options: { unitDir?: string; bin?: string } = {}): OsSeam {
  return osFor(process.platform, options);
}
