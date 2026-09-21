import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { adapterFor, loopLaunch } from "../adapters/index.ts";
import type { Adapter, AdapterSession, TurnEnd } from "../adapters/types.ts";
import { credentialSource } from "../adapters/launch.ts";
import { boxContextFor } from "../box/index.ts";
import { applyNote, stageDirFor, stageNotes } from "./apply.ts";
import { parseHarvestReply } from "./parse.ts";
import { harvestMessage } from "./prompt.ts";
import { decodeHarvestBody, type HarvestBody } from "./row.ts";
import { readWatermark, watermarkRow } from "./sheet.ts";
import { readSlice } from "./slice.ts";
import { deriveSlice } from "../chatlog/derive.ts";
import { harvestNothing, harvestReport, type Language } from "../door/lines.ts";
import { chatStateFor, historyHarvestFrom, harvestFor, languageOf, filingRulesFor, noticeRoute } from "../registry/entries.ts";
import { readSetting, type Registry, type AgentEntry } from "../registry/load.ts";
import { credentialOfPreset, getPreset, presetId, priceFor, type Preset } from "../registry/presets.ts";
import type { StoreLike } from "../store/connect.ts";
import type { EligibleRow } from "../store/wake.ts";
import { appendNotice } from "../store/outbox.ts";
import { refuseTurn, settleHarvest, type HarvestRecord, type TurnRecord } from "../runner/settle.ts";
import { recordWindow } from "../runner/outage.ts";

async function launchFor(registry: Registry, agent: AgentEntry, presetName: string, purpose: "ordinary" | "harvest") {
  const stateDir = String(readSetting(registry, "hub.state_dir") ?? "");
  const credential = credentialOfPreset(registry, presetName);
  return loopLaunch({ registry, agent, preset: getPreset(registry, presetName), purpose,
    ...(credential ? { credential: credentialSource(registry, presetName) } : {}),
    sessionDir: join(stateDir, agent.person, "sessions", agent.id, crypto.randomUUID()),
    box: boxContextFor(registry, agent.id),
  });
}

function failedSession(session: AdapterSession): Promise<never> {
  return session.exited ? session.exited.then(() => { throw new Error("harvest child exited"); }) : new Promise(() => {});
}

export async function executeHarvest(args: {
  store: StoreLike; registry: Registry; agent: AgentEntry; row: EligibleRow;
  runner: string; stateDir: string; adapters: Record<string, Adapter>;
  stopped?: Promise<"stopped">;
  opened?: (session: AdapterSession) => void;
  closed?: (session: AdapterSession) => void;
  offline?: { from: string; includeFrom: boolean; lines: number };
}): Promise<void> {
  const { store, registry, agent, row, runner, stateDir, adapters, opened, closed, offline } = args;
  const stopped = args.stopped ?? new Promise<"stopped">(() => {});
  const staged = stageDirFor(stateDir, agent.person, row.id);
  const settings = harvestFor(registry, agent.person);
  const every = Number(readSetting(registry, "runner.task_retry_seconds"));
  /**
   * Every way a harvest ends badly, in one place.
   *
   * The row goes back on its own recorded retry with a diary line that says
   * `refused.harvest` and not `refused.outage`, so a household reading its
   * own diary can tell a dead login from a note the vault would not take,
   * and no outage is opened and no notice is written: the outage line says
   * "Messages are waiting and nothing is lost", and that sentence is false
   * when what is waiting is proactive work nobody asked for.
   */
  const refuse = async (said: string): Promise<void> => {
    if (offline) throw new Error(`harvest refused: ${said}`);
    await refuseTurn(store, {
      inboundId: row.id,
      runner,
      agent: agent.id,
      cause: "other",
      said,
      retryAt: new Date(Date.now() + every * 1000).toISOString(),
      kind: "refused.harvest",
    });
  };
  let body: HarvestBody;
  try {
    body = decodeHarvestBody(row.body);
  } catch (error) {
    // A body no reader can decode is a row the door did not write, so there
    // is nothing here to harvest and nothing to guess at. It is REFUSED
    // rather than thrown: a throw out of this function ends the whole
    // serving loop for this agent, and a person whose messages stopped
    // being answered because of a row nobody sent is the silence this phase
    // exists to close. `check`'s `harvest-stale` is the household-facing
    // half when it never clears.
    await refuse(`this harvest row's body is not readable: ${(error as Error).message}`);
    return;
  }

  /** The parts of the record that are true whatever the turn did. */
  const recordOf = (
    preset: Preset,
    what: {
      harvest: HarvestRecord;
      end?: TurnEnd;
      lacks?: readonly string[];
    },
  ): TurnRecord => ({
    agent: agent.id,
    runner,
    preset: settings?.harvester ?? agent.preset,
    preset_id: presetId(preset),
    preset_settings: { ...preset },
    input_tokens: what.end?.usage.input_tokens ?? null,
    cached_input_tokens: what.end?.usage.cached_input_tokens ?? null,
    output_tokens: what.end?.usage.output_tokens ?? null,
    price: what.end
      ? priceFor(registry, {
          model: preset.model,
          at: new Date(),
          paid: preset.paid,
          usage: what.end.usage,
        })
      : null,
    plan_usage: what.end?.usage.plan_usage ?? null,
    raw_usage: what.end?.usage.raw ?? {},
    resolved_model_ids: what.end?.usage.resolved_model_ids ?? [],
    primary_model_id: what.end?.usage.primary_model_id ?? null,
    session_id: what.end?.session_id ?? null,
    lacks: [...(what.lacks ?? []), ...(what.end?.usage.resolved_model_ids?.length ? [] : ["resolved_model"])],
    tail: false,
    harvest: what.harvest,
  });

  // This person's chats are not harvested any more, and a row
  // written before the setting was taken out would otherwise sit there for
  // ever. It is settled with nothing harvested rather than refused: there
  // is nothing to retry.
  if (settings === null) {
    await settleHarvest(store, {
      inboundId: row.id,
      turn: recordOf(getPreset(registry, agent.preset), {
        harvest: {
          from: body.from,
          until: body.until,
          reason: body.reason,
          lines: 0,
          notes: [],
          conflicts: [],
          staged,
        },
      }),
      watermark: null,
    });
    return;
  }

  // A VAULT ROOT THAT IS NOT ON THIS MACHINE REFUSES BEFORE ANY
  // SESSION STARTS. `boxFor`'s own shape for a tree that is not here is
  // `cwd: undefined`, and copying it would start a loop with no cwd, have
  // it read nothing, and then die on the CLI's `no vault at <dir>` after
  // the household had already paid for a model turn. Zero model cost, and
  // the row comes back when the disk does.
  if (!existsSync(settings.vault)) {
    await refuse(`no vault at ${settings.vault} on this machine`);
    return;
  }

  const harvester = getPreset(registry, settings.harvester);
  const language = languageOf(registry, agent.person) as Language;
  /**
   * Whether a line is owed for this harvest at all.
   *
   * A demand ALWAYS answers, whatever the setting says, and that is the
   * ruling's own sentence: a person who typed a phrase at the machinery and
   * got silence has no way to tell it worked from a hub that is broken.
   */
  const owed = !offline && (settings.report || body.reason === "demand");
  const say = async (said: string): Promise<void> => {
    await appendNotice(store, {
      person: agent.person,
      agent: agent.id,
      body: said,
      noticeKey: `harvest:${row.id}`,
      ...noticeRoute(registry, agent.id),
      ...(row.source ? { route: { door: row.source.door, chat: row.source.chat } } : {}),
    });
  };

  // THE SLICE IS COMPUTED FROM THE SHEET AND NEVER FROM THE ROW'S
  // OWN `from`: the row records what the door believed when it wrote it and
  // the sheet is what a runner has really settled. That is what makes "a
  // slice harvested twice" impossible by arithmetic rather than by a lock:
  // one agent has one runner and one open turn, so two rows for one chat
  // run one after the other and the second computes its slice after the
  // first advanced the watermark.
  const watermark = await readWatermark(store, {
    person: agent.person,
    agent: agent.id,
  });
  const exclusion = historyHarvestFrom(registry, agent.person, null);
  const lower = [watermark?.at, offline?.from, exclusion].filter((v): v is string => typeof v === "string").sort().at(-1) ?? null;
  const slice = {
    person: agent.person,
    agent: agent.id,
    from: lower,
    until: body.until,
    includeFrom: Boolean(offline?.includeFrom && lower === offline.from && !watermark && !exclusion),
  };
  // The bound is the same arithmetic either way. Which reader answers it is the
  // registry's: the file this machine's door wrote, or the store when the door
  // that wrote it is on another machine.
  const lines = chatStateFor(registry, agent.id) === "store"
    ? await deriveSlice(store, { registry, ...slice })
    : await readSlice({ stateDir, ...slice });
  if (offline) offline.lines = lines.length;
  const base = {
    from: lower,
    until: body.until,
    reason: body.reason,
    lines: lines.length,
    staged,
  };

  // An empty slice costs NO MODEL TURN: no session, no message, and
  // no watermark, because nothing was harvested. It still writes its `turn`
  // line, or criterion 2's query is vacuously true for the case it exists
  // to cover.
  if (lines.length === 0) {
    // A DEMAND STILL ANSWERS HERE, and this branch must never return in
    // silence. It is reachable in ordinary use rather
    // than in an edge case: `readSlice` drops every line that IS the
    // phrase, so typing it, letting it file and typing it again with
    // nothing said in between leaves a slice that is empty by
    // construction, and the first demand in a chat whose only other lines
    // are the door's own machinery is the same shape.
    if (body.reason === "demand") await say(harvestNothing(language));
    await settleHarvest(store, {
      inboundId: row.id,
      turn: recordOf(harvester, {
        harvest: { ...base, notes: [], conflicts: [] },
      }),
      watermark: offline ? watermarkRow({ person: agent.person, agent: agent.id, at: body.until, row: row.id, harvestedAt: new Date().toISOString(), notes: 0, lines: 0 }) : null,
    });
    return;
  }

  const last = lines[lines.length - 1];
  const rulesPath = filingRulesFor(registry, agent.person);
  const filingRules = rulesPath ? readFileSync(rulesPath, "utf8") : "";
  const launch = await launchFor(registry, agent, settings.harvester, "harvest");
  const session = await adapterFor(adapters, harvester.adapter).start({
    ...launch, preset: harvester, sessionId: null,
  });
  opened?.(session);
  let end: TurnEnd | "stopped";
  try {
    let finish: (ending: TurnEnd) => void = () => {};
    const ended = new Promise<TurnEnd>((resolve) => {
      finish = resolve;
    });
    // The ONLY handler. A harvest writes no stamp between `received` and
    // `answered`, so there is nothing for a receipt or a progress event to
    // do.
    session.onTurnEnd((ending) => finish(ending));
    await Promise.race([session.feed({
      id: row.id,
      text: harvestMessage({ language, lines, filingRules, vault: settings.vault }),
    }), stopped, failedSession(session)]);
    end = await Promise.race([ended, stopped, failedSession(session)]);
  } finally {
    closed?.(session);
    await session.close().catch(() => {});
  }
  if (end === "stopped") return;

  // A harvest turn DOES record the window it reported, under the
  // HARVESTER's own credential, because on the common household the
  // harvester and the agents share one plan login and that is how the
  // household learns its allowance moved. It writes no window NOTICE, for
  // the same reason it opens no outage: the notice says "Messages are
  // waiting and nothing is lost", and that sentence is false when what is
  // waiting is proactive work nobody asked for.
  const reading = end.usage.window ?? null;
  if (reading) {
    await recordWindow(store, {
      credential:
        credentialOfPreset(registry, settings.harvester) ??
        `preset:${settings.harvester}`,
      utilization: reading.utilization,
      resetsAt: reading.resets_at,
      runner,
    });
  }

  // A refused harvest turn opens NO outage and writes NO notice.
  if (end.refused) {
    await refuse(end.refused.said);
    return;
  }

  const reply = parseHarvestReply(end.text);
  if (reply.kind === "unreadable") {
    await refuse(reply.said);
    return;
  }

  const notes: string[] = [];
  const conflicts: string[] = [];
  if (reply.kind === "notes") {
    const files = await stageNotes({
      stateDir,
      person: agent.person,
      rowId: row.id,
      notes: reply.notes,
    });
    // IN ORDER, and a refusal stops the row here: the notes before it are
    // on disk, the watermark does not move, and the staging directory is
    // left for a human to read. L19: "a crash means a re-run, never a lost
    // fact."
    for (const file of files) {
      const result = await applyNote({
        imprnt: String(readSetting(registry, "hub.imprnt") ?? "imprnt"),
        vault: settings.vault,
        file,
      });
      if (result.outcome === "refused") {
        await refuse(result.said);
        return;
      }
      // A conflict COUNTS AS LANDED: the vault's own contradiction
      // workflow recorded it in `_needs-review.md`, nothing about the slice
      // is lost, and re-running the model on the same slice produces the
      // same conflict for ever, so a watermark that stood still would
      // harvest that chat every quiet period until a human intervened.
      // ONLY A PATH THE CLI REALLY NAMED. `classifyApply`
      // answers `note: ""` whenever a marker line carries no token at its
      // own skip index, and an empty entry joined into the report line
      // renders `[door] saved. Notes: .`, a sentence about nothing. It
      // would go into the turn record as an empty string too, which is a
      // note nobody can look up.
      if (result.note === "") continue;
      // A conflict COUNTS AS LANDED: the vault's own contradiction
      // workflow recorded it in `_needs-review.md`, nothing about the slice
      // is lost, and re-running the model on the same slice produces the
      // same conflict for ever, so a watermark that stood still would
      // harvest that chat every quiet period until a human intervened.
      if (result.outcome === "conflict") conflicts.push(result.note);
      else notes.push(result.note);
    }
  }

  // The line back, written BEFORE the settle, so a person reads it
  // and then the next answers. It is keyed on the harvest ROW, so a second
  // attempt at one harvest meets its own key and a second harvest of the
  // same chat gets its own line.
  if (owed) {
    const said =
      notes.length > 0 || conflicts.length > 0
        ? harvestReport(language, { notes, conflicts })
        : body.reason === "demand"
          ? harvestNothing(language)
          : null;
    if (said !== null) await say(said);
  }

  // The watermark is the LAST HARVESTED LINE's own time and
  // never the row's `until`, and it lands with the settle or not at all.
  await settleHarvest(store, {
    inboundId: row.id,
    turn: recordOf(harvester, {
      harvest: { ...base, notes, conflicts },
      end,
      lacks: session.lacks,
    }),
    watermark: watermarkRow({
      person: agent.person,
      agent: agent.id,
      at: offline ? body.until : last.at,
      row: row.id,
      harvestedAt: new Date().toISOString(),
      notes: notes.length,
      lines: lines.length,
    }),
  });
}
