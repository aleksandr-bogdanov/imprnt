import type { StoreLike } from "../store/connect.ts";
import { appendEntry } from "./diary.ts";

/** The five, in the order a message goes through them. */
export const STAMPS: readonly string[] = [
  "received",
  "acked",
  "started",
  "answered",
  "delivered",
];

/** Who may be named as the writer of a stamp. A model is not machinery. */
export const MACHINERY: readonly string[] = ["door", "runner", "hub"];

export class StampRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StampRefused";
  }
}

export async function stamp(
  store: StoreLike,
  entry: {
    messageId: string;
    kind: string;
    actor: string;
    detail?: Record<string, unknown>;
  },
): Promise<void> {
  if (!STAMPS.includes(entry.kind)) {
    throw new StampRefused(
      `${entry.kind} is not one of the five stamps: ${STAMPS.join(", ")}`,
    );
  }
  if (!MACHINERY.includes(entry.actor)) {
    throw new StampRefused(
      `a stamp is written by machinery, never by the model: ${entry.actor} may not write one`,
    );
  }
  await appendEntry(store, {
    stream: "inbound",
    subject: entry.messageId,
    kind: entry.kind,
    actor: entry.actor,
    detail: entry.detail ?? {},
  });
}
