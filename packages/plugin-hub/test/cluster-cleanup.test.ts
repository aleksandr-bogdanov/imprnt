import { test, expect } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { hubPath, pgBin, startCluster } from "./helpers/cluster.ts";

test("normal cluster stop removes its temporary data and socket directory", async () => {
  const cluster = await startCluster();
  const root = dirname(cluster.dataDir);
  await cluster.stop();
  expect(existsSync(root)).toBe(false);
}, 60000);

test("interrupted test process stops its database and removes its own scratch directory", async () => {
  const child = Bun.spawn([process.execPath, hubPath("test/helpers/cluster-subprocess.ts")], { stdout: "pipe", stderr: "pipe" });
  let dataDir: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ready = await Promise.race([
      (async () => {
        const reader = child.stdout.getReader(); let text = "";
        for (;;) {
          const part = await reader.read();
          if (part.done) throw new Error("cluster-child-exited-before-ready");
          text += new TextDecoder().decode(part.value);
          if (text.includes("\n")) return JSON.parse(text.split("\n")[0]);
        }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cluster-ready-timeout")), 45000); }),
    ]);
    clearTimeout(timer);
    dataDir = ready.dataDir;
    const pid = Number(readFileSync(join(dataDir!, "postmaster.pid"), "utf8").split("\n")[0]);
    child.kill("SIGTERM");
    await Promise.race([child.exited, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("cluster-stop-timeout")), 30000); })]);
    clearTimeout(timer);
    expect(existsSync(dirname(dataDir!))).toBe(false);
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    clearTimeout(timer);
    child.kill("SIGKILL"); await child.exited;
    if (dataDir && existsSync(dataDir)) {
      const stopped = Bun.spawnSync([pgBin("pg_ctl"), "-D", dataDir, "-m", "immediate", "-w", "-t", "10", "stop"]);
      if (stopped.exitCode === 0 || !existsSync(join(dataDir, "postmaster.pid"))) rmSync(dirname(dataDir), { recursive: true, force: true });
    }
  }
}, 90000);
