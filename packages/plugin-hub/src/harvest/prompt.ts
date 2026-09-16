import { renderSlice, type SliceLine } from "./slice.ts";

/**
 * D-158. The one message a harvester is ever fed, pinned WHOLE.
 *
 * D-105's rule is that a string a reader depends on is pinned rather than
 * assembled, and here the reader is a MODEL: a prompt built from fragments is a
 * prompt nobody can review, and what this one says is the difference between a
 * note that files and a note that poisons a vault.
 *
 * EVERY LINE OF IT CLOSES A DEFECT THE PROBE MEASURED (05-BRIEF, four real runs
 * of the real loop on 2026-09-16), and the rules are in that order:
 *
 * - `nothing` as a single word, because that is exactly what the loop answered
 *   on a slice of chatter, and honouring a sentence instead would be code
 *   guessing at meaning.
 * - the LANGUAGE, because a Russian slice came back as two English notes with
 *   an invented `time:` field. It is the PERSON's language and not "the
 *   language of the slice" (D-158): the second is unfalsifiable by any check,
 *   because no assertion distinguishes a build that put that sentence in the
 *   message from one that did not, while the first is a registry edit and a
 *   pinned word inside the fed bytes.
 * - `{inferred}`, which is the vault contract's own marker for a conclusion the
 *   model reached rather than read.
 * - no `source:`, because `--apply` keeps a note's own `source:` VERBATIM and
 *   records it as the manifest's raw entry, and the loop fabricated one
 *   (`raw/proposed/wifi-password-location-2026-09-16`) pointing at nothing.
 * - no invented slug, because the loop wrote an event whose `participants`
 *   named `[[people/maple]]` while the person note it wrote in the same reply
 *   slugged to `people/dr-maple`. Both are orphan links after filing.
 * - only the fields the filing rules define, because it invented `ingested:`
 *   and a `status:` on an event.
 * - reading the vault is PERMITTED, and that is the deduplication: measured
 *   with the vault readable, the loop read three already-filed notes,
 *   recognised them, and produced only the one fact not yet there, for ten
 *   cached turns and the same cost. Writing is impossible in headless mode with
 *   no permission flag (measured three ways: `Write` refused, `Edit` never
 *   reached, `echo >` blocked), so the sentence describes the loop rather than
 *   fencing it. The fence is that the reply's TEXT is the only thing that
 *   reaches the vault, which is SPEC §2's "an agent produces text, delivery is
 *   machinery" applied to filing.
 */
export const HARVEST_PROMPT = `You are the harvester. You read one slice of a chat and file what is worth keeping into the vault this session is running in, through the filing rules its CLAUDE.md carries.

Answer with NOTES ONLY, in this envelope:

=== NOTE ===
<one complete note: frontmatter between --- lines, then an H1 title, then the body>
=== END ===

One block per note, repeated for each note. Nothing outside the blocks.

The rules:
- Answer the single word nothing when the slice holds nothing worth keeping. That is a real answer, not a failure.
- Write every note in {LANGUAGE}: the title, the summary and the body.
- Mark your own conclusions {inferred}. Anything straight from the slice carries no marker.
- Never write a source: line. The filing machinery injects the real one, and an invented one is provenance pointing at nothing.
- Link a person only through a people note that already exists, by the slug that note really has. Read people/ to find it. Never invent a slug and never name anyone the slice does not name.
- Carry only the fields the filing rules define for that type. An invented field is noise the vault keeps for ever.
- You MAY read this vault with Read, Glob and Grep, to find a note to link and to avoid filing something the vault already holds. You cannot write to it: your text is the answer, and code does the filing.
- Do not run any command that writes, sends, fetches or installs anything.

The slice follows, one line per message, oldest first, as <time> <who>: <what>.`;

/** What the prompt calls each language the household speaks. */
export const LANGUAGE_NAMES: Record<"en" | "ru", string> = {
  en: "English",
  ru: "Russian",
};

/** The prompt for one person, with the one slot filled. */
export function harvestPrompt(language: "en" | "ru"): string {
  return HARVEST_PROMPT.replace("{LANGUAGE}", LANGUAGE_NAMES[language] ?? LANGUAGE_NAMES.en);
}

/**
 * The whole of what a harvester is fed, once, and never anything else.
 *
 * No `TAIL_PREAMBLE`: that string exists to tell a spawned session the lines
 * below it are context it must not answer, and a harvester is fed no tail at
 * all. Its one message IS the work.
 */
export function harvestMessage(args: {
  language: "en" | "ru";
  lines: SliceLine[];
}): string {
  return `${harvestPrompt(args.language)}\n\n${renderSlice(args.lines)}`;
}
