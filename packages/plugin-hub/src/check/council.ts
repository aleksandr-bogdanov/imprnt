import { generalOf } from "../council/general.ts";
import type { Registry } from "../registry/load.ts";
import type { StoreLike } from "../store/connect.ts";
import { findingId, type Finding } from "./finding.ts";

/**
 * What `check` says about councils that are live: one that has waited for its owner or its master past the
 * household's grace, one whose card cannot be shown, and a person who has councils and no General to hear
 * about them in. Each is one finding per council (or per person) and not per participant, the way the door says
 * a thing once. Nothing here says a worker failed for being slow or quiet: a running worker is not a finding.
 */
export interface LiveCouncil {
  id: string;
  person: string;
  agent: string;
  lifecycle: string;
  origin_kind: string;
  updated_at: Date;
  waiting: { kind?: string } | null;
  /** The state of the council's card in the ledger, or null when it has none. */
  card: string | null;
  /**
   * For a council that is preparing its result: the state of the master's attempt that called finalize (`completed` is the attempt whose reply was settled),
   * or null when that attempt is not on record. Absent for a council that is not preparing one.
   */
  finalize_attempt?: string | null;
}

export async function readLiveCouncils(store: StoreLike): Promise<LiveCouncil[]> {
  return (await store.sql`select c.id, c.person, c.agent, c.lifecycle, c.origin_kind, c.updated_at, c.waiting,
      (select e.state from platform_effect e where e.key = c.status_effect_key) as card,
      case when c.lifecycle = 'preparing_result' then (select x.state from execution x where x.id = c.finalize ->> 'attempt') end as finalize_attempt
    from council c where c.lifecycle not in ('complete', 'stopped') order by c.created_at, c.id`) as unknown as LiveCouncil[];
}

export function councilFindings(args: {
  councils: LiveCouncil[];
  registry: Registry;
  /** The agents this machine runs, by id. */
  agents: Set<string>;
  graceSeconds: number;
  machine: string;
  now: Date;
}): Finding[] {
  const out: Finding[] = [];
  const noGeneral = new Set<string>();
  for (const council of args.councils) {
    if (!args.agents.has(council.agent)) continue;
    const waited = Math.floor((args.now.getTime() - new Date(council.updated_at).getTime()) / 1000);
    if (council.lifecycle === "waiting_owner" && waited > args.graceSeconds) {
      out.push({
        id: findingId(args.machine, "council-waiting-owner", council.id), kind: "council-waiting-owner", subject: council.id, machine: args.machine,
        says: `${council.id} of ${council.agent} has waited ${waited} seconds for its owner${council.waiting?.kind ? ` (${council.waiting.kind})` : ""}, and nothing is rerun, replaced or left out until they choose`,
        fix: `ask ${council.person} what to do about it in the chat of ${council.agent}, or read the council with hub_council inspect`,
      });
    }
    if ((council.lifecycle === "waiting_master" || council.lifecycle === "assessing") && waited > args.graceSeconds) {
      out.push({
        id: findingId(args.machine, "council-waiting-master", council.id), kind: "council-waiting-master", subject: council.id, machine: args.machine,
        says: `${council.id} has had every answer it needs for ${waited} seconds and its master ${council.agent} has not finalized it or chosen a next step`,
        fix: `read the master's chat and the runner log for ${council.agent}; an interrupted turn is held for its owner (see the hold findings)`,
      });
    }
    // A council that is preparing its result is waiting for ONE thing: the reply of the master attempt that called finalize, settled together with the
    // council's result (`council/hooks.ts`, `afterMasterSettle`, part of that settlement). Two states of it are persistent and are said, not left to look like
    // a card that lags: the attempt was settled and the council still says it is preparing (a result that was never recorded), and the attempt ended (failed,
    // interrupted, stopped or gone) with nothing settled, for longer than the household's grace.
    if (council.lifecycle === "preparing_result") {
      const state = council.finalize_attempt ?? null;
      const settled = state === "completed";
      const ended = state === null || state === "failed" || state === "interrupted" || state === "stopped";
      if (settled || (ended && waited > args.graceSeconds)) {
        out.push({
          id: findingId(args.machine, "council-finalizing", council.id), kind: "council-finalizing", subject: council.id, machine: args.machine,
          says: settled
            ? `${council.id} is still preparing its result although the attempt of ${council.agent} that was to write it was settled: the result was not recorded, and no reply is owed by anybody`
            : `${council.id} has been preparing its result for ${waited} seconds and the attempt of ${council.agent} that called finalize ended (${state ?? "not on record"}) with nothing settled`,
          fix: settled
            ? `this state is not one this build writes (its settle records the result with the reply, or does not settle); read the master's chat for the reply, stop the council with hub_council stop and start another with the owner's participants`
            : `ask ${council.agent} to call finalize again from a turn of its own (hub_council continue, kind finalize) or, when the owner no longer wants it, stop the council`,
        });
      }
    }
    if (council.card === "failed" || council.card === "missing" || council.card === "unknown") {
      out.push({
        id: findingId(args.machine, "council-card", council.id), kind: "council-card", subject: council.id, machine: args.machine,
        says: `the status message of ${council.id} is ${council.card} in its chat, so its progress cannot be shown there`,
        fix: `read the door log for the chat of ${council.agent}; a message the platform refused is not made again by itself`,
      });
    }
    if (council.origin_kind !== "legacy" && !noGeneral.has(council.person) && "issue" in generalOf(args.registry, council.person)) {
      noGeneral.add(council.person);
      out.push({
        id: findingId(args.machine, "council-no-general", council.person), kind: "council-no-general", subject: council.person, machine: args.machine,
        says: `${council.person} has a live council and no usable General chat, so what needs them is said in the council's own chat only`,
        fix: `set the person's general to the id of the agent whose chat is their General, in the registry`,
      });
    }
  }
  return out;
}
