// The crossing, in a process of its own, for `test/store-crossing.test.ts`.
//
// The switch that turns Bun's pipelining off is read once, when a process
// starts, so the check that the crossing still happens WITHOUT it cannot run in
// the suite's own process, which the package's test script starts with it. The
// check starts this file with the variable taken out of its environment.
//
// Argv: <observer url> <store url> <application> <claim id> <prepared: yes|no>.
// Prints one JSON line and exits. It exits rather than closing politely,
// because a client that crossed still holds a statement nobody will answer.

import { SQL } from "bun";
import { burstOnOneConnection } from "./crossing.ts";

const [url, storeUrl, application, claimId, prepared] = process.argv.slice(2);
const observer = new SQL(url, { max: 1 });
try {
  const result = await burstOnOneConnection({ storeUrl, url, observer, application, claimId, prepared: prepared === "yes" });
  process.stdout.write(
    JSON.stringify({
      bun: Bun.version,
      switch: process.env.BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING ?? null,
      result,
    }) + "\n",
  );
  process.exit(0);
} catch (error) {
  process.stdout.write(JSON.stringify({ error: String((error as Error).stack ?? error) }) + "\n");
  process.exit(1);
}
