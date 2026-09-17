import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadRegistry } from "../registry/load.ts";
import { absolute, canonical, digest, toml, version, within, writePrivate } from "./files.ts";

export async function convertV2Registry(manifest: any, platformLookup: (request: { guild: string; token_file: string }) => Promise<{ id: string; name: string }[]>) {
  version(manifest);
  const checkout = manifest.checkout_root ?? resolve(import.meta.dir, "../../../..");
  for (const path of [manifest.candidate, manifest.inventory, manifest.runtime_dir]) {
    absolute(path);
    if (within(path, checkout)) throw new Error("private destination is inside checkout");
    if (canonical(path) === canonical(absolute(manifest.active_registry))) throw new Error("active registry cannot be overwritten");
    for (const root of manifest.fragment_roots) if (within(path, absolute(root))) throw new Error("private destination is inside source");
  }
  if (!manifest.batch_id) throw new Error("cutover batch required");
  const files: { path: string; bytes: string | Uint8Array }[] = [];
  const agents: any[] = [], entries: any[] = [];
  const people = structuredClone(manifest.people);
  const presets = structuredClone(manifest.presets);
  const run: any[] = manifest.run ? structuredClone(manifest.run) : [];
  const machine = manifest.machines[0]?.id;
  const addRun = (entry: any) => { if (!run.some(r => r.id === entry.id)) run.push({ schedule: "always", memory_limit_mb: 512, machine, ...entry }); };
  for (const m of manifest.machines) addRun({ id: `hub-${m.id}`, kind: "hub", machine: m.id });
  const channels = new Map<string, { id: string; name: string }[]>();
  for (const path of manifest.source_registries) {
    const source = JSON.parse(readFileSync(absolute(path), "utf8"));
    if (!Array.isArray(source.agents)) throw new Error("source agents missing");
    const person = people.find((p: any) => p.id === source.person);
    if (!person) throw new Error("source person missing");
    person.language = source.locale;
    person.filing_rules ??= join(absolute(person.vault), "CLAUDE.md");
    const mcp = source.mcp ?? {};
    if (!mcp || typeof mcp !== "object" || Array.isArray(mcp)) throw new Error("invalid MCP servers");
    for (const server of Object.values(mcp) as any[]) {
      if (!server || typeof server !== "object" || (server.command !== undefined && (typeof server.command !== "string" || !Array.isArray(server.args) || !server.args.every((a: any) => typeof a === "string"))) || (server.command === undefined && typeof server.url !== "string")) throw new Error("invalid MCP command");
    }
    for (const legacy of source.agents) {
      const id = legacy.name;
      if (typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id) || agents.some(a => a.id === id)) throw new Error("invalid or duplicate agent");
      const binding = manifest.bindings.find((b: any) => b.agent === id);
      if (!binding) throw new Error("agent binding missing");
      const fragment = absolute(legacy.fragment);
      if (!manifest.fragment_roots.some((root: string) => within(fragment, root))) throw new Error("fragment outside selected roots");
      let bytes: Buffer;
      try { bytes = readFileSync(fragment); } catch { throw new Error(`unreadable fragment: ${fragment}`); }
      if (/^\s*@\S+/m.test(bytes.toString())) throw new Error("unresolved instruction import: select rendered fragment");
      for (const key of ["allow", "deny", "tools"]) if (!Array.isArray(legacy[key]) || !legacy[key].every((v: any) => typeof v === "string" && v !== "")) throw new Error(`invalid permission or tools array: ${key}`);
      let chat = binding.chat;
      const platform = legacy.door?.platform ?? source.door?.platform;
      if (platform === "discord") {
        const key = `${binding.guild}/${binding.token_file}`;
        if (!channels.has(key)) channels.set(key, await platformLookup({ guild: binding.guild, token_file: absolute(binding.token_file) }));
        const found = channels.get(key)!.filter(c => c.name === chat);
        if (found.length !== 1) throw new Error("channel name is absent or ambiguous");
        chat = found[0].id;
      } else if (platform !== "telegram") throw new Error("unsupported channel platform");
      const preset = `import-${id}`;
      presets[preset] = { ...manifest.presets.daily, model: legacy.model, effort: legacy.effort, credential: source.credential };
      const agent = { id, person: person.id, runner: binding.runner, door: binding.door, chat, preset, mode: legacy.mode ?? "resident", tools: legacy.tools,
        fragment: join(manifest.runtime_dir, `${id}.md`), settings: join(manifest.runtime_dir, `${id}.settings.json`), mcp: join(manifest.runtime_dir, `${id}.mcp.json`) };
      files.push({ path: agent.fragment, bytes }, { path: agent.settings, bytes: JSON.stringify({ permissions: { allow: legacy.allow, deny: legacy.deny } }) + "\n" }, { path: agent.mcp, bytes: JSON.stringify({ mcpServers: mcp }) + "\n" });
      agents.push(agent);
      entries.push({ id, fragment_sha256: digest(bytes), tools: agent.tools, settings: agent.settings, mcp: agent.mcp, model: legacy.model, chat, credential: source.credential, vault: person.vault, repositories: manifest.repositories.filter((r: any) => r.person === person.id) });
      addRun({ id: binding.runner, kind: "runner", child_memory_limit_mb: 512, ...manifest.resource_budget });
      addRun({ id: binding.door, kind: "door", person: person.id, platform, token_file: absolute(binding.token_file) });
    }
  }
  if (JSON.stringify(agents.map(a => a.id).sort()) !== JSON.stringify([...manifest.expected_agents].sort())) throw new Error("agent inventory is incomplete");
  for (const repo of manifest.repositories) addRun({ id: `sync-${repo.id}`, kind: "sync", schedule: "hourly", repositories: [repo.id] });
  const selectedCredentials = new Set(Object.values(presets).map((preset: any) => preset.credential));
  const credentials = manifest.credentials.filter((credential: any) => selectedCredentials.has(credential.id) ||
    run.some(entry => entry.kind === "door" && entry.platform === credential.kind && entry.token_file === credential.file));
  const data = { hub: { ...manifest.hub, cutover_batch: manifest.batch_id }, machines: manifest.machines, credentials, people, presets, agents, run, repositories: manifest.repositories };
  for (const file of files) {
    if (within(file.path, checkout) || manifest.fragment_roots.some((root: string) => within(file.path, root))) throw new Error("private destination is inside checkout or source");
  }
  for (const file of files) writePrivate(file.path, file.bytes);
  // Validate before publishing the candidate at its reviewed destination.
  const validation = join(manifest.runtime_dir, `candidate-${crypto.randomUUID()}.toml`);
  const { unlinkSync } = await import("node:fs");
  try { writePrivate(validation, toml(data)); loadRegistry(validation); }
  finally { try { unlinkSync(validation); } catch {} }
  writePrivate(manifest.candidate, toml(data));
  writePrivate(manifest.inventory, JSON.stringify({ agents: entries, sources: manifest.source_registries.map((path: string) => ({ path, sha256: digest(readFileSync(path)) })) }, null, 2) + "\n");
  return { count: agents.length, skipped: 0 };
}
