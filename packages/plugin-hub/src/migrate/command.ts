import { isAbsolute } from "node:path";
import { readManifest } from "./files.ts";
import { finding, migrationUsage, safeValue, type MigrationScript } from "../door/lines.ts";

export async function migrationCommand(script: MigrationScript, run: (manifest: any) => Promise<string>) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !isAbsolute(args[0])) { process.stderr.write(migrationUsage("en", script) + "\n"); return 2; }
  try { console.log(await run(readManifest(args[0]))); return 0; }
  catch (error) { console.error(finding("en", { code: "migration-refused", target: "manifest", cause: safeValue((error as Error).message) })); return 1; }
}
