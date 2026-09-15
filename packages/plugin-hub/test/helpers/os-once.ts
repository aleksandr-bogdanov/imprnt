// Test infrastructure: render, install and start, in a process that then EXITS.
//
// Check 6 says a killed listed process is back within the OS restart delay
// "with nothing of ours running", and that absence is the whole load: if the
// process comes back with no code of ours alive, the restart can only have been
// the operating system's, which is what SPEC section 6's Forbidden "a
// supervisor of ours" means as a behaviour rather than as a grep.
//
// The second seat found the hole in the first shape of that check: install and
// start went through `thisOs()` INSIDE the test process, which stayed alive for
// the whole check, so an OS implementation carrying its own timer could have
// kickstarted the dead job itself and satisfied every assertion. This entry
// closes it. It does the install and the start here, prints what it rendered,
// and exits. The check then kills the pid with no seam object anywhere in its
// own runtime and reads the manager directly through `test/helpers/manager.ts`,
// so a timer of ours would have to have survived the death of the only process
// that ever built one.
//
// It prints exactly one JSON line and exits: {"ok":true,...} or
// {"ok":false,"error":"seam module missing: src/os/index.ts"}, which is the
// same red reason, on one readable line, that `seam()` gives in a test body.
//
// Usage: bun run test/helpers/os-once.ts <unitDir> <registryFile> <machine> <entryScript> <entryId>...

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const hub = dirname(dirname(import.meta.dir));

function say(line: Record<string, unknown>): never {
  process.stdout.write(JSON.stringify(line) + "\n");
  process.exit(line.ok === true ? 0 : 1);
}

const [unitDir, registryFile, machine, entryScript, ...entryIds] = process.argv.slice(2);
if (!unitDir || !registryFile || !machine || !entryScript || entryIds.length === 0) {
  say({
    ok: false,
    error: "usage: os-once.ts <unitDir> <registryFile> <machine> <entryScript> <entryId>...",
  });
}

const osModule = join(hub, "src/os/index.ts");
if (!existsSync(osModule)) {
  say({ ok: false, error: `seam module missing: src/os/index.ts (expected at ${osModule})` });
}

try {
  const osMod = (await import(osModule)) as Record<string, unknown>;
  const thisOs = osMod.thisOs as ((options?: unknown) => Record<string, Function>) | undefined;
  if (typeof thisOs !== "function") say({ ok: false, error: "src/os/index.ts does not export thisOs" });

  const { loadRegistry, readSetting } = (await import(join(hub, "src/registry/load.ts"))) as Record<
    string,
    Function
  >;
  const { listRunEntries } = (await import(join(hub, "src/registry/entries.ts"))) as Record<string, Function>;

  const os = thisOs({ unitDir });
  const registry = loadRegistry(registryFile);
  const entries = listRunEntries(registry) as { id: string }[];
  // From the FILE, the way the hub would read them, so the delay the check
  // reads back out of the rendered text is the one the registry asked for.
  const setting = (name: string, fallback: number): number => {
    const found = readSetting(registry, name);
    return found === undefined || found === null ? fallback : Number(found);
  };
  const rendered: Record<string, string> = {};
  const installed: string[] = [];

  for (const id of entryIds) {
    const entry = entries.find((e) => e.id === id);
    if (!entry) say({ ok: false, error: `the registry has no [[run]] entry ${id}` });
    const files = (await os.render(entry, {
      machine,
      execPath: process.execPath,
      entryScript,
      registryFile,
      restartDelaySeconds: setting("hub.restart_delay_seconds", 1),
      giveUpAfter: setting("hub.give_up_after", 5),
      giveUpWindowSeconds: setting("hub.give_up_window_seconds", 300),
    })) as { path: string; text: string }[];
    rendered[id] = files.map((f) => f.text).join("\n");
    installed.push(...((await os.install(files)) as string[]));
  }
  for (const id of entryIds) await os.start(id);

  say({ ok: true, installed, rendered, flavour: String(os.flavour) });
} catch (error) {
  say({ ok: false, error: `the OS seam refused: ${(error as Error).message}` });
}
