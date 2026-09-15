// The door, as a program the operating system starts.
//
// D-94. Argv is `<registryFile> <entry id>` and nothing else. Which platform
// this door speaks, whose it is and where its credential lives are all in the
// registry entry the id names, which is what the loader already refuses a door
// for having no `platform`, `person` or `token_file`.
//
// Usage: bun run src/entry/door.ts <registryFile> <entry id>

import { runDoor } from "../door/run.ts";
import { discord } from "../door/platforms/discord.ts";
import { telegram } from "../door/platforms/telegram.ts";
import type { Platform } from "../door/platform.ts";
import { loadRegistry } from "../registry/load.ts";
import { hold, usage } from "./hold.ts";

const [registryFile, door] = process.argv.slice(2);
if (!registryFile || !door) usage("door");

const registry = loadRegistry(registryFile);
const raw = ((registry.data.run ?? []) as Record<string, unknown>[]).find(
  (entry) => entry.id === door,
);
if (!raw) {
  process.stderr.write(`${registryFile} has no [[run]] entry ${door}\n`);
  process.exit(2);
}

const speaks = String(raw.platform ?? "");
const tokenFile = String(raw.token_file ?? "");
const platforms: Record<string, (options: { tokenFile: string }) => Platform> = {
  telegram,
  discord,
};
const make = platforms[speaks];
if (!make) {
  process.stderr.write(
    `${door} speaks ${speaks || "nothing"}, and the platforms this door has are ${Object.keys(platforms).join(", ")}\n`,
  );
  process.exit(2);
}

const handle = await runDoor({ door, registryFile, platform: make({ tokenFile }) });
await hold(handle);
