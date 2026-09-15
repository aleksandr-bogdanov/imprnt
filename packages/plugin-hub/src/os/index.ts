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
 */
export function osFor(platform: string, options: { unitDir?: string } = {}): OsSeam {
  if (platform === "darwin" || platform === "macos") return launchd(options);
  if (platform === "linux") return systemd(options);
  throw new OsUnavailable(platform, "this hub has launchd and systemd, and nothing else");
}

/** The seam for the platform this process is running on. */
export function thisOs(options: { unitDir?: string } = {}): OsSeam {
  return osFor(process.platform, options);
}
