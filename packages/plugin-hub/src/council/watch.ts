import { prepareReply } from "../door/reply.ts";
import { languageOf } from "../registry/entries.ts";
import { readSetting, type Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { readEffect, renderEffect, wantEffect } from "../store/effects.ts";
import { chatUsable, noteAttention, readTopicByChat } from "../store/topics.ts";
import { told, councilGapKind } from "./attention.ts";
import { checkpointMinutes } from "./checkpoint.ts";
import { generalOf, messageLink } from "./general.ts";
import {
  checkpointNotice, correctionWaitingNotice, generalNotice, legacyUnmergedNotice, masterInterruptedNotice, missingNotice, overrunNotice, quietNotice, routingIssue,
  statusLine, stageKey, type Need,
} from "./lines.ts";
import { reconcileCouncil } from "./reconcile.ts";
import { patchCouncil, readCouncil, type CouncilRow } from "./rows.ts";
import { readSnapshot, type CouncilSnapshot } from "./snapshot.ts";
import { platformOf } from "./start.ts";
import { finding, safeValue, type Language } from "../door/lines.ts";

/**
 * The door's ONE task for councils: it keeps each live council's card true and says what needs the owner,
 * from the rows and from nothing else.
 *
 * WHAT IT DOES, FOR EACH COUNCIL THAT ANSWERS IN THIS DOOR'S CHATS
 *   1. reconciles it (a member's hold, a stop's evidence, a correction waiting for a process to end are all
 *      rows the runner wrote and does not know councils by), so the state is current before anything is said;
 *   2. writes the card's words on the ledger (`platform_effect`, one message edited in place, the door's effect
 *      task is what sends), COALESCED: at most one write in `council.status_write_seconds`, at once when the
 *      stage changes, and otherwise only after `council.status_edit_seconds` and only when the words changed;
 *   3. says what needs the owner, once per condition, in the council's own chat and in their General: a
 *      participant that cannot be waited for, a worker with no output for the quiet threshold or on one attempt
 *      for the overrun threshold, the checkpoint, a master turn that did not finish. A quiet or long-running
 *      worker is only said, never stopped, retried or called failed.
 *
 * NO GENERAL, NO SUBSTITUTE. When the owner has no usable General the need is said in the council's own chat
 * as a named routing issue, and in no other chat.
 *
 * IT WAKES ON A NOTIFICATION AND ON ITS OWN TIMER, and arms the timer only while a council is live, so a door
 * with no live council issues no statement at all. Its connect read takes its turn through the door's connect
 * gate, for the reason written at that gate.
 */
export interface CouncilWatch {
  wake(): void;
  ready: Promise<void>;
  stop(): Promise<void>;
}

const TERMINAL_STAGES = ["complete", "stopped"];

interface Settings { writeMs: number; editMs: number; quietSeconds: number; overrunSeconds: number }

const settingsOf = (registry: Registry): Settings => ({
  writeMs: Number(readSetting(registry, "council.status_write_seconds")) * 1000,
  editMs: Number(readSetting(registry, "council.status_edit_seconds")) * 1000,
  quietSeconds: Number(readSetting(registry, "council.quiet_minutes")) * 60,
  overrunSeconds: Number(readSetting(registry, "council.overrun_minutes")) * 60,
});

/** The councils this door has something to say about: live ones, and finished ones whose last card was not written yet. */
async function candidates(store: StoreLike, door: string): Promise<string[]> {
  const rows = (await store.sql`select id from council
    where return_route ->> 'door' = ${door}
      and (lifecycle not in ('complete', 'stopped')
           or (origin_kind <> 'legacy' and (status_stage is null or (status_stage not like 'complete:%' and status_stage not like 'stopped:%'))))
    order by created_at, id`) as unknown as { id: string }[];
  return rows.map(one => one.id);
}

interface Line { person: string; agent: string; route: { door: string; chat: string }; key: string; body: string; platform: string; language: Language }

async function notice(store: StoreLike, say: Line): Promise<void> {
  for (const [index, part] of prepareReply(say.body, say.platform, say.language).entries()) {
    await store.sql`select hub_door_notice(${say.person}, ${say.agent}, ${part}, ${index === 0 ? say.key : `${say.key}:part:${index + 1}`},
      ${{ door: say.route.door, chat: say.route.chat }}::jsonb, ${index + 1})`;
  }
}

/** The attempt the master is (or was) working on for a council, for the key of a notice about it. */
async function masterAttempt(store: StoreLike, council: CouncilRow): Promise<string> {
  if (council.finalize) return council.finalize.attempt;
  const [row] = (await store.sql`select consumed_attempt from council_event where council_id = ${council.id} and consumed_attempt is not null
    order by consumed_at desc, seq desc limit 1`) as unknown as { consumed_attempt: string }[];
  return row?.consumed_attempt ?? "none";
}

/**
 * `now` is the pass's own clock, the one the snapshot and the card were read at: a duration said in a notice is measured on it too.
 *
 * A NOTICE IS WRITTEN ONLY TO A PLACE THAT CAN TAKE IT, measured as the topics measure it (`chatUsable`: not archived, being
 * reopened, gone or being deleted), the council's own chat and General each by itself. A need that has no place left is not
 * written anywhere: it is kept as a gap on the topic of the council's chat (`attention.ts`) and paid, once, by the topic catch-up
 * when a place can take it. A need that was said or paid for is never kept, and a need said now clears the gap it left, in the
 * same transaction. A chat with no topic is a chat nothing can say is unusable, and is written to as it always was.
 */
async function attend(store: StoreLike, council: CouncilRow, snapshot: CouncilSnapshot, registry: Registry, language: Language, settings: Settings, now: Date): Promise<void> {
  const route = { door: council.return_route.door, chat: council.return_route.chat };
  const platform = platformOf(registry, route.door);
  const found = generalOf(registry, council.person);
  const general = "general" in found ? found.general : null;
  const effect = await readEffect(store, council.status_effect_key);
  // The link is to the card in the council's own chat, when the platform has links and the card has an id.
  const link = general ? messageLink({ platform, guild: await guildOf(registry, route.door), chat: route.chat, message: effect?.platform_id ?? null }) : null;
  const ownUsable = await chatUsable(store, route.door, route.chat);
  const generalUsable = general !== null && await chatUsable(store, general.door, general.chat);
  const topic = await readTopicByChat(store, route.door, route.chat);
  const keeps = topic !== null && topic.lifecycle !== "deleting" ? topic.id : null;
  const mine = { person: council.person, agent: council.return_route.agent, route, platform, language };

  /**
   * Say one need once: the specific line in the council's chat, and a keyed line (with a link) in General, or the routing issue.
   * `origin: false` is a need that is General's alone; `general: false` one that is the council's chat's alone.
   */
  const say = async (need: Need, key: string, body: string, options: { origin?: boolean; general?: boolean; link?: string | null } = {}): Promise<void> => {
    const lines: Line[] = [];
    if (options.origin !== false && ownUsable) lines.push({ ...mine, key, body });
    if (options.general !== false) {
      if (general !== null && generalUsable) {
        lines.push({ person: council.person, agent: general.agent, route: { door: general.door, chat: general.chat }, key: `${key}:general`,
          body: generalNotice(language, snapshot, need, options.link === undefined ? link : options.link), platform: general.platform, language });
      } else if (general === null && options.origin !== false && ownUsable) {
        lines.push({ ...mine, key: `${key}:routing`, body: routingIssue(language, snapshot, need) });
      }
    }
    if (keeps === null) {
      for (const line of lines) await notice(store, line);
      return;
    }
    const kind = councilGapKind(need, council.id, key);
    if (lines.length === 0) {
      // Nobody is configured to be told by a need that is General's alone and has no General: `check` says so, and nothing is owed.
      if (options.origin === false && general === null) return;
      if (await told(store, keeps, key, kind)) return;
      await noteAttention(store, keeps, kind, general === null ? "general_not_configured" : generalUsable ? "origin_unusable" : "general_unusable");
      return;
    }
    await store.sql.begin(async (sql) => {
      const tx = { ...store, sql: sql as unknown as StoreLike["sql"] };
      // The gap is cleared first, which takes the topic's row for as long as this transaction runs: a catch-up for it that is waiting
      // finds it gone and queues nothing, and one that has already been queued is seen below.
      await noteAttention(tx, keeps, kind, null);
      if (await told(tx, keeps, key, kind)) return;
      for (const line of lines) await notice(tx, line);
    });
  };

  const terminal = TERMINAL_STAGES.includes(snapshot.stage);
  const missing = snapshot.members.filter(one => one.view === "missing");
  if (!terminal && missing.length > 0) {
    const ids = missing.map(one => `${one.participant}.${one.input_revision}`).sort().join(",");
    await say("members_missing", `council-missing:${council.id}:${ids}`, missingNotice(language, snapshot, missing));
  }
  if (!terminal) {
    for (const one of snapshot.members) {
      if (one.attempt === null) continue;
      if (one.view === "quiet") {
        const since = one.activity_at !== null ? (now.getTime() - Date.parse(one.activity_at)) / 1000 : one.running_seconds ?? 0;
        await say("quiet", `council-quiet:${one.participant}:${one.attempt}`, quietNotice(language, snapshot, one, Math.max(1, Math.floor(since / 60))), { general: false });
      }
      if ((one.view === "running" || one.view === "quiet") && (one.running_seconds ?? 0) > settings.overrunSeconds) {
        await say("overrun", `council-overrun:${one.participant}:${one.attempt}`, overrunNotice(language, snapshot, one, Math.floor((one.running_seconds ?? 0) / 60)), { general: false });
      }
    }
    if (snapshot.checkpoint.reached && !snapshot.legacy) {
      await say("checkpoint", `council-checkpoint:${council.id}:${council.epoch}:${council.extension?.at ?? "none"}`, checkpointNotice(language, snapshot, checkpointMinutes(registry)));
    }
    // A saved correction the checkpoint is holding back: said once per question revision, because the owner is the only one who can move it.
    const parked = (snapshot.waiting?.correction_parked ?? (snapshot.waiting?.kind === "checkpoint" ? snapshot.waiting.members : [])) as string[] | undefined;
    if (snapshot.waiting && parked && parked.length > 0) {
      const held = snapshot.members.filter(one => parked.includes(one.participant));
      await say("checkpoint", `council-correction:${council.id}:${council.question_revision}`,
        correctionWaitingNotice(language, snapshot, (held.length > 0 ? held : snapshot.members).map(one => one.name).join(", "), checkpointMinutes(registry)));
    }
    if (snapshot.master === "interrupted") {
      await say("master_interrupted", `council-master:${council.id}:${await masterAttempt(store, council)}`, masterInterruptedNotice(language, snapshot));
    }
  }
  if (snapshot.waiting?.kind === "legacy_unmerged" && !terminal) {
    await say("legacy_unmerged", `council-legacy:${council.id}`, legacyUnmergedNotice(language, snapshot));
  }
  if (effect && (effect.state === "failed" || effect.state === "missing")) {
    // General's alone, and without a link to the card that did not land.
    await say("status_undelivered", `council-status:${council.id}:${effect.state}`, "", { origin: false, link: null });
  }
}

async function guildOf(registry: Registry, door: string): Promise<string | null> {
  const entry = ((registry.data.run ?? []) as { id: string; guild?: string }[]).find(one => one.id === door);
  return entry?.guild ?? null;
}

/**
 * One council, once. Returns when it next needs looking at (an epoch in milliseconds), or null when
 * nothing needs a timer.
 */
export async function projectCouncil(store: StoreLike, id: string, registry: Registry, clock: () => number): Promise<number | null> {
  const settings = settingsOf(registry);
  await reconcileCouncil(store, id);
  const council = await readCouncil(store, id);
  if (!council) return null;
  const now = new Date(clock());
  const snapshot = await readSnapshot(store, id, { now, quietSeconds: settings.quietSeconds });
  if (!snapshot) return null;
  const language = languageOf(registry, council.person);
  let next: number | null = null;
  const soon = (at: number) => { next = next === null ? at : Math.min(next, at); };

  if (council.origin_kind !== "legacy") {
    const key = stageKey(snapshot);
    const text = statusLine(language, snapshot, now);
    const platform = platformOf(registry, council.return_route.door);
    const effect = await readEffect(store, council.status_effect_key);
    const wanted = renderEffect(council.status_effect_key, text, platform).content;
    if (effect === null || effect.wanted_content !== wanted) {
      const last = council.status_at ? new Date(council.status_at).getTime() : 0;
      const changed = council.status_stage !== key;
      const due = last + (changed ? settings.writeMs : settings.editMs);
      // A chat that is known not to take a line is not asked to take an edit: the words wait, and are written once it can.
      if (!(await chatUsable(store, council.return_route.door, council.return_route.chat))) soon(now.getTime() + settings.editMs);
      else if (now.getTime() >= due) {
        await wantEffect(store, { key: council.status_effect_key, door: council.return_route.door, chat: council.return_route.chat, owner: council.id, text, platform });
        await patchCouncil(store, council.id, { status_stage: key, status_at: now }, { bump: false });
      } else soon(due);
    } else if (council.status_stage !== key) {
      await patchCouncil(store, council.id, { status_stage: key, status_at: now }, { bump: false });
    }
  }
  await attend(store, council, snapshot, registry, language, settings, now);
  if (!TERMINAL_STAGES.includes(snapshot.stage)) soon(now.getTime() + settings.editMs);
  return next;
}

export function startCouncilWatch(options: {
  store: StoreLike;
  door: string;
  registry: () => Registry;
  /** The door's tick, which is how long a failed pass waits before it is made again. */
  tickMs: number;
  /** Takes the door's connect turn. */
  gate: <T>(read: () => Promise<T>) => Promise<T>;
  now?: () => number;
}): CouncilWatch {
  const clock = options.now ?? Date.now;
  let stopping = false;
  let poke: (() => void) | null = null;
  let poked = false;
  const wake = (): void => {
    const waiting = poke;
    poke = null;
    if (waiting) waiting();
    else poked = true;
  };
  const rest = (ms: number | null): Promise<void> => new Promise<void>((resolve) => {
    if (poked) { poked = false; resolve(); return; }
    let timer: ReturnType<typeof setTimeout> | null = null;
    poke = () => { if (timer !== null) clearTimeout(timer); resolve(); };
    if (ms !== null) timer = setTimeout(() => { poke = null; resolve(); }, Math.max(1, ms));
  });
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let failing = false;
  const report = (error: unknown): void => {
    if (!failing) {
      process.stderr.write(finding("en", { code: "council:pass-failed", target: options.door, cause: safeValue((error as Error)?.message ?? error) }) + "\n");
    }
    failing = true;
  };
  const pass = async (ids: string[]): Promise<number | null> => {
    const registry = options.registry();
    let next: number | null = null;
    for (const id of ids) {
      if (stopping) break;
      try {
        const at = await projectCouncil(options.store, id, registry, clock);
        if (at !== null) next = next === null ? at : Math.min(next, at);
      } catch (error) {
        report(error);
        next = clock() + options.tickMs;
      }
    }
    return next;
  };

  const done = (async () => {
    let next: number | null = null;
    let first: string[] | null = null;
    try {
      first = await options.gate(async () => await candidates(options.store, options.door));
    } catch {
      next = clock() + options.tickMs;
    } finally {
      release();
    }
    if (first) next = await pass(first);
    while (!stopping) {
      await rest(next === null ? null : next - clock());
      if (stopping) break;
      try {
        next = await pass(await candidates(options.store, options.door));
        failing = false;
      } catch (error) {
        next = clock() + options.tickMs;
        report(error);
      }
    }
  })();

  return {
    wake,
    ready,
    async stop() {
      stopping = true;
      wake();
      await done;
    },
  };
}
