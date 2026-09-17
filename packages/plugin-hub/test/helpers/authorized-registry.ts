import { readFileSync, writeFileSync } from "node:fs";
import { stageHub as stage, type StageOptions } from "./hub-fixture.ts";
import { writeRegistry as write, type RegistrySpec } from "./registry.ts";
import type { Cluster } from "./cluster.ts";

// These positive door fixtures send the fake platform's stable identity.
export function authorizeFixture(file: string): string {
  let text = readFileSync(file, "utf8");
  const parsed = Bun.TOML.parse(text) as { agents?: { person: string; door: string }[]; people?: { id: string }[] };
  for (const person of new Set(parsed.agents?.map(a => a.person))) {
    const doors = [...new Set(parsed.agents!.filter(a => a.person === person).map(a => a.door))];
    const line = `allowed_senders = { ${doors.map(d => `${JSON.stringify(d)} = ["fixture-sender"]`).join(", ")} }\n`;
    if (!parsed.people?.some(p => p.id === person)) text += `\n[[people]]\nid = ${JSON.stringify(person)}\n${line}`;
    else text = text.replace(/\[\[people\]\][\s\S]*?(?=\n\[|$)/g, block => {
      if (!new RegExp(`^id = ${JSON.stringify(person)}$`, "m").test(block) || /allowed_senders\s*=/.test(block)) return block;
      return block.replace("[[people]]\n", `[[people]]\n${line}`);
    });
  }
  writeFileSync(file, text);
  return file;
}
export function writeRegistry(dir: string, spec: RegistrySpec): string {
  return authorizeFixture(write(dir, spec));
}
export async function stageHub(cluster: Cluster, options: StageOptions = {}) {
  const it = await stage(cluster, options);
  authorizeFixture(it.registryFile);
  return it;
}
