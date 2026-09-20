// A Telegram door reads its bot's ONE update queue:
// `getUpdates` confirms every update below the offset it is sent, for the whole
// bot and not per chat, and Telegram refuses a second long poll on the same bot
// while one is open. The door keeps one cursor per chat and runs one reader per
// agent, so a second agent on the same Telegram door acknowledges the first
// one's messages without accepting them. The loader refuses that file by name.
// Discord's cursor is a per-channel snowflake, so the same shape stays legal
// there.
import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hubPath } from "./helpers/cluster.ts"
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts"

const example = readFileSync(hubPath("src/registry/registry.example.toml"), "utf8")
const discordDoor = ['', '[[run]]', 'id = "door-discord"', 'kind = "door"', 'machine = "pi"', 'platform = "discord"',
  'person = "p1"', 'token_file = "/etc/imprnt-hub/discord.token"', 'schedule = "always"', 'memory_limit_mb = 192', ''].join("\n")

function second(door: string, chat: string): string {
  return ['', '[[agents]]', 'id = "p1-study"', 'person = "p1"', 'preset = "daily"', `chat = "${chat}"`, `door = "${door}"`, 'runner = "runner-pi"', ''].join("\n")
}

function write(text: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "hub-telegram-door-")), "registry.toml")
  writeFileSync(file, text)
  return file
}

for (const [shape, text, refused] of [
  ["a Telegram door serving two chats", example + second("door-telegram", "1000000002"), true],
  ["a Telegram door serving two agents in one chat", example + second("door-telegram", "0000000000"), true],
  ["a Discord door serving two chats", example.replace('door = "door-telegram"', 'door = "door-discord"') + discordDoor + second("door-discord", "1000000002"), false],
  ["a Telegram door serving one chat beside a Discord door", example + discordDoor + second("door-discord", "1000000002"), false],
] as const) {
  test(`IMP-160 D-173 ${shape} is ${refused ? "refused by name" : "loaded"}`, () => {
    const file = write(text)
    if (!refused) {
      expect(loadRegistry(file).agents.map(agent => agent.id).sort()).toEqual(["p1-lair", "p1-study"])
      return
    }
    let error: unknown
    try { loadRegistry(file) } catch (caught) { error = caught }
    expect(error, "the loader must refuse a Telegram door with two readers").toBeInstanceOf(RegistryRefused)
    const refusal = error as RegistryRefused
    expect(refusal.reason).toContain("door-telegram")
    expect(refusal.reason).toContain("Telegram")
    expect(refusal.reason).toContain("p1-lair")
    expect(refusal.reason).toContain("p1-study")
    // The line is the second agent's door binding, the one that made it two.
    const lines = text.split("\n")
    const at = lines.findIndex((line, index) => line === 'door = "door-telegram"' && lines.slice(0, index).some(one => one === 'id = "p1-study"')) + 1
    expect(refusal.line).toBe(at)
  })
}
