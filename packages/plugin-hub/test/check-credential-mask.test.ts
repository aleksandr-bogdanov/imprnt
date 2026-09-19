// A credential the Linux box can only mask one file at a time is a finding. On
// Linux a single-file mask is a bind over one directory entry, and the kernel
// lifts it if the host replaces the file by renaming a new one over it. The box
// masks a credential's whole directory when it holds nothing the loop needs, so
// a rename cannot lift it, but a credential that shares a directory with the
// launched login cannot be masked that way. `check` reports that residual on a
// Linux machine so an operator can move the file.
//
// The control is the opposite layout, one login to a directory, which is masked
// whole and produces nothing, and a Mac machine, where the box denies by path at
// every access so a rename lifts nothing and the finding does not apply.
//
// Red reason: `runCheck` reports no such finding, so a second login beside the
// launched one is silent on Linux.

import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { startCluster, seam, type Cluster } from "./helpers/cluster.ts";
import { PERSON, stageHub, superStore } from "./helpers/hub-fixture.ts";
import type { Finding } from "../src/check/finding.ts";

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { if (cluster) await cluster.stop(); });

const masks = (findings: Finding[]) => findings.filter((one) => one.kind === "credential-file-mask");

async function findingsOn(os: "linux" | "macos", place: "shared" | "own"): Promise<Finding[]> {
  const { runCheck } = await seam("src/check/run.ts");
  const it = await stageHub(cluster, {
    machines: [{ id: "box", os }],
    credentials: [
      { id: "shared-login", kind: "claude-login", file: "PLACEHOLDER-A", owner: "household" },
      { id: "second-login", kind: "claude-login", file: "PLACEHOLDER-B", owner: "household" },
    ],
    preset: { credential: "shared-login" },
    run: [
      { id: "door-fake", kind: "door", machine: "box", platform: "fake", person: PERSON, token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-box", kind: "runner", machine: "box", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 512 },
    ],
    registry: (base) => ({ ...base, agents: (base.agents ?? []).map((agent) => ({ ...agent, runner: "runner-box" })) }),
  });
  try {
    // The launched login, and a second login that shares its directory or has
    // one of its own.
    const launchedDir = join(it.stateDir, "login");
    mkdirSync(launchedDir, { recursive: true });
    const launched = join(launchedDir, ".credentials.json");
    writeFileSync(launched, "{}", "utf8");
    const second = place === "shared" ? join(launchedDir, "second.credentials.json") : join(it.stateDir, "second", ".credentials.json");
    mkdirSync(dirname(second), { recursive: true });
    writeFileSync(second, "{}", "utf8");
    const text = readFileSync(it.registryFile, "utf8")
      .replace('"PLACEHOLDER-A"', JSON.stringify(launched))
      .replace('"PLACEHOLDER-B"', JSON.stringify(second));
    writeFileSync(it.registryFile, text);
    const store = await superStore(cluster, it.db);
    try {
      return masks((await (runCheck as Function)({ machine: "box", registryFile: it.registryFile, store, os: null, kernel: null })) as Finding[]);
    } finally { await store.close(); }
  } finally { await it.stop(); }
}

test("a second login sharing the launched login's directory on a Linux machine is a credential-file-mask finding, one login to a directory is not, and a Mac machine reports nothing either way", async () => {
  const shared = await findingsOn("linux", "shared");
  expect(shared.length).toBe(1);
  expect(shared[0].id.startsWith("box/credential-file-mask:")).toBe(true);
  expect(shared[0].says).toContain("rename");
  expect(shared[0].fix.length).toBeGreaterThan(0);

  const own = await findingsOn("linux", "own");
  expect(own.length).toBe(0);

  const mac = await findingsOn("macos", "shared");
  expect(mac.length).toBe(0);
}, 180_000);
