import { AdapterMissing, type Adapter } from "./types.ts";
import type { LoopLaunchInput, LoopProbeOptions } from "./launch.ts";
import { claudeCode } from "./claude-code.ts";
import { codex } from "./codex.ts";
import { openCode } from "./opencode.ts";

/**
 * The one place in the hub where a name maps to a loop. Every other piece takes
 * a map like this one as a parameter and looks the name up in it, so nothing
 * outside this file knows a loop exists.
 */
export const ADAPTERS: Record<string, Adapter> = {
  [claudeCode.name]: claudeCode,
  [openCode.name]: openCode,
  [codex.name]: codex,
};

export function adapterFor(adapters: Record<string, Adapter>, name: string): Adapter {
  const adapter = adapters[name];
  if (!adapter) throw new AdapterMissing(name, Object.keys(adapters));
  return adapter;
}

/** Synthetic adapters need no real login, but cannot silently inherit explicit sources. */
export async function loopLaunch(input: LoopLaunchInput, probe: LoopProbeOptions = {}) {
  const { sessionBox } = await import("./launch.ts");
  // What a launch is made of is the engine's own, so it is prepared by the
  // adapter that names it. Nothing here knows what Claude needs.
  const own = ADAPTERS[input.preset.adapter];
  if (own?.prepareLaunch) return await own.prepareLaunch(input, probe);
  if ([input.agent.fragment, input.agent.settings, input.agent.mcp, input.agent.tools]
      .some(value => value !== undefined)) throw new Error("loop-configuration-unsupported");
  return input.box.tree ? sessionBox(input) : {};
}

export async function checkLoopSource(registry: unknown, presetName: string, probe: LoopProbeOptions = {}) {
  const { getPreset } = await import("../registry/presets.ts");
  const adapter = getPreset(registry, presetName).adapter;
  if (adapter === codex.name) {
    await codex.capabilities!({ registry, agent: { id: "check", preset: presetName }, preset: presetName, probe });
    return;
  }
  if (adapter === openCode.name) {
    // The key is a model key and the binary answers `--version`. Nothing is dialled and no model runs;
    // what the build restricts is read back from a running server at launch, never from here.
    const { credentialSource } = await import("./launch.ts");
    const own = await import("./opencode-launch.ts");
    own.readModelKey(credentialSource(registry, presetName));
    own.probeOpenCodeVersion(probe.bin, probe.timeoutMs);
    return;
  }
  if (adapter !== claudeCode.name) return;
  const { credentialSource, validateCredentialSource, probeLoopCapabilities } = await import("./launch.ts");
  validateCredentialSource(credentialSource(registry, presetName));
  const found = await probeLoopCapabilities(probe.bin, probe.timeoutMs, probe.writePaths);
  // A build that cannot deny a tool cannot be launched with native delegation
  // off, and that is said as what it is and not as a bad login.
  if (!found.native.includes("--disallowedTools")) throw new Error("native-delegation-unsupported");
}
