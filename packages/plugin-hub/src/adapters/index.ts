import { AdapterMissing, type Adapter } from "./types.ts";
import type { LoopLaunchInput, LoopProbeOptions } from "./launch.ts";
import { claudeCode } from "./claude-code.ts";

/**
 * The one place in the hub where a name maps to a loop. Every other piece takes
 * a map like this one as a parameter and looks the name up in it, so nothing
 * outside this file knows a loop exists.
 */
export const ADAPTERS: Record<string, Adapter> = {
  [claudeCode.name]: claudeCode,
};

export function adapterFor(adapters: Record<string, Adapter>, name: string): Adapter {
  const adapter = adapters[name];
  if (!adapter) throw new AdapterMissing(name, Object.keys(adapters));
  return adapter;
}

/** Synthetic adapters need no real login, but cannot silently inherit explicit sources. */
export async function loopLaunch(input: LoopLaunchInput, probe: LoopProbeOptions = {}) {
  const { makeLoopLaunch, sessionBox } = await import("./launch.ts");
  if (input.preset.adapter === claudeCode.name) {
    // IMP-162. Probed once per binary and login, and the login is checked every time.
    const { credentialSource, loopCapabilitiesFor } = await import("./launch.ts");
    await loopCapabilitiesFor(input.credential ?? credentialSource(input.registry, input.agent.preset), probe);
    return makeLoopLaunch(input);
  }
  if ([input.agent.fragment, input.agent.settings, input.agent.mcp, input.agent.tools]
      .some(value => value !== undefined)) throw new Error("loop-configuration-unsupported");
  return input.box.tree ? sessionBox(input) : {};
}

export async function checkLoopSource(registry: unknown, presetName: string, probe: LoopProbeOptions = {}) {
  const { getPreset } = await import("../registry/presets.ts");
  if (getPreset(registry, presetName).adapter !== claudeCode.name) return;
  const { credentialSource, validateCredentialSource, probeLoopCapabilities } = await import("./launch.ts");
  validateCredentialSource(credentialSource(registry, presetName));
  await probeLoopCapabilities(probe.bin, probe.timeoutMs, probe.writePaths);
}
