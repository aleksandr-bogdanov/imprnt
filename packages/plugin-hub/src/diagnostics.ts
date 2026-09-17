import { appendEntry } from "./records/diary.ts";
import type { StoreLike } from "./store/connect.ts";
import { finding, safeValue } from "./door/lines.ts";

export async function recordOperationFailure(store: StoreLike, args: { operation: string; target: string; error: unknown; actor?: "hub" | "runner" | "door" }) {
  const error = args.error as { code?: string; message?: string } | null;
  const detail = { operation: args.operation, target: safeValue(args.target), code: safeValue(error?.code ?? "operation-failed"),
    cause: safeValue(error?.message ?? String(args.error)), at: new Date().toISOString() };
  const actor = args.actor ?? "hub";
  await appendEntry(store, { stream: actor === "hub" ? "machine" : actor === "runner" ? "runner" : "operation",
    subject: detail.target, kind: "failed", actor, detail });
  process.stderr.write(finding("en", { code: `${detail.operation}:${detail.code}`, target: detail.target, cause: detail.cause }) + "\n");
}
