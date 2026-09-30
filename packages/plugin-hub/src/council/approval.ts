import type { ApprovalHooks } from "../door/confirm.ts";
import type { Registry } from "../registry/load.ts";
import { drift, type Resolved } from "./roster.ts";
import type { Route } from "./rows.ts";
import { startCouncil } from "./start.ts";

/**
 * What an owner's green check on a frozen council proposal does, and what it can never do.
 *
 * A PROPOSAL IS FROZEN WHOLE. The preview the owner reacted to and this payload are the same
 * bytes (the preview's hash covers both), so the roster that starts is the roster they saw:
 * worker, preset, machine, brief, question, context and whether debate was proposed. The hook
 * starts exactly that council, in the same transaction as the approval, and nothing external happens
 * in it: the jobs and the card are rows the runner and the door act on afterwards.
 *
 * WHO APPROVED IS THE ONE THE PROPOSAL WAS PINNED TO. The door only records an approval by the
 * sender the preview named, and only while the registry still allows them. A proposal a WORKER
 * made is pinned to the master and owner of the job that worker is doing, never to the worker,
 * and nothing about that worker's own authorization is inherited by the council: the jobs it starts
 * are approved by this owner, now, for this roster.
 *
 * A worker whose configuration changed between the proposal and this approval is NOT started
 * under its old name and NOT swapped for another: it is recorded as missing with that named cause,
 * and the council waits for the owner. Nothing is selected in its place.
 */

export interface ProposalPayload {
  kind: "council.start";
  person: string;
  master: { agent: string; conversation: string | null };
  route: Route;
  proposer: { kind: "master" | "worker"; agent: string; conversation: string };
  parent_job: string | null;
  question: string;
  context: { text: string }[];
  participants: Resolved[];
  debate: boolean;
  request_key: string;
  at: string;
}

export const COUNCIL_START = "council.start";

export function councilApprovals(options: { registry: () => Registry }): ApprovalHooks {
  return {
    [COUNCIL_START]: async (tx, approval) => {
      const payload = approval.payload as ProposalPayload;
      if (!payload || payload.kind !== COUNCIL_START || !Array.isArray(payload.participants)) {
        throw new Error("a council approval carries the frozen proposal it approves");
      }
      const registry = options.registry();
      const drifted = new Map<number, string>();
      payload.participants.forEach((one, index) => {
        const why = drift(registry, payload.person, [payload.master.agent], one);
        if (why !== null) drifted.set(index, why);
      });
      const at = new Date().toISOString();
      await startCouncil(tx, {
        operation: approval.operation_id,
        person: payload.person,
        master: payload.master,
        route: payload.route,
        origin_kind: "proposal",
        origin: {
          proposer: payload.proposer,
          confirmation: { id: approval.id, revision: approval.revision, hash: approval.payload_hash, approved_by: approval.approved_by, approved_at: approval.approved_at },
          ...(payload.parent_job ? { parent_job: payload.parent_job } : {}),
        },
        parent_job: payload.parent_job,
        question: payload.question,
        context: payload.context,
        participants: payload.participants,
        drifted,
        debate: payload.debate ? { kind: "proposal", confirmation: approval.id, at } : null,
        approvedBy: approval.owner_sender,
        registry,
        actor: "door",
        decision: { conversation: payload.proposer.conversation, request_key: payload.request_key, sources: [], attempt: null },
        at,
      });
    },
  };
}
