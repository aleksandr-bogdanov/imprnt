// Every agent starts complete. A loop launches with Claude Code's own
// instruction discovery off, so the launch itself assembles what the agent
// reads: the code's own section on how the hub works, then the person's vault
// instructions with their imports expanded, then the agent's fragment. An
// agent that names no fragment, MCP servers or settings, which is the shape an
// agent made from a chat has, starts with its person's.
import { beforeAll, expect, test } from "bun:test"
import { chmodSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { claudeCode } from "../src/adapters/claude-code.ts"
import { LOOP_PREAMBLE } from "../src/adapters/instructions.ts"
import { loadRegistry } from "../src/registry/load.ts"
import { loopFixture, launchInput, launchSeam, captureCli, ending, appended } from "./helpers/rollout-loop.ts"
beforeAll(async () => { await import("../live/prove-rollout-loop.ts") })

/** A vault directory inside p1's tree, declared as p1's `vault`, carrying the two instruction files. */
function withVault(f: ReturnType<typeof loopFixture>, extra = "") {
  const root = join(f.trees.person("p1").tree, "vault-project")
  mkdirSync(join(root, "vault"), { recursive: true })
  mkdirSync(join(root, "plugins"), { recursive: true })
  writeFileSync(join(root, "CLAUDE.md"), "p1-vault-contract-rule\n")
  writeFileSync(join(root, "CLAUDE.local.md"), "# local wiring\n@plugins/rules.md\n# @plugins/commented.md\n")
  writeFileSync(join(root, "plugins", "rules.md"), "p1-imported-rule\n")
  f.write(f.field("p1", "vault", JSON.stringify(root), f.text + extra))
  return root
}

/** Launch through the real adapter start and the real box, and return what the fake CLI saw. */
async function launched(f: ReturnType<typeof loopFixture>, change: (input: any) => void = () => {}) {
  const make = await launchSeam(), input = launchInput(f)
  change(input)
  const launch = await make(input)
  const capture = join(input.sessionDir, "capture.json")
  const session = await claudeCode.start({ ...launch, preset: input.preset, sessionId: null,
    wrap: (argv: string[]) => launch.wrap(captureCli(capture, f)(argv)) })
  try { await ending(session) } finally { await session.close() }
  return { launch, got: JSON.parse(readFileSync(capture, "utf8")), input }
}

test("an ordinary launch appends the code's section, the vault's CLAUDE.md, what CLAUDE.local.md imports and the fragment, in that order", async () => {
  const f = loopFixture()
  try {
    const root = withVault(f)
    const { launch, got } = await launched(f)
    const prompt = appended(got.fragment)
    const fragment = readFileSync(f.files.fragment, "utf8").trim()
    expect(prompt.preamble, "the code's own section opens the prompt").toBe(true)
    expect(prompt.after(LOOP_PREAMBLE.trim(), "p1-vault-contract-rule", "# local wiring", "p1-imported-rule", fragment)).toBe(true)
    // Control: the same check refuses the wrong order, so it is not vacuous.
    expect(prompt.after(fragment, "p1-vault-contract-rule")).toBe(false)
    expect(prompt.text).not.toContain("@plugins/rules.md")
    expect(prompt.text).toContain("# @plugins/commented.md")
    expect(launch.env.IMPRNT_VAULT, "the vault the rules came from is the vault the agent is told").toBe(join(root, "vault"))
    expect(got.argv[got.argv.indexOf("--append-system-prompt-file") + 1].startsWith(launch.cwd)).toBe(true)
  } finally { f.stop() }
})

test("the code's section describes the hub as it runs now and nothing older", () => {
  for (const word of ["$IMPRNT_VAULT", "imprnt recall", "imprnt context", "/dispatch"]) expect(LOOP_PREAMBLE).toContain(word)
  for (const gone of ["HUB_SEND", "NATS", "/srv/hub", "mail"]) expect(LOOP_PREAMBLE).not.toContain(gone)
  expect(LOOP_PREAMBLE.trim().split("\n").length).toBeLessThan(30)
})

test("an agent shaped like one made from a chat gets its person's MCP servers, settings and instructions", async () => {
  const f = loopFixture()
  try {
    const personMcp = join(f.dir, "person-mcp.json"), personSettings = join(f.dir, "person-settings.json")
    const rules = join(f.dir, "person-rules.md")
    writeFileSync(personMcp, JSON.stringify({ mcpServers: { "p1-memory": { type: "http", url: "http://127.0.0.1:9/mcp" } } }))
    writeFileSync(personSettings, JSON.stringify({ permissions: { allow: ["Read"], deny: ["WebFetch"] } }))
    writeFileSync(rules, "p1-declared-instruction\n")
    // Exactly the fields the hub writes when a chat asks for a new agent.
    const chat = '\n[[agents]]\nid = "p1-chat"\nperson = "p1"\npreset = "daily"\nchat = "1111111111"\ndoor = "door-fake"\nrunner = "runner-pi"\n'
    let text = f.field("p1", "mcp", JSON.stringify(personMcp), f.text + chat)
    text = f.field("p1", "settings", JSON.stringify(personSettings), text)
    f.write(f.field("p1", "instructions", JSON.stringify([rules]), text))
    const agent = loadRegistry(f.file).agents.find(one => one.id === "p1-chat")!
    expect(Object.keys(agent).sort()).toEqual(["chat", "door", "id", "person", "preset", "runner"])
    const { got } = await launched(f, input => { input.agent = agent })
    expect(got.mcp).toEqual(JSON.parse(readFileSync(personMcp, "utf8")))
    expect(got.settings).toEqual(JSON.parse(readFileSync(personSettings, "utf8")))
    const prompt = appended(got.fragment)
    expect(prompt.preamble).toBe(true)
    expect(prompt.text).toContain("p1-declared-instruction")
    // A declared list replaces the vault's own files, and nothing of p1-lair's leaks in.
    expect(prompt.text).not.toContain("Synthetic filing rules.")
    expect(prompt.text).not.toContain(readFileSync(f.files.fragment, "utf8").trim())
    // An agent's own files still win over its person's.
    const own = await launched(f)
    expect(own.got.mcp).toEqual(JSON.parse(readFileSync(f.files.mcp, "utf8")))
    expect(own.got.settings).toEqual(JSON.parse(readFileSync(f.files.settings, "utf8")))
  } finally { f.stop() }
})

test("imports resolve the way Claude Code resolves them: relative, absolute, once each, never inside a code fence", async () => {
  const f = loopFixture()
  try {
    const root = withVault(f)
    writeFileSync(join(root, "absolute-rule.md"), "p1-absolute-rule\n")
    writeFileSync(join(root, "plugins", "rules.md"), "p1-imported-rule\n@nested/deeper.md\n@../CLAUDE.md\n")
    mkdirSync(join(root, "plugins", "nested"))
    writeFileSync(join(root, "plugins", "nested", "deeper.md"), "p1-nested-rule\n")
    writeFileSync(join(root, "CLAUDE.local.md"), `@plugins/rules.md\n@${join(root, "absolute-rule.md")}\n@plugins/rules.md\n\`\`\`\n@plugins/fenced.md\n\`\`\`\n~~~~\n\`\`\`\n@plugins/inside-longer-fence.md\n~~~~\n`)
    const { got } = await launched(f)
    const prompt = appended(got.fragment)
    expect(prompt.after("p1-vault-contract-rule", "p1-imported-rule", "p1-nested-rule", "p1-absolute-rule")).toBe(true)
    expect(prompt.text, "a three-backtick line inside a four-tilde block does not close it").toContain("@plugins/inside-longer-fence.md")
    for (const once of ["p1-vault-contract-rule", "p1-imported-rule", "p1-nested-rule"]) {
      expect(prompt.text.split(once).length - 1, `${once} is included once`).toBe(1)
    }
    expect(prompt.text).toContain("@plugins/fenced.md")
  } finally { f.stop() }
})

test("an instruction file or import that cannot be read refuses the launch and names it", async () => {
  const f = loopFixture()
  try {
    const root = withVault(f)
    const make = await launchSeam()
    writeFileSync(join(root, "CLAUDE.local.md"), "@plugins/absent.md\n")
    await expect(make(launchInput(f))).rejects.toThrow(/instructions-unreadable: .*absent\.md \(imported by .*CLAUDE\.local\.md\)/)
    writeFileSync(join(root, "CLAUDE.local.md"), "nothing imported\n")
    expect((await make(launchInput(f))).argv).toContain("--append-system-prompt-file")
    chmodSync(join(root, "CLAUDE.md"), 0o000)
    await expect(make(launchInput(f))).rejects.toThrow(/instructions-unreadable: .*CLAUDE\.md/)
    chmodSync(join(root, "CLAUDE.md"), 0o600)
    // A chain deeper than Claude Code follows is refused rather than cut short.
    for (let n = 1; n <= 6; n++) writeFileSync(join(root, `chain-${n}.md`), n < 6 ? `@chain-${n + 1}.md\n` : "end\n")
    writeFileSync(join(root, "CLAUDE.local.md"), "@chain-1.md\n")
    await expect(make(launchInput(f))).rejects.toThrow(/instructions-import-too-deep/)
  } finally { f.stop() }
})

test("a person's declared instruction, MCP or settings file that cannot be read is refused by the loader", () => {
  const f = loopFixture()
  try {
    const absent = join(f.dir, "absent.md")
    for (const [key, value] of [["instructions", JSON.stringify([absent])], ["mcp", JSON.stringify(absent)], ["settings", JSON.stringify(absent)]]) {
      f.write(f.field("p1", key, value, f.text))
      expect(() => loadRegistry(f.file), key).toThrow(/absolute readable file/)
    }
    f.write(f.field("p1", "instructions", JSON.stringify([f.files.fragment]), f.text))
    expect(loadRegistry(f.file).people.find(one => one.id === "p1")!.instructions).toEqual([f.files.fragment])
  } finally { f.stop() }
})

test("a harvest launch appends nothing", async () => {
  const f = loopFixture()
  try {
    withVault(f)
    const make = await launchSeam()
    const harvest = await make(launchInput(f, "harvest"))
    expect(harvest.argv).not.toContain("--append-system-prompt-file")
    expect(harvest.env.IMPRNT_VAULT).toBeUndefined()
  } finally { f.stop() }
})

test("an import can never reach what the box hides: another person's tree, a login, or a symlink into either", async () => {
  const f = loopFixture()
  try {
    const root = withVault(f)
    const make = await launchSeam()
    const theirs = join(f.trees.person("p2").tree, "p2-private.md")
    writeFileSync(theirs, "p2-private-sentinel\n")
    const refused = async (local: string) => {
      writeFileSync(join(root, "CLAUDE.local.md"), local)
      await expect(make(launchInput(f)), local).rejects.toThrow(/instructions-forbidden/)
    }
    await refused(`@${theirs}\n`)
    await refused(`@${f.login}\n`)
    await refused(`@~/.claude/.credentials.json\n`)
    // Anything outside the person's vault, a key in HOME above all, is refused whatever it is.
    writeFileSync(join(f.home, "id_ed25519"), "synthetic-private-key\n")
    await refused(`@~/id_ed25519\n`)
    await refused(`Keep (@~/id_ed25519) close.\n`)
    symlinkSync(theirs, join(root, "plugins", "looks-local.md"))
    await refused("@plugins/looks-local.md\n")
    await refused("Read @plugins/looks-local.md first.\n")
    // The vault's own instruction file, swapped for a link to a login, is refused the same way.
    writeFileSync(join(root, "CLAUDE.local.md"), "nothing imported\n")
    const contract = join(root, "CLAUDE.md")
    require("node:fs").rmSync(contract)
    symlinkSync(f.login, contract)
    await expect(make(launchInput(f))).rejects.toThrow(/instructions-forbidden/)
    // A file the registry names by hand may sit anywhere the box does not
    // hide, because the owner wrote it. A LINK under that name is not that
    // file: an agent that can write the directory could point the name at a
    // login, so a declared name that is a link is judged by where it lands.
    require("node:fs").rmSync(contract)
    writeFileSync(contract, "p1-vault-contract-rule\n")
    const declared = join(f.dir, "declared-by-hand.md")
    writeFileSync(declared, "p1-declared-rule\n")
    f.write(f.field("p1", "instructions", JSON.stringify([declared]), f.text))
    expect((await make(launchInput(f))).argv, "a declared file outside the vault is the owner's hand").toContain("--append-system-prompt-file")
    const inside = join(root, "declared-inside.md")
    writeFileSync(inside, "p1-declared-inside-rule\n")
    f.write(f.field("p1", "instructions", JSON.stringify([inside]), f.text))
    expect((await make(launchInput(f))).argv).toContain("--append-system-prompt-file")
    require("node:fs").rmSync(inside)
    symlinkSync(f.login, inside)
    await expect(make(launchInput(f)), "the declared name swapped for a link to a login").rejects.toThrow(/instructions-forbidden/)
    // A directory above the name swapped for a link is the same trick one
    // level up: the name is untouched and lands somewhere else.
    const nested = join(root, "rules", "declared.md")
    mkdirSync(join(root, "rules"))
    writeFileSync(nested, "p1-nested-declared-rule\n")
    f.write(f.field("p1", "instructions", JSON.stringify([nested]), f.text))
    expect((await make(launchInput(f))).argv).toContain("--append-system-prompt-file")
    const elsewhere = join(f.dir, "elsewhere-rules")
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, "declared.md"), "synthetic-planted-rule\n")
    require("node:fs").renameSync(join(root, "rules"), join(root, "rules-moved"))
    symlinkSync(elsewhere, join(root, "rules"))
    await expect(make(launchInput(f)), "the declared name under a swapped directory").rejects.toThrow(/instructions-forbidden/)
  } finally { f.stop() }
})

test("an @ inside a sentence imports a file that exists and leaves a mention of someone as text", async () => {
  const f = loopFixture()
  try {
    const root = withVault(f)
    writeFileSync(join(root, "plugins", "inline.md"), "p1-inline-rule\n")
    writeFileSync(join(root, "CLAUDE.local.md"), "Read @plugins/inline.md before answering.\nAsk @someone, and see `@plugins/code-span.md`.\nAlso (@plugins/bracketed.md).\nA span may hold a backtick: `` `@plugins/double-span.md` `` is code too, and @plugins/after-span.md is not.\n")
    writeFileSync(join(root, "plugins", "bracketed.md"), "p1-bracketed-rule\n")
    writeFileSync(join(root, "plugins", "code-span.md"), "p1-code-span-rule\n")
    writeFileSync(join(root, "plugins", "double-span.md"), "p1-double-span-rule\n")
    writeFileSync(join(root, "plugins", "after-span.md"), "p1-after-span-rule\n")
    const { got } = await launched(f)
    const prompt = appended(got.fragment)
    expect(prompt.after("Read @plugins/inline.md before answering.", "p1-inline-rule", "Ask @someone")).toBe(true)
    expect(prompt.text).not.toContain("p1-code-span-rule")
    expect(prompt.text, "a double-backtick span is code, the way Claude Code reads it").not.toContain("p1-double-span-rule")
    expect(prompt.text, "and the prose after it is still prose").toContain("p1-after-span-rule")
    expect(prompt.after("Also (@plugins/bracketed.md).", "p1-bracketed-rule")).toBe(true)
  } finally { f.stop() }
})
