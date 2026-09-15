import { PRESET_KEYS, Registry, type PresetEntry, type RateEntry } from "./load.ts";

/**
 * A preset is a bundle of settings and its id is derived from them, so two
 * presets with the same settings are one thing and a changed setting is a
 * different one. Nothing here is typed by a human.
 */
export const PRESET_FIELDS: readonly string[] = PRESET_KEYS;

export type Preset = PresetEntry;

export type Rate = RateEntry;

export interface Price {
  amount: number;
  currency: string;
  rate_from: string;
}

/**
 * The formula, fixed so an old turn record can be checked outside this
 * codebase: sha256 over the five settings as canonical JSON, keys in
 * alphabetical order, the first sixteen hex characters.
 */
export function presetId(preset: Preset): string {
  const canonical = JSON.stringify({
    adapter: preset.adapter,
    effort: preset.effort,
    model: preset.model,
    paid: preset.paid,
    provider: preset.provider,
  });
  return new Bun.CryptoHasher("sha256").update(canonical).digest("hex").slice(0, 16);
}

function loaded(registry: unknown, who: string): Registry {
  if (!(registry instanceof Registry)) {
    throw new TypeError(
      `${who} reads a registry loaded by loadRegistry, and this is ${typeof registry}`,
    );
  }
  return registry;
}

/** The preset by name, as the five settings and nothing else. */
export function getPreset(registry: unknown, name: string): Preset {
  const it = loaded(registry, "getPreset");
  const preset = it.presets[name];
  if (!preset) throw new Error(`${name} is not a preset of ${it.file}`);
  return { ...preset };
}

/** The newest rate row for this model that was already in force at that moment. */
export function rateFor(registry: unknown, model: string, at: Date): Rate | null {
  const covering = loaded(registry, "rateFor")
    .rates.filter((rate) => rate.model === model && Date.parse(rate.from) <= at.getTime())
    .sort((a, b) => Date.parse(a.from) - Date.parse(b.from));
  return covering.length === 0 ? null : { ...covering[covering.length - 1] };
}

/**
 * What the turn cost, or null when it is not knowable.
 *
 * Null on a plan login, where the household pays for a month and not for a
 * turn. Null when no dated row covers the model at that moment. Null when any
 * one of the three counts is missing, because a sum of two of three is a guess
 * wearing a number's clothes. Nothing is rounded.
 */
export function priceFor(
  registry: unknown,
  turn: {
    model: string;
    at: Date;
    paid: string;
    usage: {
      input_tokens: number | null;
      cached_input_tokens: number | null;
      output_tokens: number | null;
    };
  },
): Price | null {
  if (turn.paid === "plan") return null;
  const counts = [
    turn.usage.input_tokens,
    turn.usage.cached_input_tokens,
    turn.usage.output_tokens,
  ];
  if (counts.some((count) => typeof count !== "number")) return null;
  const rate = rateFor(registry, turn.model, turn.at);
  if (!rate) return null;
  const [input, cached, output] = counts as number[];
  return {
    amount:
      (input / 1_000_000) * rate.input_per_m +
      (cached / 1_000_000) * rate.cached_per_m +
      (output / 1_000_000) * rate.output_per_m,
    currency: rate.currency,
    rate_from: rate.from,
  };
}
