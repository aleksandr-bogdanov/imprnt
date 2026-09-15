/**
 * What every entry point does after its handle is up: stay alive until the
 * service manager asks it to stop, then stop the handle and leave.
 *
 * One copy, because three entry points doing it three ways is three chances for
 * one of them to leave a child behind on a shutdown.
 */
export function usage(kind: string): never {
  process.stderr.write(`usage: bun run src/entry/${kind}.ts <registryFile> <entry id>\n`);
  process.exit(2);
}

export async function hold(handle: { stop(): Promise<void> }): Promise<void> {
  const leave = async () => {
    try {
      await handle.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGTERM", leave);
  process.on("SIGINT", leave);
  await new Promise<void>(() => {});
}
