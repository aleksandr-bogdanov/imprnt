import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { historyHarvestFrom } from "../registry/entries.ts";
import { ADAPTERS } from "../adapters/index.ts";
import type { Adapter } from "../adapters/types.ts";
import { executeHarvest } from "../harvest/execute.ts";
import { readWatermark } from "../harvest/sheet.ts";
import { readSetting, type Registry } from "../registry/load.ts";
import { openStore, storeUrlAs } from "../store/connect.ts";
import type { EligibleRow } from "../store/wake.ts";
import { historyInventoryPath } from "./chatlog.ts";

export async function catchUpHarvest(registry: Registry, person: string, from: string, until: string, edges?: { adapters: Record<string, Adapter> }) {
  if (!registry.people.some(p => p.id === person) && !registry.agents.some(a => a.person === person)) throw new Error("unknown person");
  if (!Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(until)) || Date.parse(from) > Date.parse(until)) throw new Error("invalid history bounds");
  const exclusion = historyHarvestFrom(registry, person, null);
  if (exclusion && Date.parse(from) <= Date.parse(exclusion)) throw new Error("history bounds include excluded source");
  const stateDir = String(readSetting(registry, "hub.state_dir"));
  const path = historyInventoryPath(stateDir);
  if (from === until) {
    const empty = registry.agents.filter(a => a.person === person).every(agent => {
      const dir = join(stateDir, person, "chatlog", agent.id);
      return !existsSync(dir) || readdirSync(dir).filter(name => name.endsWith(".jsonl")).every(name => readFileSync(join(dir, name), "utf8").trim() === "");
    });
    if (empty) return { slices: [] };
  }
  if (!existsSync(path)) throw new Error("converted source inventory missing");
  const inventory = JSON.parse(readFileSync(path, "utf8"));
  const agents = registry.agents.filter(a => a.person === person && inventory.agents[`${person}/${a.id}`]);
  const bounds = agents.map(a => inventory.agents[`${person}/${a.id}`]);
  if (!agents.length || Date.parse(from) < Math.min(...bounds.map(b => Date.parse(b.from))) ||
      Date.parse(until) > Math.max(...bounds.map(b => Date.parse(b.until)))) throw new Error("history bounds outside source inventory");
  const store = await openStore({ url: storeUrlAs(String(readSetting(registry, "hub.store_url")), "hub_runner") });
  const slices: { from: string; until: string; lines: number }[] = [];
  try {
    for (const agent of agents) {
      const lock = await store.sql.reserve();
      try {
        const [held] = await lock`select pg_try_advisory_lock(hashtext(${`catchup:${person}/${agent.id}`})) as held`;
        if (!held.held) throw new Error("historical harvest already running");
        let mark = await readWatermark(store, { person, agent: agent.id });
        let lower = mark && mark.at > from ? mark.at : from;
        while (lower < until || (!mark && lower === until)) {
          const day = new Date(lower); day.setUTCHours(24, 0, 0, 0);
          const upper = new Date(Math.min(day.getTime() - 1, Date.parse(until))).toISOString();
          // Inclusive daily endpoints keep equal timestamps in one slice.
          const end = upper <= lower ? new Date(Math.min(day.getTime() + 86400000 - 1, Date.parse(until))).toISOString() : upper;
          const offline = { from: lower, includeFrom: !mark && lower === from, lines: 0 };
          const id = `catchup:${person}:${agent.id}:${end}`;
          await executeHarvest({ store, registry, agent, runner: agent.runner, stateDir, adapters: edges?.adapters ?? ADAPTERS, offline,
            row: { id, person, agent: agent.id, kind: "harvest", body: JSON.stringify({ from: lower, until: end, reason: "backstop", lines: 0 }) } as EligibleRow });
          slices.push({ from: lower, until: end, lines: offline.lines });
          mark = await readWatermark(store, { person, agent: agent.id });
          if (!mark || mark.at < end) throw new Error("harvest incomplete");
          lower = end;
          if (lower === until) break;
        }
      } finally { await lock`select pg_advisory_unlock_all()`; lock.release(); }
    }
  } finally { await store.close(); }
  return { slices };
}
