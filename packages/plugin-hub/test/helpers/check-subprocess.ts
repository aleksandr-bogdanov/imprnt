// Test infrastructure. Runs the REAL `runCheck` in a process of its own, with
// PATH fronted by shims that record every manager command anything in it tried
// to run.
//
// check 22 proved "check never acts on a finding" by
// handing `runCheck` a seam whose mutating verbs throw and record, and that
// only covers calls made THROUGH the supplied seam. A `check` that spawned
// `launchctl bootout` itself, or swallowed the seam's exception and then
// shelled out, passed it. A check cannot observe that from inside its own
// process, so this runs the real function somewhere it can: a child whose PATH
// begins with a directory holding a `launchctl` and a `systemctl` that log
// their argv and refuse every mutating verb.
//
// It makes ONE control invocation of the manager by bare name before it starts,
// so the log can never be empty by accident: an empty log would otherwise read
// the same whether nothing was invoked or the fronting never applied.
//
// Usage: bun run test/helpers/check-subprocess.ts <registryFile> <machine> <storeUrl> <kernelJson> -
//
// The last argument is `-`, so `runCheck` is handed `os: null`, which is the box
// with no manager: nothing of ours has any business invoking one, so the log
// must hold the control line and nothing else.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const hub = dirname(dirname(import.meta.dir));

function say(line: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify(line) + "\n");
  process.exit(line.ok === true ? 0 : 1);
}

const [registryFile, machine, storeUrl, kernelJson, unitDir] = process.argv.slice(2);
if (!registryFile || !machine || !storeUrl || !kernelJson || !unitDir) {
  say({
    ok: false,
    error: "usage: check-subprocess.ts <registryFile> <machine> <storeUrl> <kernelJson> -",
  });
}

const checkModule = join(hub, "src/check/run.ts");
if (!existsSync(checkModule)) {
  say({ ok: false, error: `seam module missing: src/check/run.ts (expected at ${checkModule})` });
}

// The control invocation. By BARE NAME, so it travels through PATH exactly as
// anything else in this process would, and lands in the shim's log.
const manager = process.platform === "darwin" ? "launchctl" : "systemctl";
const control =
  process.platform === "darwin"
    ? Bun.spawnSync([manager, "list"], { stdout: "pipe", stderr: "pipe" })
    : Bun.spawnSync([manager, "--user", "show", "--no-pager"], { stdout: "pipe", stderr: "pipe" });

try {
  const { runCheck } = (await import(checkModule)) as Record<string, Function>;
  if (typeof runCheck !== "function") say({ ok: false, error: "src/check/run.ts does not export runCheck" });

  const { openStore } = (await import(join(hub, "src/store/connect.ts"))) as Record<string, Function>;
  const store = await openStore({ url: storeUrl });

  let os: unknown = null;
  const findings = await runCheck({
    machine,
    registryFile,
    store,
    os,
    kernel: kernelJson === "null" ? null : JSON.parse(kernelJson),
  });
  await store.close?.().catch?.(() => {});
  say({
    ok: true,
    findings,
    control: `${manager} exited ${control.exitCode ?? "?"}`,
  });
} catch (error) {
  say({ ok: false, error: `runCheck refused: ${(error as Error).message}` });
}
