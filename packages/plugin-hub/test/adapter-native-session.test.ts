// What the Claude adapter is asked for beyond the five verbs: a session that is
// the conversation's own, no native delegation, the hub's own tool server beside
// the person's, capabilities read off the installed CLI and never assumed, and
// evidence about a stopped loop that does not take the parent's exit for the
// tools' exit.
//
// The child is a scripted `claude` put behind the production `wrap` hook, so what
// is bound is the shipped adapter's argv and its reading of a wire shape, not a
// fixture standing in for it. Whether the installed CLI obeys these flags is a
// separate, live question, and nothing here claims to answer it.

import { beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { claudeCode, VALIDATED_BUILTIN_TOOLS, VALIDATED_ORDINARY_PROFILES, VALIDATED_SAFE_RESUME, VALIDATED_TOOL_CONTROL } from "../src/adapters/claude-code.ts"
import { loopLaunch } from "../src/adapters/index.ts"
import { NATIVE_DELEGATION_TOOLS } from "../src/adapters/launch.ts"
import { alive, groupAlive } from "../src/os/tree.ts"
import { fakeClaudeCli, healthyResult } from "./helpers/fake-cli.ts"
import { captureCli, ending, launchInput, launchSeam, loopFixture, scriptedClaude } from "./helpers/rollout-loop.ts"
import { observe, processTree } from "./helpers/rollout-runner.ts"

beforeAll(async () => { await import("../live/prove-rollout-loop.ts") })

const preset = { adapter: "claude-code", model: "synthetic", provider: "synthetic", effort: "medium", paid: "key" } as const
const flagPair = (argv: string[], flag: string) => { const at = argv.indexOf(flag); return at < 0 ? null : [argv[at], argv[at + 1]] }

test("the session is the conversation's own: launched under its id the first time, resumed under it after, never the latest", async () => {
  const seen: string[][] = []
  const wrap = (lines: Record<string, unknown>[]) => (argv: string[]) => { seen.push(argv); return fakeClaudeCli(lines)(argv) }
  const engine = { ...healthyResult("ok"), session_id: "engine-said" }
  const first = await claudeCode.start({ preset, sessionId: null, session: { id: "conversation-uuid", resume: false }, wrap: wrap([engine]) })
  try {
    // Until the engine speaks, what the hub knows is what it asked for, and the
    // engine's own word is not there to be mistaken for it.
    expect(first.sessionId).toBe("conversation-uuid")
    expect(first.reportedSessionId).toBeNull()
    expect((await ending(first)).session_id).toBe("engine-said")
    expect(first.reportedSessionId).toBe("engine-said")
  } finally { await first.close() }
  const again = await claudeCode.start({ preset, sessionId: null, session: { id: "conversation-uuid", resume: true }, wrap: wrap([engine]) })
  await again.close()
  const legacy = await claudeCode.start({ preset, sessionId: "old-id", wrap: wrap([engine]) })
  await legacy.close()
  expect(flagPair(seen[0], "--session-id")).toEqual(["--session-id", "conversation-uuid"])
  expect(seen[0]).not.toContain("--resume")
  expect(flagPair(seen[1], "--resume")).toEqual(["--resume", "conversation-uuid"])
  expect(seen[1]).not.toContain("--session-id")
  expect(flagPair(seen[2], "--resume")).toEqual(["--resume", "old-id"])
  for (const argv of seen) expect(argv).not.toContain("--continue")
})

test("the launch hands over an explicit tool list, denies native delegation, team, workflow and scheduling tools by name, refuses a configuration that lists one back, and refuses an unvalidated ordinary profile by name", async () => {
  const f = loopFixture()
  const sessions: Awaited<ReturnType<typeof claudeCode.start>>[] = []
  try {
    const make = await launchSeam()
    const run = async (input: Record<string, unknown>) => {
      const launch = await make(input)
      const capture = join(input.sessionDir as string, "launch.json")
      const session = await claudeCode.start({ ...launch, preset: (input as any).preset, sessionId: null, wrap: argv => launch.wrap(captureCli(capture, f)(argv)) })
      sessions.push(session)
      await ending(session)
      return JSON.parse(readFileSync(capture, "utf8")) as { argv: string[]; mcp: { mcpServers: Record<string, any> } }
    }
    // The names observed on 2.1.284, the ones the deny reached there and the ones the default set still carried,
    // and the four further non-ordinary native routes the 2.1.285 probes denied and looked for.
    const observed = ["Agent", "Task", "TeamCreate", "TeamDelete", "SendMessage", "Workflow", "ListAgents", "TaskStop", "RemoteTrigger",
      "CronCreate", "CronDelete", "CronList", "ScheduleWakeup", "Monitor", "EnterWorktree", "ExitWorktree", "PushNotification", "ReportFindings", "DesignSync"]
    expect([...NATIVE_DELEGATION_TOOLS].sort()).toEqual([...observed].sort())
    const listed = await run(launchInput(f))
    expect(flagPair(listed.argv, "--disallowedTools")).toEqual(["--disallowedTools", NATIVE_DELEGATION_TOOLS.join(",")])
    // What the agent configured is what it gets: an explicit list, and nothing added or dropped.
    expect(listed.argv[listed.argv.indexOf("--tools") + 1]).toBe("Read,Write,Glob,Grep")
    const input = launchInput(f)
    // The CLI's own "default" is never handed over. An agent that names no tools is refused by name
    // until the build has a validated ordinary profile: this is the acceptance blocker, stated in code.
    await expect(make({ ...input, agent: { ...input.agent, tools: undefined } })).rejects.toThrow("ordinary-tool-profile-unvalidated")
    // With a profile somebody validated for the build, the list is explicit and the deny stands beside it.
    const bare = await run({ ...input, agent: { ...input.agent, tools: undefined }, toolProfile: ["Read", "Glob", "Grep"] })
    expect(bare.argv[bare.argv.indexOf("--tools") + 1]).toBe("Read,Glob,Grep")
    expect(bare.argv).not.toContain("default")
    expect(flagPair(bare.argv, "--disallowedTools")).toEqual(["--disallowedTools", NATIVE_DELEGATION_TOOLS.join(",")])
    // A configuration that names one, by any of its names, is a mistake this refuses, not one it edits away;
    // so is a profile that does.
    for (const tool of [...NATIVE_DELEGATION_TOOLS, "Task(anything)", "Workflow(run)"]) {
      await expect(make({ ...input, agent: { ...input.agent, tools: ["Read", tool] } })).rejects.toThrow("native-delegation-configured")
    }
    await expect(make({ ...input, agent: { ...input.agent, tools: undefined }, toolProfile: ["Read", "Monitor"] })).rejects.toThrow("native-delegation-configured")
    // An agent's own empty list stays the empty list.
    const none = await run({ ...input, agent: { ...input.agent, tools: [] } })
    expect(none.argv[none.argv.indexOf("--tools") + 1]).toBe("")
  } finally { for (const one of sessions) await one.close(); f.stop() }
}, 60_000)

test("the hub's tool server is added beside the person's servers and never in place of them, and a person's own server of that name is a refusal", async () => {
  const f = loopFixture()
  let session: Awaited<ReturnType<typeof claudeCode.start>> | undefined
  try {
    const make = await launchSeam()
    // The person has a tool server of their own, which must survive the merge.
    writeFileSync(f.files.mcp, JSON.stringify({ mcpServers: { "person-tool": { command: "/bin/true", args: ["--own"] } } }))
    const own = JSON.parse(readFileSync(f.files.mcp, "utf8")) as { mcpServers: Record<string, unknown> }
    const input = launchInput(f)
    const hub = { command: "/bin/echo", args: ["facade"], env: { HUB_MCP_SOCKET: "/tmp/x/s" }, reads: [], writes: [] }
    const launch = await make({ ...input, hubMcp: hub })
    const capture = join(input.sessionDir, "launch.json")
    session = await claudeCode.start({ ...launch, preset: input.preset, sessionId: null, wrap: argv => launch.wrap(captureCli(capture, f)(argv)) })
    await ending(session)
    const got = JSON.parse(readFileSync(capture, "utf8")) as { mcp: { mcpServers: Record<string, unknown> } }
    const { hub: bound, ...others } = got.mcp.mcpServers as Record<string, any>
    expect(others).toEqual(own.mcpServers)
    expect(bound).toEqual({ command: "/bin/echo", args: ["facade"], env: { HUB_MCP_SOCKET: "/tmp/x/s" } })
    // The person's file is not rewritten.
    expect(JSON.parse(readFileSync(f.files.mcp, "utf8"))).toEqual(own)
    // A tool server the model could shadow is not merged, and a launch with no tools has none.
    const path = join(f.dir, "hub-named.json")
    writeFileSync(path, JSON.stringify({ mcpServers: { hub: { command: "x" } } }))
    await expect(make({ ...launchInput(f), agent: { ...input.agent, mcp: path }, hubMcp: hub })).rejects.toThrow("invalid-mcp-configuration")
    await expect(make({ ...launchInput(f, "triage"), hubMcp: hub })).rejects.toThrow("invalid-mcp-configuration")
  } finally { await session?.close(); f.stop() }
}, 60_000)

test("capabilities are read off the installed CLI and what a build may be launched with is claimed only for the builds somebody measured, by name and for the scope measured", async () => {
  const f = loopFixture()
  // Three installed builds: the one measured for an ordinary profile and interrupted resume (2.1.285), the one
  // measured for a restricted tool list only (2.1.284), and one nobody measured.
  const measured = scriptedClaude("never", "2.1.285"), restricted = scriptedClaude("never", "2.1.284"), unknown = scriptedClaude("never", "2.1.0")
  const probeOf = (cli: { bin: string }) => ({ bin: cli.bin, timeoutMs: 5000, writePaths: [dirname(cli.bin)] })
  const ask = (cli: { bin: string }) => claudeCode.capabilities!({ registry: f.registry(), agent: { id: "p1-lair", preset: "daily" }, preset: "daily", probe: probeOf(cli) })
  const launch = (cli: { bin: string }, over: Record<string, unknown> = {}, purpose = "ordinary") =>
    loopLaunch({ ...launchInput(f, purpose), ...over } as never, probeOf(cli)) as Promise<{ argv: string[]; env: Record<string, string> }>
  const withAgent = (over: Record<string, unknown>) => ({ agent: { ...launchInput(f).agent, ...over } })
  const tools = (got: { argv: string[] }) => got.argv[got.argv.indexOf("--tools") + 1]
  const NINE = ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch"]
  const original = readFileSync(measured.bin, "utf8")
  try {
    // WHAT IS CLAIMED, exactly: the measured tables and nothing else.
    expect([...VALIDATED_TOOL_CONTROL]).toEqual(["2.1.284", "2.1.285"])
    expect([...VALIDATED_SAFE_RESUME], "interrupted-tool resume is measured on 2.1.285 alone").toEqual(["2.1.285"])
    expect(VALIDATED_ORDINARY_PROFILES, "the ordinary profile is the nine tools measured on 2.1.285 alone").toEqual({ "2.1.285": NINE })
    expect(VALIDATED_BUILTIN_TOOLS).toEqual({ "2.1.284": ["Read", "Glob", "Grep"], "2.1.285": NINE })

    // Read off each build: a flag in the help is not a claim, the measured table is.
    expect(await ask(measured)).toEqual({ stableSession: true, delegationDisabled: true, safeResume: true, version: "2.1.285" })
    expect(await ask(restricted)).toEqual({ stableSession: true, delegationDisabled: true, safeResume: false, version: "2.1.284" })
    expect(await ask(unknown), "everything the help names, and nothing claimed about a build nobody measured")
      .toEqual({ stableSession: true, delegationDisabled: false, safeResume: false, version: "2.1.0" })

    // The measured build: an agent that names no tools gets exactly the nine as an explicit list, and never "default".
    const bare = await launch(measured, withAgent({ tools: undefined }))
    expect(tools(bare)).toBe(NINE.join(","))
    expect(bare.argv).not.toContain("default")
    expect(bare.argv[bare.argv.indexOf("--disallowedTools") + 1]).toBe(NATIVE_DELEGATION_TOOLS.join(","))
    // An agent that named its tools is launched with exactly those, and its own MCP tools are not a builtin to ask about.
    expect(tools(await launch(measured))).toBe("Read,Write,Glob,Grep")
    expect(tools(await launch(measured, withAgent({ tools: ["Read", "mcp__person__lookup", "Bash(git:*)"] })))).toBe("Read,mcp__person__lookup,Bash(git:*)")
    expect(tools(await launch(measured, withAgent({ tools: [] })))).toBe("")
    // A builtin nobody observed on the build is refused by NAME and the build, and nothing is substituted or dropped.
    await expect(launch(measured, withAgent({ tools: ["Read", "TodoWrite", "Skill"] }))).rejects.toThrow("tool-profile-unvalidated: TodoWrite, Skill not validated on claude 2.1.285")
    // Delegation names still refuse, whatever the build.
    await expect(launch(measured, withAgent({ tools: ["Read", "PushNotification"] }))).rejects.toThrow("native-delegation-configured")

    // The build measured for a restricted list only: that list, and no ordinary profile.
    await expect(launch(restricted, withAgent({ tools: undefined }))).rejects.toThrow("ordinary-tool-profile-unvalidated")
    await expect(launch(restricted)).rejects.toThrow("tool-profile-unvalidated: Write not validated on claude 2.1.284")
    expect(tools(await launch(restricted, withAgent({ tools: ["Read", "Grep"] })))).toBe("Read,Grep")

    // A build nobody measured refuses an ordinary launch, by name and version. A triage or harvest launch is a fixed
    // restricted list of its own and is not asked.
    await expect(launch(unknown)).rejects.toThrow("native-tool-control-unvalidated: claude 2.1.0")
    expect(tools(await launch(unknown, {}, "harvest"))).toBe("Read,Glob,Grep")
    expect(tools(await launch(unknown, {}, "triage"))).toBe("")

    // A CLI whose help does not name the flags does not have the capability, and a build that cannot deny a tool is not launched.
    writeFileSync(measured.bin, original.replace(" --session-id --resume", ""))
    expect(await ask(measured)).toMatchObject({ stableSession: false, safeResume: false, delegationDisabled: true })
    writeFileSync(measured.bin, original.replace(" --disallowedTools", ""))
    expect(await ask(measured)).toMatchObject({ stableSession: true, delegationDisabled: false })
    await expect(launch(measured)).rejects.toThrow("native-delegation-unsupported")
  } finally { measured.stop(); restricted.stop(); unknown.stop(); f.stop() }
}, 90_000)

/** An engine whose loop has a tool process under it, the way a running turn does. */
function withTool() {
  const script = `
    const tool = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\\n");
    setInterval(() => {}, 1e9);`
  return () => [process.execPath, "-e", script]
}

test("stopping is judged on the whole tree: a leader that exits leaves its tool behind and that is not stopped, and an unobserved tree is not proved gone", async () => {
  // The loop's own exit does not end what it started.
  const left = await claudeCode.start({ preset, sessionId: null, wrap: withTool() })
  let orphan: number | undefined
  try {
    expect(await observe(() => (left.processes?.() ?? []).length >= 2)).toBe(true)
    orphan = left.processes!()!.find(pid => pid !== left.pid)!
    await left.close()
    const said = await left.exitEvidence!()
    expect(said).toMatchObject({ confirmed: false, leader: "exited", descendants: "survivors" })
    expect(said.survivors).toContain(orphan)
  } finally { if (orphan !== undefined) { try { process.kill(orphan, 9) } catch { /* gone */ } } }

  // Never observed: the leader is gone and nothing else is known, which is not
  // "nothing else exists". The tool is found here, from outside, only to be reaped.
  const blind = await claudeCode.start({ preset, sessionId: null, wrap: withTool() })
  let tool: number | undefined
  try {
    expect(await observe(() => processTree(blind.pid!).length >= 2)).toBe(true)
    tool = processTree(blind.pid!).find(pid => pid !== blind.pid)
    await blind.close()
    const said = await blind.exitEvidence!()
    expect(said).toMatchObject({ confirmed: false, leader: "exited" })
    // A loop that leads a group of its own can be seen to have a member left in it. One that does not
    // has nothing observed to say, and "nothing observed" is unverified and never "none".
    expect(said.descendants).toBe(blind.group?.() != null ? "survivors" : "unverified")
  } finally { if (tool !== undefined) { try { process.kill(tool, 9) } catch { /* gone */ } } }
}, 20_000)

/**
 * An engine whose tool stays up until it is released and then goes down a moment later, the way what a box
 * wrapper's namespace holds is going down when the wrapper is ended. The release is a file in `dir`, and the
 * directory being gone releases it too, so a test that fails early and removes its directory leaves nothing
 * running. A tool nobody releases ends on its own after 30 s.
 */
function withDyingTool(dir: string, release: string, exitAfterMs: number) {
  const tool = `
    const { existsSync } = require("node:fs");
    const failsafe = Date.now() + 30000;
    const poll = setInterval(() => {
      if (existsSync(${JSON.stringify(release)}) || !existsSync(${JSON.stringify(dir)}) || Date.now() > failsafe) {
        clearInterval(poll);
        setTimeout(() => process.exit(0), ${exitAfterMs});
      }
    }, 20);`
  const script = `
    Bun.spawn([process.execPath, "-e", ${JSON.stringify(tool)}], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "s" }) + "\\n");
    setInterval(() => {}, 1e9);`
  return () => [process.execPath, "-e", script]
}

test("a leader that has exited is given a bounded moment for its group to empty: a tool released after the leader is gone is proved gone once it has, where the lookup at the instant of exit found it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "native-session-dying-"))
  const release = join(dir, "release")
  const session = await claudeCode.start({ preset, sessionId: null, wrap: withDyingTool(dir, release, 150) })
  let tool: number | undefined
  try {
    expect(await observe(() => (session.processes?.() ?? []).length >= 2)).toBe(true)
    const grouped = (session.group?.() ?? null) !== null
    tool = session.processes!()!.find(pid => pid !== session.pid)!
    await session.close()
    // The leader is reaped and its tool is held up until released: no clock decides that it is there, and
    // this is the instant the evidence used to be taken at.
    expect(alive(tool), "the tool is still up when the leader is gone").toBe(true)
    // The evidence is asked for while the tool is known to be up, and only then is the tool let go. Taking the
    // lookup at once, as it was, finds it; waiting for the group to empty finds it gone (init reaps it: the
    // fixture runs under `--init`, and a tool that stayed a zombie would still be a survivor here).
    const asked = session.exitEvidence!()
    writeFileSync(release, "")
    const said = await asked
    expect(alive(tool), "the evidence waited for the tool to go").toBe(false)
    expect(said).toMatchObject({ leader: "exited", confirmed: grouped, descendants: grouped ? "none" : "unverified", survivors: [] })
  } finally {
    if (tool !== undefined) { try { process.kill(tool, 9) } catch { /* gone */ } }
    await session.close()
    rmSync(dir, { recursive: true, force: true })
  }
}, 20_000)

test("a loop that leads a process group of its own is judged and stopped on the group, and the basis of what is said is named", async () => {
  const session = await claudeCode.start({ preset, sessionId: null, wrap: withTool() })
  try {
    expect(await observe(() => processTree(session.pid!).length >= 2)).toBe(true)
    const group = session.group?.() ?? null
    // Asked for from the runtime and read back from the process table, never assumed.
    if (group !== null) expect(group).toBe(session.pid!)
    const said = await session.interrupt!({ graceMs: 1000 })
    expect(said.group ?? null).toBe(group)
    if (group !== null) {
      // The managed group is empty and everything seen under it is gone: the bounded claim, and it says so.
      expect(said).toMatchObject({ confirmed: true, leader: "exited", descendants: "none", basis: "process-group", survivors: [], unknown: [] })
      expect(groupAlive(group), "nothing of the group is left").toBe(false)
    } else {
      // A runtime that would not give the child a group of its own has no witness for what was never seen, and
      // "the observed tree is gone" is not "nothing is left": it stays unverified.
      expect(said).toMatchObject({ confirmed: false, leader: "exited", descendants: "unverified", basis: "observed-tree" })
    }
  } finally { await session.close() }
})

test("an explicit interrupt ends the tools and then the loop, within a grace, and says so from the process table", async () => {
  const session = await claudeCode.start({ preset, sessionId: null, wrap: withTool() })
  expect(await observe(() => (session.processes?.() ?? []).length >= 2)).toBe(true)
  const tree = session.processes!()!
  const grouped = (session.group?.() ?? null) !== null
  const said = await session.interrupt!({ graceMs: 1000 })
  // Confirmed only with the group to vouch for what was never seen; the tree is gone either way.
  expect(said).toMatchObject({ confirmed: grouped, leader: "exited", descendants: grouped ? "none" : "unverified", survivors: [] })
  expect(said.pids).toEqual(expect.arrayContaining(tree))
  for (const pid of tree) expect(alive(pid), `${pid} is gone`).toBe(false)
})
