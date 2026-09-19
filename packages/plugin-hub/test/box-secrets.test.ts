// Checks (a) and (b) of IMP-158: a boxed agent cannot read the hub's secrets
// or a bot token, and so cannot log in to the store as any hub role. The path
// this closes is prompt injection: an agent steered by outside content it read,
// a web page, an email or a listing, running shell commands.
//
// The box shares the machine's network, because the loop needs the model and
// the tailnet, so the store on loopback is reachable from inside it. What keeps
// an agent out is that every hub role has a password (test/install-passwords)
// and the box masks where the passwords are. The same holds for the bot
// tokens: an agent that reads one can post in any chat as the bot.
//
// What the box masks, per agent launch:
//   - the secrets directory, `hub.secrets_dir` or `<hub.state_dir>/secrets`
//   - every door's `token_file`
//   - every `[[credentials]]` file the launch did not select, which is every
//     bot token and every OTHER model login
// and what it does NOT: the model login the launch selected, because the loop
// runs on it.
//
// The fixture places one bot token BESIDE the selected model login, in the
// directory the launch grants the loop for reading (the adversarial case, and
// a layout a household may well choose), one in a directory of its own, and a
// second model login the launch did not select.
//
// (b) is pure: the rendered bwrap argv and the rendered macOS profile, for the
// context the runner builds, on either machine. (a) runs the REAL box on this
// machine's flavour through the real launch wrapper, with a control that runs
// the same probe unboxed, and a control that the hub's own path still logs in.
//
// Per flavour, before the fix: on Linux the box binds the whole filesystem, so
// every token, the other login and the password files were readable and every
// role logged in. On macOS the profile denies by default, so the token in its
// own directory, the other login and the secrets directory were already out of
// reach, and the hole was the token beside the login, which the grant for the
// login's directory handed over.
//
// Red reason: the box masks none of these paths.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pgBin, seam, startCluster, type Cluster } from "./helpers/cluster.ts"
import { boxGate } from "./helpers/box-gate.ts"
import { plantTrees } from "./helpers/trees.ts"
import { writeRegistry } from "./helpers/registry.ts"
import { requirePasswords } from "./helpers/scram.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { getPreset } from "../src/registry/presets.ts"

const SLOW = 120_000
const ROLES = ["hub_door", "hub_runner", "hub_agent", "hub_hub"]
const gate = boxGate()

function secret(what: string): string {
  return `${what}-${crypto.randomUUID().replace(/-/g, "")}`
}

interface Household {
  root: string
  registryFile: string
  stateDir: string
  secrets: string
  login: { file: string; text: string }
  beside: { file: string; text: string }
  apart: { file: string; text: string }
  otherLogin: { file: string; text: string }
}

function household(storeUrl = "postgres://127.0.0.1:5432/hub", admin?: string[]): Household {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "hub-box-secrets-")))
  const trees = plantTrees(root)
  const stateDir = join(root, "state")
  mkdirSync(join(stateDir, "p1"), { recursive: true })
  const secrets = join(stateDir, "secrets")
  mkdirSync(secrets, { mode: 0o700 })
  const place = (file: string, text: string) => {
    mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 })
    writeFileSync(file, text, { mode: 0o600 })
    return { file, text }
  }
  const login = place(join(root, "login", ".credentials.json"), JSON.stringify({ marker: secret("own-login") }))
  const beside = place(join(root, "login", "telegram.token"), secret("telegram-token"))
  const apart = place(join(root, "tokens", "discord.token"), secret("discord-token"))
  const otherLogin = place(join(root, "other-login", ".credentials.json"), JSON.stringify({ marker: secret("other-login") }))
  const registryFile = writeRegistry(root, {
    hub: { store_url: storeUrl, state_dir: stateDir, shared_zone: trees.sharedZone },
    people: trees.people.map(p => ({ id: p.id, tree: p.tree })),
    credentials: [
      { id: "household-claude", kind: "claude-login", file: login.file, owner: "household" },
      { id: "p2-claude", kind: "claude-login", file: otherLogin.file, owner: "p2" },
      { id: "telegram-bot", kind: "telegram", file: beside.file, owner: "household" },
    ],
    presets: { daily: { adapter: "claude-code", model: "a-model-name", provider: "anthropic", effort: "medium", paid: "key", credential: "household-claude" } },
    agents: [{ id: "p1-lair", person: "p1", preset: "daily", chat: "0000000000", door: "door-telegram", runner: "runner-pi" }],
    run: [
      { id: "door-telegram", kind: "door", schedule: "always", memory_limit_mb: 128, platform: "telegram", person: "p1", token_file: beside.file },
      { id: "door-discord", kind: "door", schedule: "always", memory_limit_mb: 128, platform: "discord", person: "p2", token_file: apart.file },
      { id: "runner-pi", kind: "runner", schedule: "always", memory_limit_mb: 256, child_memory_limit_mb: 256 },
    ],
  })
  if (admin) writeFileSync(registryFile, `${readFileSync(registryFile, "utf8")}\n[install]\nadmin_argv = ${JSON.stringify(admin)}\n`)
  return { root, registryFile, stateDir, secrets, login, beside, apart, otherLogin }
}

/** The launch the runner makes for this agent: same registry reads, same box, same wrapper. */
async function launchOf(h: Household) {
  const { boxContextFor } = await seam("src/box/index.ts")
  const { credentialSource, makeLoopLaunch } = await seam("src/adapters/launch.ts")
  const registry = loadRegistry(h.registryFile)
  const agent = registry.agents.find(one => one.id === "p1-lair")!
  return (makeLoopLaunch as Function)({
    registry, agent, preset: getPreset(registry, "daily"), purpose: "ordinary",
    credential: (credentialSource as Function)(registry, "daily"),
    sessionDir: join(h.stateDir, "p1", "sessions", "p1-lair", crypto.randomUUID()),
    box: (boxContextFor as Function)(registry, "p1-lair"),
  }) as Promise<{ cwd: string; env: Record<string, string>; wrap(argv: string[]): string[] }>
}

/** Every bwrap mount that hides `path`, with what it hides it under. */
function masksOf(argv: string[], path: string): string[] {
  const found: string[] = []
  for (let at = 0; at < argv.length; at += 1) {
    if (argv[at] === "--tmpfs" && argv[at + 1] === path) found.push("tmpfs")
    if (argv[at] === "--ro-bind" && argv[at + 1] === "/dev/null" && argv[at + 2] === path) found.push("null")
  }
  return found
}

/** The lines of a profile that deny reading `path`, and where the last allow is. */
function deniesOf(profile: string, path: string): { deny: number; lastAllow: number } {
  const lines = profile.split("\n")
  return {
    deny: lines.findIndex(line => line.startsWith("(deny file-read*") && line.includes(`(subpath ${JSON.stringify(path)})`)),
    lastAllow: lines.reduce((last, line, at) => line.startsWith("(allow") ? at : last, -1),
  }
}

test("IMP-158 (b) the rendered bwrap argv masks the secrets directory, every bot token and the other model login, after the host bind", async () => {
  const h = household()
  try {
    const { boxContextFor, boxCommand } = await seam("src/box/index.ts")
    const ctx = (boxContextFor as Function)(loadRegistry(h.registryFile), "p1-lair")
    const { argv } = (boxCommand as Function)(["/bin/true"], ctx, "linux") as { argv: string[] }
    const hostBind = argv.indexOf("--dev-bind")
    expect(hostBind).toBeGreaterThan(0)
    expect(masksOf(argv, h.secrets)).toEqual(["tmpfs"])
    for (const token of [h.beside.file, h.apart.file]) expect(masksOf(argv, token), token).toEqual(["null"])
    // The runner's context names every login. Which one a launch keeps is the launch's choice, below.
    expect(masksOf(argv, h.otherLogin.file)).toEqual(["null"])
    const firstMask = argv.findIndex((one, at) => (one === "--tmpfs" && argv[at + 1] === h.secrets))
    expect(firstMask, "a mask before the host bind is covered by it").toBeGreaterThan(argv.indexOf("--proc"))
    expect(argv.indexOf("--")).toBeGreaterThan(firstMask)
  } finally { rmSync(h.root, { recursive: true, force: true }) }
})

test("IMP-158 (b) the rendered macOS profile denies the secrets directory, every bot token and the other model login, after every allow", async () => {
  const h = household()
  try {
    const { boxContextFor, boxCommand } = await seam("src/box/index.ts")
    const ctx = (boxContextFor as Function)(loadRegistry(h.registryFile), "p1-lair")
    const text = ((boxCommand as Function)(["/bin/true"], ctx, "darwin") as { profile: { text: string } }).profile.text
    for (const path of [h.secrets, h.beside.file, h.apart.file, h.otherLogin.file]) {
      const { deny, lastAllow } = deniesOf(text, path)
      expect(deny, `${path} is denied`).toBeGreaterThan(-1)
      expect(deny, `${path} is denied after the last allow, because the last matching rule wins`).toBeGreaterThan(lastAllow)
    }
  } finally { rmSync(h.root, { recursive: true, force: true }) }
})

test("IMP-158 (b) a real launch keeps its own model login readable and masks the other one", async () => {
  const h = household()
  try {
    const launch = await launchOf(h)
    const argv = launch.wrap(["/bin/true"])
    if (argv[0] === "/usr/bin/bwrap") {
      expect(masksOf(argv, h.login.file)).toEqual([])
      expect(masksOf(argv, h.otherLogin.file)).toEqual(["null"])
      expect(masksOf(argv, h.beside.file)).toEqual(["null"])
      expect(masksOf(argv, h.secrets)).toEqual(["tmpfs"])
    } else {
      const text = readFileSync(argv[argv.indexOf("-f") + 1], "utf8")
      expect(deniesOf(text, h.login.file).deny).toBe(-1)
      for (const path of [h.otherLogin.file, h.beside.file, h.apart.file, h.secrets]) expect(deniesOf(text, path).deny, path).toBeGreaterThan(deniesOf(text, path).lastAllow)
    }
  } finally { rmSync(h.root, { recursive: true, force: true }) }
})

let cluster: Cluster
beforeAll(async () => { if (gate.ok) cluster = await startCluster() })
afterAll(async () => { await cluster?.stop() })

test(`IMP-158 (a) inside a real ${process.platform} box no hub role logs in and no token or password file reads, while the hub's own path logs in${gate.ok ? "" : ` [skipped: ${gate.reason}]`}`, async () => {
  if (!gate.ok) {
    process.stderr.write(`SKIP: requires a working box tool: ${gate.reason}\n`)
    return
  }
  const db = await cluster.createDatabase()
  const h = household(`postgres://127.0.0.1:${cluster.port}/${db}`, [pgBin("psql"), "-h", "127.0.0.1", "-p", String(cluster.port), "-U", cluster.superuser])
  const quiet = process.stdout.write.bind(process.stdout)
  try {
    process.stdout.write = (() => true) as typeof process.stdout.write
    try {
      const { runInstall } = await seam("src/install/run.ts")
      await (runInstall as Function)({ registryFile: h.registryFile, stage: "database" })
    } finally { process.stdout.write = quiet }
    await requirePasswords(cluster)
    const passwords = ROLES.map(role => readFileSync(join(h.secrets, `${role}.password`), "utf8").trim())

    // What a steered agent's shell could run: read every token, look for the
    // passwords, and log in as each role with whatever it found.
    const psql = pgBin("psql")
    const probe = [
      `cat ${h.beside.file}; echo`,
      `cat ${h.apart.file}; echo`,
      `cat ${h.otherLogin.file}; echo`,
      `ls ${h.secrets}`,
      ...ROLES.map(role => `cat ${h.secrets}/${role}.password; echo`),
      ...ROLES.map(role => `PGPASSWORD="$(cat ${h.secrets}/${role}.password 2>/dev/null)" ${psql} -X -At -h 127.0.0.1 -p ${cluster.port} -U ${role} -d ${db} -c "select 'in-as-' || current_user" 2>&1`),
      `cat ${h.login.file}; echo`,
    ].map(line => `${line} 2>&1`).join("; ")
    const run = (argv: string[], env: Record<string, string | undefined>, cwd: string) => {
      const done = Bun.spawnSync(argv, { env, cwd, stdout: "pipe", stderr: "pipe" })
      return done.stdout.toString() + done.stderr.toString()
    }
    const launch = await launchOf(h)
    const boxed = run(launch.wrap(["/bin/sh", "-c", probe]), launch.env, launch.cwd)
    const open = run(["/bin/sh", "-c", probe], { PATH: process.env.PATH, HOME: launch.env.HOME }, launch.cwd)

    // Control: unboxed, the same probe reads everything and logs in as every role.
    for (const text of [h.beside.text, h.apart.text, h.otherLogin.text, ...passwords]) expect(open).toContain(text)
    for (const role of ROLES) expect(open).toContain(`in-as-${role}`)

    // Boxed: nothing of the kind, and the loop still has its own login.
    for (const [what, text] of [["the token beside the login", h.beside.text], ["the token in its own directory", h.apart.text],
      ["the other model login", h.otherLogin.text], ...ROLES.map((role, at) => [`the ${role} password`, passwords[at]])]) {
      expect(boxed.includes(text), `${what} reads inside the box:\n${boxed}`).toBe(false)
    }
    for (const role of ROLES) expect(boxed.includes(`in-as-${role}`), `${role} logs in from inside the box:\n${boxed}`).toBe(false)
    expect(boxed, "the loop's own login stays readable").toContain(h.login.text)

    // Control: the hub's own path, outside the box, logs in as every role with its file.
    const { storeUrlFor } = await seam("src/store/secrets.ts")
    const { openStore } = await seam("src/store/connect.ts")
    const registry = loadRegistry(h.registryFile)
    for (const role of ROLES) {
      const store = await (openStore as Function)({ url: (storeUrlFor as Function)(registry, role) })
      try {
        const [row] = await store.sql`select current_user as role`
        expect(row.role).toBe(role)
      } finally { await store.close() }
    }
  } finally {
    process.stdout.write = quiet
    rmSync(h.root, { recursive: true, force: true })
  }
}, SLOW)
