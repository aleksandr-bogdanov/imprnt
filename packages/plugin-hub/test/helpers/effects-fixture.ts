// Test infrastructure: a database, a fake Discord and the store roles, staged for the
// effect ledger and the confirmation poll.
//
// The store, the door's own delivery code and the real `discord()` seam are the real
// thing; only the network behind the seam is the fake (`fake-discord-rest.ts`), and
// the disposable Postgres is the cluster's. A "restart" is a new door context over the
// same database and the same fake, so everything a process held in memory is gone by
// construction. "Time" is the fake Discord's clock, and every retry the code writes
// and every snowflake the fake mints are read off it, so no check sleeps.
//
// CONNECTIONS ARE COUNTED. The cluster allows forty, so a stage keeps one connection
// per role and a check that needs a second "process" asks for a fresh one, and
// `closeStages` (run after every check) closes them all.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { storeUrlAs, type StoreLike } from "../../src/store/connect.ts";
import { discord } from "../../src/door/platforms/discord.ts";
import type { Platform } from "../../src/door/platform.ts";
import type { EffectsContext, EffectsGate } from "../../src/door/effects.ts";
import { readEffectWork, runEffectWork } from "../../src/door/effects.ts";
import type { ApprovalHooks, ConfirmContext } from "../../src/door/confirm.ts";
import { loadRegistry } from "../../src/registry/load.ts";
import { writeRegistry } from "./authorized-registry.ts";
import { freshDatabase, type Cluster } from "./cluster.ts";
import { createFakeDiscord, type FakeDiscord, type FakeDiscordOptions } from "./fake-discord-rest.ts";

export const DOOR = "door-fake";
export const PERSON = "p1";
/** The owner's platform id, and the only sender the registry below allows. */
export const OWNER = "100000000000000001";

export type Role = "hub_door" | "hub_runner" | "hub_hub" | "hub_agent";

const stages: EffectsStage[] = [];
const dirs: string[] = [];

/** Closes every connection the stages of the check that just ran opened. */
export async function closeStages(): Promise<void> {
  for (const stage of stages.splice(0)) await stage.close();
}

/** The scratch directories, removed once the file is done. */
export function removeEffectDirs(): void {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

export interface EffectsStage {
  db: string;
  cluster: Cluster;
  /** The superuser, to read and to plant. */
  admin: SQL;
  fake: FakeDiscord;
  channel: string;
  tokenFile: string;
  /** This stage's connection as one role. */
  as(role: Role): StoreLike;
  /** A connection of its own as one role: another "process". */
  fresh(role: Role): StoreLike;
  /** The real Discord seam over the fake, with an optional look at every request before it is handled. */
  platform(look?: (method: string, url: URL, body: Record<string, unknown> | null) => Promise<void> | void): Platform;
  /** A door context. It shares the stage's door connection unless given a store. */
  context(options?: Partial<ConfirmContext>): ConfirmContext;
  /** A registry the loader really loaded, in which the person allows exactly these senders on the door. */
  registry(senders: string[]): unknown;
  gate(): EffectsGate;
  close(): Promise<void>;
}

export async function stageEffects(cluster: Cluster, options: FakeDiscordOptions & { registry?: () => unknown } = {}): Promise<EffectsStage> {
  const db = await freshDatabase(cluster);
  const dir = mkdtempSync(join(tmpdir(), "hub-effects-"));
  dirs.push(dir);
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "placeholder-token\n", "utf8");
  const { registry: given, ...fakeOptions } = options;
  // The fake's clock starts at the real one, so the database's own timestamps and the fake's snowflakes agree.
  const fake = createFakeDiscord({ start: Date.now(), ...fakeOptions });
  const channel = fake.addChannel({ name: "status" });
  const loadFor = (senders: string[]): unknown => {
    const file = writeRegistry(dir, {
      hub: { state_dir: dir },
      people: [{ id: PERSON, allowed_senders: { [DOOR]: senders } } as never],
      presets: { daily: { adapter: "synthetic", model: "m", provider: "p", effort: "medium", paid: "plan" } },
      agents: [{ id: "p1-lair", person: PERSON, preset: "daily", chat: "1000000001", door: DOOR, runner: "runner-test" }],
    });
    return loadRegistry(file);
  };
  const standing = loadFor([OWNER]);
  const registry = given ?? (() => standing);
  const opened: SQL[] = [];
  const cached = new Map<Role, StoreLike>();
  const admin = cluster.connect(db);
  opened.push(admin);

  const make = (role: Role): StoreLike => {
    const sql = cluster.connectAs(role, db);
    opened.push(sql);
    return { sql, url: storeUrlAs(cluster.url(db), role) };
  };

  const stage: EffectsStage = {
    db,
    cluster,
    admin,
    fake,
    channel,
    tokenFile,
    as(role) {
      if (!cached.has(role)) cached.set(role, make(role));
      return cached.get(role)!;
    },
    fresh: make,
    platform(look) {
      const seen: typeof fetch = (async (input: unknown, init?: RequestInit) => {
        if (look) {
          await look(String(init?.method ?? "GET").toUpperCase(), new URL(String(input)), typeof init?.body === "string" ? JSON.parse(init.body) : null);
        }
        return await fake.fetch(input as string, init);
      }) as unknown as typeof fetch;
      // Its rate-limit waits are counted on the fake's clock, like every retry the door writes.
      return discord({ tokenFile, guild: fake.guild, fetch: seen, now: fake.now });
    },
    context(overrides = {}) {
      return {
        store: stage.as("hub_door"),
        platform: stage.platform(),
        door: DOOR,
        retrySeconds: 30,
        maxAttempts: 5,
        now: fake.now,
        registry,
        hooks: {} as ApprovalHooks,
        pollMs: 1000,
        ...overrides,
      };
    },
    registry: loadFor,
    gate: () => ({ notBefore: 0 }),
    async close() {
      for (const sql of opened.splice(0)) await sql.close().catch(() => {});
      cached.clear();
    },
  };
  stages.push(stage);
  return stage;
}

/** One pass of the door's delivery: read what is owed and do what is due. Says when something is next due. */
export async function pass(ctx: EffectsContext, gate: EffectsGate, startup = false): Promise<number | null> {
  return await runEffectWork(ctx, gate, await readEffectWork(ctx, { startup }));
}

export async function effectRow(stage: EffectsStage, key: string): Promise<Record<string, any>> {
  const [row] = await stage.admin`select * from platform_effect where key = ${key}`;
  return row;
}
