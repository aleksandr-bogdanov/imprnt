// The door, as a program the operating system starts.
//
// Argv is `<registryFile> <entry id>` and nothing else. Which platform
// this door speaks, whose it is and where its credential lives are all in the
// registry entry the id names, which is what the loader already refuses a door
// for having no `platform`, `person` or `token_file`.
//
// Usage: bun run src/entry/door.ts <registryFile> <entry id>

import { councilApprovals } from "../council/approval.ts";
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
const platforms: Record<string, (options: { tokenFile: string; guild?: string }) => Platform> = {
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

// The server a channel name is resolved against, when the entry names one. A
// door without it still takes a channel id, and nothing else reads the field.
const guild = typeof raw.guild === "string" ? raw.guild : undefined;
// What an owner's green check on a frozen preview does is registered by the feature that owns the operation.
// A council's proposal is one (`council/approval.ts`); it reads the registry as it is at the moment of the approval.
const approvals = councilApprovals({ registry: () => loadRegistry(registryFile) });
const handle = await runDoor({ door, registryFile, platform: make({ tokenFile, guild }), approvals });
await hold(handle);
