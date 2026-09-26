import { toml } from "../migrate/files.ts";
import { rewriteRegistry, type RegistryEditResult } from "./edit.ts";

/**
 * Put a registry into the layout the editor works on: one `[[table]]` header
 * per entry.
 *
 * The loader reads a table written as one inline array on a single line, and
 * the editor cannot: `setKey`, `appendEntry` and `removeEntry` find an entry by
 * its own header line, so on such a file every adopt, retire and board press
 * is refused. The rewrite goes through the editor's own lock, load and
 * structure diff, so what comes out says exactly what went in, and a file that
 * is already in this layout is left untouched.
 */
export async function relayoutRegistry(file: string): Promise<RegistryEditResult> {
  return await rewriteRegistry(file, data => toml(data));
}
