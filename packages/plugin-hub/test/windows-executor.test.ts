// The Windows execution machine: the registry lines the doc gives, the plan
// the setup reads off them, and the PowerShell block itself.
// (docs/windows-executor.md, tools/windows/executor-setup.ps1)
//
// OFFLINE, BOTH PLATFORMS. The Windows PC this is for was offline when it was
// written, so nothing here runs WSL or PowerShell. What is checked:
// - the doc's registry lines load through the real loader, for the store
//   machine and for the PC, and render the PC's systemd units;
// - the spoke plan accepts them and refuses, by name, a door, a board, a
//   missing machine, a missing login and a missing store route;
// - the block: every embedded shell script is valid for `bash -n`, no syntax
//   Windows PowerShell 5.1 lacks, no secret on a command line, the closing of
//   interop and the drives, and none of the actions the setup must never take.
// A PowerShell parser is run on it only where one is installed (named skip).

import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRegistry, type RegistrySpec } from "./helpers/registry.ts";
import { loadRegistry, readSetting } from "../src/registry/load.ts";
import { listRunEntries } from "../src/registry/entries.ts";
import { osFor } from "../src/os/index.ts";
import { spokePlan } from "../src/install/spoke.ts";

const HUB = join(import.meta.dir, "..");
const DOC = readFileSync(join(HUB, "docs/windows-executor.md"), "utf8");
const SCRIPT = readFileSync(join(HUB, "tools/windows/executor-setup.ps1"), "utf8");
const PC = "desktop-oscsid6";

/** The registry lines the doc tells the owner to add, as the doc carries them. */
function docLines(): string {
  const found = DOC.match(/<!-- windows-executor-registry: begin -->\n```toml\n([\s\S]*?)```\n<!-- windows-executor-registry: end -->/);
  if (!found) throw new Error("the doc carries no marked registry block");
  return found[1];
}

/** A household as it stands with the Mac's procedure done, plus the doc's lines and the login's `on` line. */
function household(dir: string, extra = "", spec: Partial<RegistrySpec> = {}): string {
  const base: RegistrySpec = {
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: "/var/lib/imprnt-hub", store_machine: "pi" },
    machines: [{ id: "pi", os: "linux" }],
    people: [{ id: "p1", tree: join(dir, "p1") }],
    presets: { daily: { adapter: "scripted", model: "m", provider: "p", effort: "medium", paid: "plan" } },
    agents: [{ id: "p1-lair", person: "p1", preset: "daily", chat: "0000000001", door: "door-pi", runner: "runner-pi" }],
    credentials: [{ id: "claude-runner", kind: "claude-login", file: "/var/lib/imprnt-hub/login/.credentials.json", owner: "household",
      on: { [PC]: { file: "/home/imprnt/.imprnt-hub/login/.credentials.json" } } }],
    run: [
      { id: "door-pi", kind: "door", machine: "pi", platform: "fake", person: "p1", token_file: "/dev/null", schedule: "always", memory_limit_mb: 192 },
      { id: "runner-pi", kind: "runner", machine: "pi", schedule: "always", memory_limit_mb: 512, child_memory_limit_mb: 2048 },
      { id: "hub-pi", kind: "hub", machine: "pi", schedule: "always", memory_limit_mb: 128 },
    ],
    ...spec,
  };
  const file = writeRegistry(dir, base);
  writeFileSync(file, `${readFileSync(file, "utf8")}\n${docLines()}\n${extra}`);
  return file;
}

function scratch<T>(body: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "hub-windows-"));
  try { return body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("the doc's registry lines load for the store machine and for the PC, and the PC reads its own state directory and route", () => scratch(dir => {
  const file = household(dir);
  const asWritten = loadRegistry(file);
  expect(listRunEntries(asWritten).filter(e => e.machine === PC).map(e => `${e.id}:${e.kind}`)).toEqual([`runner-${PC}:runner`, `hub-${PC}:hub`]);
  expect(readSetting(loadRegistry(file, { machine: "pi" }), "hub.state_dir")).toBe("/var/lib/imprnt-hub");
  const onPc = loadRegistry(file, { machine: PC });
  expect(readSetting(onPc, "hub.state_dir")).toBe("/home/imprnt/.imprnt-hub");
  expect(readSetting(onPc, "hub.store_url")).toBe("postgres://100.64.0.1:5432/hub");
}));

test("the PC's units render as systemd user units, the flavour the WSL distro runs", () => scratch(dir => {
  const file = household(dir);
  const onPc = loadRegistry(file, { machine: PC });
  const seam = osFor("linux", { unitDir: join(dir, "units") });
  expect(seam.flavour).toBe("systemd");
  for (const entry of listRunEntries(onPc).filter(e => e.machine === PC)) {
    const files = seam.render(entry, {
      machine: PC, stateDir: "/home/imprnt/.imprnt-hub", execPath: "/home/imprnt/.bun/bin/bun", entryScript: `/home/imprnt/release/src/entry/${entry.kind}.ts`,
      registryFile: "/home/imprnt/.imprnt-hub/registry.toml", restartDelaySeconds: 1, giveUpAfter: 5, giveUpWindowSeconds: 300, home: "/home/imprnt",
    });
    expect(files.map(f => f.path.split("/").pop())).toContain(`imprnt-hub-${entry.id}.service`);
    const unit = files.find(f => f.path.endsWith(".service"))!.text;
    expect(unit).toContain("/home/imprnt/.bun/bin/bun");
    expect(unit).toContain("/home/imprnt/.imprnt-hub/registry.toml");
  }
}));

test("the spoke plan accepts the doc's lines and names what the setup needs from them, reading no secret", () => scratch(dir => {
  const file = household(dir);
  const plan = spokePlan(file, PC, path => path === "/home/imprnt/.imprnt-hub/login/.credentials.json");
  expect(plan.problems).toEqual([]);
  expect(plan).toMatchObject({
    machine: PC, os: "linux", state_dir: "/home/imprnt/.imprnt-hub", secrets_dir: "/home/imprnt/.imprnt-hub/secrets",
    store: { host: "100.64.0.1", port: 5432 }, store_machine: "pi", store_secrets_dir: "/var/lib/imprnt-hub/secrets",
    runners: [`runner-${PC}`], hub: `hub-${PC}`, agents: [],
    logins: [{ credential: "claude-runner", file: "/home/imprnt/.imprnt-hub/login/.credentials.json", present: true }],
  });
  // An agent bound to the PC is listed with its tree on the PC.
  const bound = household(join(dir), "", {
    agents: [{ id: "p1-lair", person: "p1", preset: "daily", chat: "0000000001", door: "door-pi", runner: `runner-${PC}` }],
    people: [{ id: "p1", tree: join(dir, "p1"), on: { [PC]: { tree: "/home/imprnt/vault", vault: "/home/imprnt/vault" } } }],
  });
  expect(spokePlan(bound, PC, () => false).agents).toEqual([{ id: "p1-lair", runner: `runner-${PC}`, person: "p1", tree: "/home/imprnt/vault", tree_present: false }]);
}));

test("the spoke plan refuses, by name, a door or a listener on the PC, a machine the file lacks, a login not placed there and a store it cannot reach", () => scratch(dir => {
  const door = household(dir, `[[run]]\nid = "door-${PC}"\nkind = "door"\nmachine = "${PC}"\nplatform = "fake"\nperson = "p1"\ntoken_file = "/dev/null"\nschedule = "always"\nmemory_limit_mb = 192\n`);
  expect(spokePlan(door, PC).problems.join("\n")).toContain(`door-${PC} is a door on ${PC}: a door is one connection per bot token and stays on the store machine`);
  expect(spokePlan(household(dir), "elsewhere").problems).toEqual([`no [[machines]] entry has id "elsewhere": add it on the store machine's registry, then copy the file here again`]);
  const unplaced = household(dir, "", { credentials: [{ id: "claude-runner", kind: "claude-login", file: "/var/lib/imprnt-hub/login/.credentials.json", owner: "household" }] });
  expect(spokePlan(unplaced, PC).problems.join("\n")).toContain(`no claude-login credential is placed on ${PC}`);
  const local = household(dir, "", {});
  writeFileSync(local, readFileSync(local, "utf8").replace("postgres://100.64.0.1:5432/hub", "postgres://localhost:5432/hub"));
  expect(spokePlan(local, PC).problems.join("\n")).toContain("which is this PC itself and not the store machine");
  const noAuthority = household(dir, "", { hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: "/var/lib/imprnt-hub" } });
  // The loader itself refuses a spoke with no authority to compare its copy with, and the plan passes its words on.
  expect(spokePlan(noAuthority, PC).problems.join("\n")).toContain("the registry is refused");
  expect(spokePlan(noAuthority, PC).problems.join("\n")).toContain("hub.store_machine has to say which machine's copy is the one");
}));

/** Every literal here-string of the block (the shell scripts), with its placeholders filled. */
function shellScripts(): string[] {
  const filled: Record<string, string> = { __USER__: "imprnt", __BUN__: "1.3.14", __CLAUDE__: "2.1.286", __CORE__: "0.1.4",
    __REF__: "0".repeat(40), __REPO__: "https://github.com/aleksandr-bogdanov/imprnt.git", __HUB__: "/home/imprnt/r/packages/plugin-hub",
    __MODEL__: "claude-haiku-4-5-20251001", __LOGIN__: "/home/imprnt/.imprnt-hub/login/.credentials.json" };
  return [...SCRIPT.matchAll(/@'\r?\n([\s\S]*?)\r?\n'@/g)].map(m => m[1].replace(/__[A-Z]+__/g, key => filled[key] ?? key));
}

test("every shell script the block carries is valid bash, and the prelude every one runs under is too", () => scratch(dir => {
  const scripts = shellScripts();
  expect(scripts.length).toBeGreaterThanOrEqual(7);
  // The prelude, as PowerShell expands it: backtick-escaped dollars and quotes, `n newlines.
  const prelude = SCRIPT.match(/\$prelude = ("[\s\S]*?")\n\s*\$text =/)![1]
    .split(/"\s*\+\s*\n\s*"/).join("").replace(/^"|"$/g, "")
    .replace(/`n/g, "\n").replace(/`\$/g, "$").replace(/`"/g, '"');
  expect(prelude).toContain('HOME=$(getent passwd "$(id -un)" | cut -d: -f6)\nexport HOME\n');
  for (const [n, body] of [prelude, ...scripts].entries()) {
    const file = join(dir, `script-${n}.sh`);
    writeFileSync(file, body);
    const said = Bun.spawnSync(["bash", "-n", file], { stderr: "pipe" });
    expect({ n, err: said.stderr.toString(), code: said.exitCode }).toEqual({ n, err: "", code: 0 });
  }
}));

/**
 * The block with its here-strings, quoted strings and comments taken out: what PowerShell itself
 * parses as code. A scanner, because a quote of one kind inside a string of the other is ordinary.
 */
function codeOnly(): string {
  let out = "", i = 0;
  const text = SCRIPT.replace(/\r/g, "");
  while (i < text.length) {
    const here = text.slice(i, i + 3);
    if (here === "@'\n" || here === '@"\n') {
      const end = text.indexOf(`\n${here[1]}@`, i + 2);
      out += "''"; i = end + 3; continue;
    }
    const c = text[i];
    if (c === "'") { i++; while (i < text.length && !(text[i] === "'" && text[i + 1] !== "'")) i += text[i] === "'" ? 2 : 1; i++; out += "''"; continue; }
    if (c === '"') { i++; while (i < text.length && text[i] !== '"') i += text[i] === "`" ? 2 : 1; i++; out += '""'; continue; }
    if (c === "#") { while (i < text.length && text[i] !== "\n") i++; continue; }
    out += c; i++;
  }
  return out;
}

test("the block uses nothing Windows PowerShell 5.1 lacks", () => {
  const code = codeOnly();
  for (const seven of ["&&", "||", "??", "?.", "-Parallel", "Clean {", "using namespace"]) expect({ seven, found: code.includes(seven) }).toEqual({ seven, found: false });
  // A ternary is `<cond> ? <a> : <b>`; PowerShell 5.1 has none.
  expect(code).not.toMatch(/\)\s*\?\s*[^\s]/);
  expect(SCRIPT.startsWith("# ==== imprnt hub")).toBe(true);
  expect(SCRIPT.trimEnd().endsWith("}")).toBe(true);
});

test("the passwords go through a hidden prompt and stdin, never a command line, a Windows file or the output", () => {
  expect(SCRIPT).toContain("Read-Host -AsSecureString");
  const plainLines = SCRIPT.split("\n").filter(line => /\$plain\b/.test(line));
  expect(plainLines.map(l => l.trim())).toEqual([
    "$plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)",
    "if ([string]::IsNullOrWhiteSpace($plain)) { Stop-Setup \"an empty $role password was pasted\" }",
    "Send-LinuxFile $LinuxUser ([Text.Encoding]::UTF8.GetBytes($plain)) $target",
    "$plain = $null",
  ]);
  // Send-LinuxFile hands its bytes to wsl.exe on stdin and names only the path.
  expect(SCRIPT).toContain("$b64 | & wsl.exe --distribution $Distro --user $User --cd '~' --exec /bin/sh -c 'umask 077 && tr -d ''\\015\\012'' | base64 -d > $1.part && mv -f $1.part $1' sh $Path | Out-Host");
  for (const forbidden of [/Write-Host[^\n]*\$plain/, /Out-File/, /Set-Content/, /Add-Content/, /ConvertFrom-SecureString/]) expect(SCRIPT).not.toMatch(forbidden);
});

test("the block closes interop and the drives, makes no database, refuses an elevated window and takes none of the forbidden actions", () => {
  const conf = shellScripts().find(s => s.includes("[interop]"))!;
  expect(conf).toContain("[boot]\nsystemd = true");
  expect(conf).toContain("[interop]\nenabled = false\nappendWindowsPath = false");
  expect(conf).toContain("[automount]\nenabled = false\nmountFsTab = false");
  expect(SCRIPT).toContain("create_main_cluster = false");
  // The cluster is switched off before the server package is installed.
  expect(SCRIPT.indexOf("create_main_cluster = false")).toBeLessThan(SCRIPT.indexOf("bubblewrap earlyoom nodejs npm postgresql"));
  expect(SCRIPT).toContain("WindowsBuiltInRole]::Administrator");
  expect(SCRIPT).toContain("--no-launch");
  // A login is made, never copied, exported or refreshed; the only Claude calls are the version and the login.
  const claudeCalls = [...SCRIPT.matchAll(/claude"? ([a-z-]+(?: [a-z]+)?)/g)].map(m => m[1]);
  expect(new Set(claudeCalls.filter(c => !c.startsWith("--version") && !c.startsWith("auth login") && !c.startsWith("is not")))).toEqual(new Set());
  for (const never of [/\.credentials\.json[^\n]*\b(cp|scp|rsync|cat)\b/, /\b(cp|scp|rsync)\b[^\n]*\.credentials\.json/, /setup-token/, /Keychain/i,
    /Invoke-Expression|\biex\b/, /New-NetFirewallRule|netsh/, /\.wslconfig[^\n]*(Set-Content|Out-File|>)/,
    /sysctl -w/, /apparmor_restrict/, /\bssh\b(?!_)/, /\bsudo\b(?! cat)/]) {
    expect({ never: String(never), found: never.test(SCRIPT) }).toEqual({ never: String(never), found: false });
  }
  // `--force` appears only inside the text that tells the owner what to run.
  expect(SCRIPT.split("\n").filter(l => l.includes("--force")).every(l => l.trim().startsWith("echo"))).toBe(true);
  // Services and the paid turn are off unless the owner says so.
  expect(SCRIPT).toMatch(/\$RunProofTurn\s+= \$false/);
  expect(SCRIPT).toMatch(/\$InstallServices\s+= \$false/);
});

test("the Windows CI job only runs when started by hand", () => {
  const job = readFileSync(join(HUB, "../../.github/workflows/windows-executor.yml"), "utf8");
  const on = job.match(/^on:\n((?: .*\n)+)/m)![1];
  expect(on.trim()).toBe("workflow_dispatch:");
  expect(job).toContain("runs-on: windows-latest");
});

const pwsh = Bun.which("pwsh");
test.skipIf(pwsh === null)("the block parses with PowerShell's own parser (skipped: no pwsh on this machine)", () => scratch(dir => {
  const out = join(dir, "errors.txt");
  const said = Bun.spawnSync([pwsh!, "-NoProfile", "-Command",
    `$e=$null; $t=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${join(HUB, "tools/windows/executor-setup.ps1")}', [ref]$t, [ref]$e); $e | ForEach-Object { $_.ToString() } | Set-Content '${out}'; exit $e.Count`]);
  expect({ code: said.exitCode, errors: readFileSync(out, "utf8") }).toEqual({ code: 0, errors: "" });
}));

// The block's own control flow, end to end, under pwsh with a stand-in wsl.exe that runs nothing and
// the Windows-only cmdlets stubbed (test/helpers/windows-dry-run). Not Windows, not WSL, and not
// Windows PowerShell 5.1's argument quoting: the flow, strict mode, the transport and the summary.
test.skipIf(pwsh === null)("a dry run completes with the bytes and passwords delivered by stdin, stops on a plan problem before any prompt, and prints no secret (skipped: no pwsh on this machine)", () => scratch(dir => {
  const plan = (problems: string[]) => JSON.stringify({ machine: PC, os: "linux", state_dir: "/home/imprnt/.imprnt-hub", secrets_dir: "/home/imprnt/.imprnt-hub/secrets",
    store: { host: "100.64.0.1", port: 5432 }, store_machine: "pi", store_secrets_dir: "/var/lib/imprnt-hub/secrets", runners: [`runner-${PC}`], hub: `hub-${PC}`,
    entries: [], logins: [{ credential: "claude-runner", file: "/home/imprnt/.imprnt-hub/login/.credentials.json", present: false }], agents: [], problems });
  const registry = join(dir, "registry.toml");
  writeFileSync(registry, Buffer.from("registry bytes é\r\nline2\n"));
  const run = (name: string, problems: string[]) => {
    const state = join(dir, name);
    writeFileSync(join(dir, `${name}.json`), plan(problems));
    const helpers = join(import.meta.dir, "helpers/windows-dry-run");
    const said = Bun.spawnSync([pwsh!, "-NoProfile", "-NonInteractive", "-File", join(helpers, "run.ps1"), "-Block", join(HUB, "tools/windows/executor-setup.ps1"),
      "-Registry", registry, "-State", state, "-Mode", "full"], {
      env: { ...process.env, PATH: `${helpers}:${process.env.PATH}`, FAKE_WSL_STATE: state, FAKE_WSL_PLAN: join(dir, `${name}.json`) }, stdout: "pipe", stderr: "pipe" });
    return { out: said.stdout.toString() + said.stderr.toString(), state };
  };
  const full = run("full", []);
  expect(full.out).toContain("result: completed");
  expect(full.out).not.toContain("pw-dry-run");
  expect(readFileSync(join(full.state, "files/_home_imprnt_.imprnt-hub_registry.toml"))).toEqual(readFileSync(registry));
  expect(readFileSync(join(full.state, "files/_home_imprnt_.imprnt-hub_secrets_hub_runner.password"), "utf8")).toBe("pw-dry-run");
  expect(readFileSync(join(full.state, "calls.log"), "utf8")).not.toContain("pw-dry-run");
  const stopped = run("stopped", ["door-pc is a door"]);
  expect(stopped.out).toContain("plan_problems: door-pc is a door");
  expect(stopped.out).toContain("result: STOPPED: the registry does not yet describe this machine as a spoke");
  expect(stopped.out).not.toContain("password");
}));
