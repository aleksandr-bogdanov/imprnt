import type { SQL, ReservedSQL } from "bun";

/**
 * Keep a connection reserved until its answer has been consumed. In particular,
 * a pooled statement must never be queued into another caller's transaction.
 * A protocol failure or an already-aborted transaction resets that backend;
 * the failed operation is always returned to its caller, never replayed here.
 *
 * Hub uses the SQL tag, unsafe, begin and reserve. The facade deliberately
 * returns promises for statements, rather than Bun's lazy query builders.
 */
export function managedSQL(pool: SQL): SQL {
  function protect(connection: ReservedSQL): ReservedSQL {
    let discarded = false;
    let released = false;
    const guard = async (run: () => unknown): Promise<unknown> => {
      try { return await run(); }
      catch (error) {
        const failure = error as { code?: string; errno?: string };
        const code = failure?.errno ?? failure?.code;
        if (code === "25P02" || code === "08P01") {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            // On this SAME reserved connection. Sending ROLLBACK through the
            // pool could clean an innocent backend and leave this one poisoned.
            await Promise.race([
              connection.unsafe("ROLLBACK"),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("store rollback timed out")), 5000);
              }),
            ]);
          } catch {
            discarded = true;
            await connection.close({ timeout: 0 }).catch(() => {});
          } finally { clearTimeout(timer); }
        }
        throw error;
      }
    };
    return new Proxy(connection, {
      apply(target, _this, args) { return guard(() => Reflect.apply(target, target, args)); },
      get(target, key) {
        if (key === "release") return () => {
          if (discarded || released) return;
          released = true;
          // Bun types release as void but returns a rejected promise if the
          // backend disconnected. The operation already carries that failure.
          Promise.resolve(target.release()).catch(() => {});
        };
        const value = Reflect.get(target, key, target);
        if (key === "unsafe" || key === "begin") {
          return (...args: unknown[]) => guard(() => Reflect.apply(value, target, args));
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  const reserve = async () => protect(await pool.reserve());
  const using = async (run: (connection: ReservedSQL) => PromiseLike<unknown>) => {
    const connection = await reserve();
    try { return await run(connection); }
    finally { connection.release(); }
  };
  return new Proxy(pool, {
    apply(_target, _this, args) { return using(connection => Reflect.apply(connection, connection, args)); },
    get(target, key) {
      if (key === "reserve") return reserve;
      if (key === "unsafe") {
        return (...args: unknown[]) => using(connection => Reflect.apply(connection[key], connection, args));
      }
      // Pool begin owns its reservation and rollback; keep Bun's transaction
      // callback/array semantics intact rather than nesting a reservation.
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
