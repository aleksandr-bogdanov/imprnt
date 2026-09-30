import type { StoreLike } from "../store/connect.ts";

/**
 * Run one OPTIONAL council hook in a savepoint of the transaction the caller owns, and say (on stderr) and
 * return `false` when the hook failed. It imports nothing but a type, so the store's own modules can call a
 * council hook without a cycle.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT. A hook that only derives something from rows that are already
 * committed in the same transaction (a reconcile, a wake) is worth trying and never worth losing the
 * transaction for: it is rolled back alone and the next reconcile (the door runs one on every change) derives
 * the same thing again. Nothing that decides whether work may still run goes through here: a fence that keeps
 * a job from being tried again, and the bookkeeping that ties a council's state to an attempt, are written by
 * their own code as ordinary statements of the transaction they belong to, so that failing to write them fails
 * that transaction and leaves nothing half done (`runner/execution.ts`, `council/feed.ts`, `hooks.ts`).
 *
 * A TRANSACTION IS REQUIRED, AND IT IS ASKED FOR, NOT ASSUMED. The savepoint is a real `SAVEPOINT` statement: outside
 * a transaction the server refuses it, and this throws rather than run the hook unprotected, because a statement
 * that fails inside an unprotected multi-statement hook cannot be told apart from one that left the
 * transaction aborted, and swallowing that error would hand an aborted transaction back to the caller as though
 * nothing had happened. If the rollback to the savepoint itself fails the transaction is unusable and that error
 * is thrown, never swallowed.
 */
let serial = 0;

export async function guarded(store: StoreLike, what: string, run: (inner: StoreLike) => Promise<void>): Promise<boolean> {
  const sql = store.sql as unknown as { unsafe(text: string): Promise<unknown> };
  serial += 1;
  const name = `council_hook_${serial}`;
  try {
    await sql.unsafe(`savepoint ${name}`);
  } catch (error) {
    throw new Error(`a council hook (${what}) runs inside a transaction of its caller, and this is not in one: ${said(error)}`);
  }
  try {
    await run(store);
  } catch (error) {
    // The hook alone is undone. If even that cannot be done the transaction is unusable, and that is the caller's to see.
    await sql.unsafe(`rollback to savepoint ${name}`);
    await sql.unsafe(`release savepoint ${name}`);
    process.stderr.write(`council-hook: ${what}: ${said(error)}\n`);
    return false;
  }
  await sql.unsafe(`release savepoint ${name}`);
  return true;
}

function said(error: unknown): string {
  return String((error as Error)?.message ?? error).split(/[\r\n]/, 1)[0].slice(0, 300);
}
