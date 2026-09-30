import type { MemberCause } from "./rows.ts";

/**
 * Why a member is missing, as a closed list, and what each one says in the two
 * languages a person reads and in the plain English the master is given.
 *
 * A CAUSE IS NAMED FROM THE STORE'S OWN FACT, never from a timer and never guessed. An
 * attempt that was interrupted, one whose process is not shown to be gone, one that was
 * stopped, a job that was refused, and a child that failed before it was handed the input are
 * five different facts and the owner is told which. A worker that is merely quiet or slow is
 * NOT missing and has no cause here: it is running, and `status.ts` says so.
 */
export const CAUSE_KINDS = [
  "interrupted", "ownership-unknown", "stopped", "failed_before_start", "refused", "given_up",
  "configuration_changed", "job_missing",
] as const;

export type CauseKind = (typeof CAUSE_KINDS)[number];

interface Words { master: string; en: string; ru: string }

const WORDS: Record<CauseKind, Words> = {
  interrupted: {
    master: "its attempt was interrupted after it started, so what it did before it stopped is not fully known",
    en: "its attempt was interrupted after it started",
    ru: "его попытка прервалась после начала работы",
  },
  "ownership-unknown": {
    master: "the hub cannot show that its process has ended, so it is not started again",
    en: "it is not shown that its process has ended",
    ru: "не подтверждено, что его процесс завершился",
  },
  stopped: {
    master: "its attempt was stopped",
    en: "its attempt was stopped",
    ru: "его попытка остановлена",
  },
  failed_before_start: {
    master: "it failed before it was given the input, and nothing it does is retried without the owner",
    en: "it failed before it received the task",
    ru: "он не смог начать работу и не получил задачу",
  },
  refused: {
    master: "its job was refused before it ran",
    en: "its job was refused before it ran",
    ru: "его задача отклонена до запуска",
  },
  given_up: {
    master: "the old council gave up on this seat",
    en: "the earlier council gave up on this seat",
    ru: "прежний совет отказался от этого участника",
  },
  configuration_changed: {
    master: "the configured worker, preset or machine no longer matches what was approved, so nothing was started for it",
    en: "its configured worker, model or machine no longer matches what was approved",
    ru: "его настройка (агент, модель или машина) больше не совпадает с подтверждённой",
  },
  job_missing: {
    master: "its job is not in the queue any more",
    en: "its job is no longer in the queue",
    ru: "его задачи больше нет в очереди",
  },
};

function known(kind: string): CauseKind | null {
  return (CAUSE_KINDS as readonly string[]).includes(kind) ? (kind as CauseKind) : null;
}

/** The cause in a sentence for the master, with the detail the store recorded, and only that. */
export function causeForMaster(cause: MemberCause | null): string {
  if (!cause) return "the reason is not recorded";
  const kind = known(cause.kind);
  const base = kind ? WORDS[kind].master : `an unrecognized state (${cause.kind})`;
  return typeof cause.detail === "string" && cause.detail !== "" ? `${base} (${cause.detail})` : base;
}

/** The cause as a phrase in the person's language, for a card or a notice. */
export function causeForOwner(language: "en" | "ru", cause: MemberCause | null): string {
  if (!cause) return language === "ru" ? "причина не записана" : "the reason is not recorded";
  const kind = known(cause.kind);
  const base = kind ? WORDS[kind][language] : language === "ru" ? `неизвестное состояние (${cause.kind})` : `an unrecognized state (${cause.kind})`;
  return typeof cause.detail === "string" && cause.detail !== "" ? `${base} (${cause.detail})` : base;
}
