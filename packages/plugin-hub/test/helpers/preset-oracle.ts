// The pinned preset id formula, computed by the TEST rather than read from the
// code under test, so the id is reproducible outside this codebase and a later
// question about an old turn record can be answered without running the hub.
//
// It imports nothing from src, and it hashes with node:crypto rather than
// through the registry's own hasher, because an oracle that borrowed the build
// would agree with every build.

import { createHash } from "node:crypto";

export function expectedPresetId(preset: Record<string, string>): string {
  const canonical = JSON.stringify({
    adapter: preset.adapter,
    effort: preset.effort,
    model: preset.model,
    paid: preset.paid,
    provider: preset.provider,
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}
