// The six sentences a person reads about a voice note, whole, in both
// languages.
//
// SPEC §2 and L6: "When a clock runs out, the door says so in the chat, in the
// person's language, and says it is the door speaking." The marker is
// translated with the sentence, because an English label inside Russian prose
// is a defect under the copy rules this household already applies.
//
// The table, verbatim, so a reader of this check sees exactly what a person
// will read:
//
// | key            | en                                                        | ru |
// |----------------|-----------------------------------------------------------|----|
// | transcribing   | [door] still transcribing your voice note. {n} s so far.   | [дверь] всё ещё расшифровываю голосовое сообщение. Прошло {n} с. |
// | transcriberDown| [door] the transcriber is not answering. Your voice note is waiting and nothing is lost. I try again every {n} s and will say when it works. | [дверь] расшифровка не отвечает. Голосовое сообщение ждёт, ничего не потеряно. Повторяю попытку каждые {n} с и сообщу, когда заработает. |
// | transcriberBack| [door] transcription works again. Voice notes waiting: {count}. | [дверь] расшифровка снова работает. Голосовых в очереди: {count}. |
// | voiceUnreadable| [door] I could not make out the voice note: it sounds like silence or no words. Please type it. | [дверь] голосовое сообщение не разобрать: похоже, там тишина. Напишите текстом. |
// | voiceGaveUp    | [door] I could not transcribe your voice note after {hours} h. It is saved. Please type it. | [дверь] не удалось расшифровать голосовое сообщение за {hours} ч. Оно сохранено. Напишите текстом. |
// | gap marker     | [... {n} s not transcribed]                               | [... {n} с не расшифровано] |
//
// Pure. No Postgres, no door, no platform, so none of the six protected windows
// is reachable from here.
//
// Red reason: behaviour absent for the transcribing line, because `clockLine`
// has three stamps and a fourth throws, and import missing for the five new
// exports read from the shipped `src/door/lines.ts`.

import { expect, test } from "bun:test";
import { seam } from "./helpers/cluster.ts";

/** The twelve strings, written out by the TEST and never imported. */
const EN = {
  transcribing: (n: number) => `[door] still transcribing your voice note. ${n} s so far.`,
  down: (n: number) =>
    `[door] the transcriber is not answering. Your voice note is waiting and nothing is lost. ` +
    `I try again every ${n} s and will say when it works.`,
  back: (n: number) => `[door] transcription works again. Voice notes waiting: ${n}.`,
  unreadable: () =>
    `[door] I could not make out the voice note: it sounds like silence or no words. Please type it.`,
  gaveUp: (n: number) =>
    `[door] I could not transcribe your voice note after ${n} h. It is saved. Please type it.`,
  gap: (n: number) => `[... ${n} s not transcribed]`,
};

const RU = {
  transcribing: (n: number) =>
    `[дверь] всё ещё расшифровываю голосовое сообщение. Прошло ${n} с.`,
  down: (n: number) =>
    `[дверь] расшифровка не отвечает. Голосовое сообщение ждёт, ничего не потеряно. ` +
    `Повторяю попытку каждые ${n} с и сообщу, когда заработает.`,
  back: (n: number) => `[дверь] расшифровка снова работает. Голосовых в очереди: ${n}.`,
  unreadable: () =>
    `[дверь] голосовое сообщение не разобрать: похоже, там тишина. Напишите текстом.`,
  gaveUp: (n: number) =>
    `[дверь] не удалось расшифровать голосовое сообщение за ${n} ч. Оно сохранено. Напишите текстом.`,
  gap: (n: number) => `[... ${n} с не расшифровано]`,
};

/** The numbers every sentence is rendered at, including both boundaries. */
const COUNTS = [1, 0, 3600];

test(
  "MSG-10 the six voice sentences a person reads are pinned whole in both languages, the transcribing line joins the shipped clock family, and the gap marker carries no machinery marker (SPEC §2, L6)",
  async () => {
    const {
      clockLine,
      transcriberDown,
      transcriberBack,
      voiceUnreadable,
      voiceGaveUp,
      gapMarker,
      mediaKind,
      MACHINERY_LINES,
    } = await seam("src/door/lines.ts");
    for (const one of [
      clockLine,
      transcriberDown,
      transcriberBack,
      voiceUnreadable,
      voiceGaveUp,
      gapMarker,
    ]) {
      expect(typeof one).toBe("function");
    }

    const clock = clockLine as (language: string, stamp: string, n: number) => string;
    const down = transcriberDown as (language: string, n: number) => string;
    const back = transcriberBack as (language: string, n: number) => string;
    const unreadable = voiceUnreadable as (language: string) => string;
    const gaveUp = voiceGaveUp as (language: string, n: number) => string;
    const gap = gapMarker as (language: string, n: number) => string;

    // --- 1. the transcribing clock line, through the SHIPPED clockLine with a
    //     fourth stamp. It joins the clock family rather than becoming a
    //     function of its own, which is what keeps `sayExpired`, `recordExpiry`
    //     and the ledger's ASCII stamp key working untouched.
    expect(clock("en", "transcribed", 47)).toBe(EN.transcribing(47));
    expect(clock("ru", "transcribed", 47)).toBe(RU.transcribing(47));

    // --- 2. the outage pair, both whole, both languages. The Russian count is
    //     written so number agreement is correct for every count, which is the
    //     reason the shipped catch-up line gives for its own wording.
    expect(down("en", 300)).toBe(EN.down(300));
    expect(down("ru", 300)).toBe(RU.down(300));
    expect(back("en", 4)).toBe(EN.back(4));
    expect(back("ru", 4)).toBe(RU.back(4));

    // --- 3. the two content lines.
    expect(unreadable("en")).toBe(EN.unreadable());
    expect(unreadable("ru")).toBe(RU.unreadable());
    expect(gaveUp("en", 24)).toBe(EN.gaveUp(24));
    expect(gaveUp("ru", 24)).toBe(RU.gaveUp(24));

    // --- 4. the gap marker. It is the ONE string here with no machinery
    //     marker, and the reason is that it sits INSIDE the text slot of the
    //     message, which is the person's own words. A marker in the middle of a
    //     sentence somebody dictated would read as the door having said it.
    expect(gap("en", 61)).toBe(EN.gap(61));
    expect(gap("ru", 61)).toBe(RU.gap(61));
    const markers = MACHINERY_LINES as Record<string, string>;
    expect(gap("en", 61).includes(markers.en)).toBe(false);
    expect(gap("ru", 61).includes(markers.ru)).toBe(false);

    // --- 5. every one of the six carries its own language's marker and never
    //     the other's, asserted both ways.
    const english = [clock("en", "transcribed", 5), down("en", 5), back("en", 5), unreadable("en"), gaveUp("en", 5), gap("en", 5)];
    const russian = [clock("ru", "transcribed", 5), down("ru", 5), back("ru", 5), unreadable("ru"), gaveUp("ru", 5), gap("ru", 5)];
    for (const line of english) expect(line.includes(markers.ru)).toBe(false);
    for (const line of russian) expect(line.includes(markers.en)).toBe(false);

    // --- 6. the marker table is whole and unchanged, and every marked line
    //     STARTS with its language's value from it rather than with a literal,
    //     so a build that spelled the marker again in five places is caught.
    expect(MACHINERY_LINES).toEqual({ en: "[door]", ru: "[дверь]" });
    for (const line of english.slice(0, 5)) expect(line.startsWith(markers.en)).toBe(true);
    for (const line of russian.slice(0, 5)) expect(line.startsWith(markers.ru)).toBe(true);

    // --- 7. the interpolation is a NUMBER and not a string, at both boundaries
    //     and in the middle, with each sentence compared whole.
    for (const n of COUNTS) {
      expect(clock("en", "transcribed", n)).toBe(EN.transcribing(n));
      expect(clock("ru", "transcribed", n)).toBe(RU.transcribing(n));
      expect(down("en", n)).toBe(EN.down(n));
      expect(down("ru", n)).toBe(RU.down(n));
      expect(back("en", n)).toBe(EN.back(n));
      expect(back("ru", n)).toBe(RU.back(n));
      expect(gaveUp("en", n)).toBe(EN.gaveUp(n));
      expect(gaveUp("ru", n)).toBe(RU.gaveUp(n));
      expect(gap("en", n)).toBe(EN.gap(n));
      expect(gap("ru", n)).toBe(RU.gap(n));
    }

    // --- 8. the closed kind-word mapping is unchanged. The new sentences name
    //     a voice note in prose, and a build that rewired the mapping to serve
    //     them would change the media line every shipped media check reads.
    expect((mediaKind as Function)("ru", "voice")).toBe("голосовое сообщение");
    expect((mediaKind as Function)("en", "voice")).toBe("voice");

    // --- the control. Each of the twelve strings is compared against a
    //     DELIBERATELY WRONG twin, and every one of those comparisons must
    //     fail. Without it this is a check that a function returns a string.
    const wrong: [string, string][] = [
      [clock("en", "transcribed", 47), "[door] still transcribing your voice note — 47 s so far."],
      [clock("ru", "transcribed", 47), "[дверь] всё ещё расшифровываю голосовое сообщение; Прошло 47 с."],
      [down("en", 300), EN.down(300).replace("300", "{n}")],
      [down("ru", 300), RU.down(300).replace("300", "{n}")],
      [back("en", 4), EN.back(4).replace(".", ";")],
      [back("ru", 4), RU.back(4).replace("4", "{count}")],
      [unreadable("en"), EN.unreadable().replace(":", " —")],
      [unreadable("ru"), RU.unreadable().replace(":", ";")],
      [gaveUp("en", 24), EN.gaveUp(24).replace("24", "{hours}")],
      [gaveUp("ru", 24), RU.gaveUp(24).replace("24", "{hours}")],
      [gap("en", 61), "[... {n} s not transcribed]"],
      [gap("ru", 61), "[... 61 с не расшифровано ]"],
    ];
    for (const [real, twin] of wrong) {
      expect(real).not.toBe(twin);
      expect(twin).not.toBe(real);
    }
  },
);
