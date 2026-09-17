/** What this platform's standard install is, measured on both boxes. */
interface Standard {
  /** The package manager command a person would run, as they would type it. */
  install: string[];
  /**
   * The command that starts Postgres's OWN service after that install, as a
   * person would type it, or null on a platform whose package manager starts
   * the cluster itself. It is one constant, used by `--dry` and by the real
   * run, so the command printed is the command issued.
   */
  service: string[] | null;
  /** The pid file that install writes, absolute. */
  pidFile: string;
  /** What the machine's service manager calls it. Informational. */
  unit: string;
}

/**
 * The version of the cluster this box already has, when it has one.
 *
 * Debian numbers its clusters and its pid file by version, so the standard path
 * is not one constant. `pg_lsclusters` prints `Ver Cluster Port Status ...`, and
 * a box with no clusters and no tool falls back to the version this hub was
 * built against, which is what a fresh `apt-get install postgresql` gives.
 */
function debianCluster(): { version: string; cluster: string } {
  try {
    const out = Bun.spawnSync(["pg_lsclusters", "--no-header"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    for (const line of (out.stdout?.toString() ?? "").split("\n")) {
      const columns = line.trim().split(/\s+/);
      if (columns.length >= 2 && /^\d+$/.test(columns[0])) {
        return { version: columns[0], cluster: columns[1] };
      }
    }
  } catch {
    // No `pg_lsclusters` is a box with no Debian Postgres packaging on it yet.
  }
  return { version: "15", cluster: "main" };
}

/**
 * Where Homebrew is on THIS Mac, asked rather than assumed.
 *
 * `/opt/homebrew` is Apple Silicon's prefix and `/usr/local` is Intel's. A
 * script that assumed the first would write a `[store]` section naming a pid
 * file that does not exist on the second, `readStorePid` would return null with
 * a reason, and the household would carry `peak-missing:postgres` forever under
 * a section that looks perfectly correct. So brew is asked, and only a box with
 * no brew falls back to the prefix its architecture ships with.
 */
function brewPrefix(): string {
  try {
    const asked = Bun.spawnSync(["brew", "--prefix"], { stdout: "pipe", stderr: "pipe" });
    const said = (asked.stdout?.toString() ?? "").trim();
    if ((asked.exitCode ?? 1) === 0 && said.startsWith("/")) return said;
  } catch {
    // No brew on this box at all, which the fallback below is for.
  }
  return process.arch === "arm64" ? "/opt/homebrew" : "/usr/local";
}

export function standardFor(platform: string): Standard {
  if (platform === "darwin") {
    return {
      install: ["brew", "install", "postgresql@17"],
      service: ["brew", "services", "start", "postgresql@17"],
      pidFile: `${brewPrefix()}/var/postgresql@17/postmaster.pid`,
      unit: "homebrew.mxcl.postgresql@17",
    };
  }
  const { version, cluster } = debianCluster();
  return {
    install: ["sudo", "apt-get", "install", "-y", "postgresql"],
    // Debian's own postinst runs `pg_createcluster` and starts the cluster's
    // unit, so there is no second command here and saying so is the honest
    // answer to "what service would you start".
    service: null,
    pidFile: `/var/run/postgresql/${version}-${cluster}.pid`,
    unit: `postgresql@${version}-${cluster}.service`,
  };
}

