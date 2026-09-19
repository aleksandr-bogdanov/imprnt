// Fixture composition and observation only. Git always uses local remotes.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { stageHub } from "./hub-fixture.ts"
import { fixtureGit, localRepository } from "./rollout-git.ts"
import { hubPath, type Cluster } from "./cluster.ts"
import { loadRegistry } from "../../src/registry/load.ts"
import { listRunEntries } from "../../src/registry/entries.ts"

export async function syncFixture(cluster: Cluster) {
  const machine = process.platform === "darwin" ? "mac" : "pi"
  const id = `sync-${crypto.randomUUID().slice(0, 8)}`
  const f = await stageHub(cluster, {
    machines: [{ id: machine, os: process.platform === "darwin" ? "macos" : "linux" }],
    registry: base => ({ ...base, agents: [], run: [
      { id: `hub-${crypto.randomUUID().slice(0, 8)}`, kind: "hub", machine },
      { id, kind: "sync", machine, schedule: "every 5m", memory_limit_mb: 128 },
    ] }),
  })
  try {
    const root = join(f.stateDir, "repositories")
    mkdirSync(root)
    const p1 = localRepository(root, "p1-vault")
    const p2 = localRepository(root, "p2-vault")
    const shared = localRepository(root, "shared")
    const path = join(p1.path, "shared")
    fixtureGit(root, "clone", shared.remote, path)
    appendFileSync(join(p1.path, ".git", "info", "exclude"), "\n/shared/\n")
    const repos = [{ ...p1, person: "p1", remoteName: "origin" }, { ...p2, person: "p2", remoteName: "origin" }, { ...shared, path, person: "p1", remoteName: "origin" }]
    let base = readFileSync(f.registryFile, "utf8").replace(`id = "${id}"\n`, `id = "${id}"\nrepositories = ["p1-vault", "p2-vault", "shared"]\n`)
    base += repos.slice(0, 2).map(r => `\n[[people]]\nid = "${r.person}"\ntree = ${JSON.stringify(r.path)}\n`).join("")
    const registry = () => {
      writeFileSync(f.registryFile, base + repos.map(r => `\n[[repositories]]\nid = "${r.id}"\nperson = "${r.person}"\npath = ${JSON.stringify(r.path)}\nremote = "${r.remoteName}"\nbranch = "${r.branch}"\nrequired = ${r.required}\n`).join(""))
      return loadRegistry(f.registryFile)
    }
    registry()
    return { ...f, root, repos, id, machine, registry,
      entry: () => listRunEntries(registry()).find(e => e.id === id)!,
      addEntry() {
        const other = `sync-${crypto.randomUUID().slice(0, 8)}`
        base += `\n[[run]]\nid = "${other}"\nkind = "sync"\nmachine = "${machine}"\nschedule = "every 5m"\nmemory_limit_mb = 128\nrepositories = ["p1-vault"]\n`
        registry()
        return other
      },
    }
  } catch (error) { await f.stop(); throw error }
}
export type SyncFixture = Awaited<ReturnType<typeof syncFixture>>

export function commitChange(path: string, file = "local.txt", text = "synthetic local change\n") {
  writeFileSync(join(path, file), text)
  fixtureGit(path, "add", file)
  fixtureGit(path, "commit", "-m", "synthetic change")
  return fixtureGit(path, "rev-parse", "HEAD")
}

export interface GitEvent { pid: number; cwd: string; args: string[]; phase: string; at: number; code?: number }
export function observeGit(root: string) {
  const bin = join(root, `git-bin-${crypto.randomUUID()}`)
  mkdirSync(bin)
  const log = join(bin, "events.jsonl")
  const config = join(bin, "control.json")
  const real = Bun.which("git")!
  if (!real) throw new Error("system Git is required")
  writeFileSync(log, "")
  writeFileSync(config, "{}")
  writeFileSync(join(bin, "git"), `#!${process.execPath}
import {appendFileSync,readFileSync,realpathSync} from 'node:fs';
import {resolve} from 'node:path';
const args=process.argv.slice(2), pid=process.pid;
let cwd=process.cwd();
for(let n=0;n<args.length;n++) if(args[n]==='-C') cwd=resolve(cwd,args[++n]);
cwd=realpathSync(cwd);
const control=JSON.parse(readFileSync(${JSON.stringify(config)},'utf8'));
const verb=args.find(a=>['fetch','rebase','push'].includes(a));
const say=(phase,code)=>appendFileSync(${JSON.stringify(log)},JSON.stringify({pid,cwd,args,phase,code,at:Date.now()})+'\\n');
say('start');
if(verb==='rebase' && control.delay) await Bun.sleep(control.delay);
let code;
if(control.fail && control.fail===verb && (!control.path || cwd===control.path)) { console.error('synthetic '+verb+' refusal'); code=73; }
else if(control.noPush && verb==='push') code=0;
else { const child=Bun.spawn([${JSON.stringify(real)},'-c','core.hooksPath=/dev/null','-c','commit.gpgsign=false','-c','tag.gpgsign=false','-c','user.name=p1','-c','user.email=p1@example.invalid',...args],{stdin:'inherit',stdout:'inherit',stderr:'inherit'}); code=await child.exited; }
say('end',code); process.exit(code);
`, { mode: 0o755 })
  return {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ALLOW_PROTOCOL: "file", GIT_AUTHOR_NAME: "p1", GIT_AUTHOR_EMAIL: "p1@example.invalid", GIT_COMMITTER_NAME: "p1", GIT_COMMITTER_EMAIL: "p1@example.invalid" },
    control(value: { fail?: string; path?: string; noPush?: boolean; delay?: number }) { writeFileSync(config, JSON.stringify(value)) },
    events(): GitEvent[] { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) },
    clear() { writeFileSync(log, "") },
  }
}

// A finite child lifetime also closes the store after an unsuccessful sync.
export async function syncChild(f: SyncFixture, env: Record<string, string | undefined>, id = f.id, argv?: string[]) {
  const proc = Bun.spawn(argv ?? [process.execPath, "-e", `
const {loadRegistry}=await import(${JSON.stringify(hubPath("src/registry/load.ts"))});
const {listRunEntries}=await import(${JSON.stringify(hubPath("src/registry/entries.ts"))});
const {runSync}=await import(${JSON.stringify(hubPath("src/sync/run.ts"))});
const registry=loadRegistry(process.argv[1]);
try { await runSync(listRunEntries(registry).find(e=>e.id===process.argv[2]),registry); process.exit(0); }
catch(e) { console.error(e.message); process.exit(1); }
`, f.registryFile, id], { env, stdout: "pipe", stderr: "pipe" })
  // The rehearsal sync measured max 1329 ms in 12 runs on the Linux box, so 15000 stays. One SD card stall took 10.4 s.
  const timer = setTimeout(() => proc.kill("SIGKILL"), 15000)
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    if (proc.signalCode) throw new Error("sync did not finish within its 15 second acceptance bound")
    return { out, err, code }
  } finally { clearTimeout(timer); if (proc.exitCode === null) { proc.kill(); await proc.exited } }
}

import { systemd } from "../../src/os/systemd.ts"
import { launchd } from "../../src/os/launchd.ts"
import { parsePlistDict } from "./plist.ts"
import type { UnitFile } from "../../src/os/types.ts"
export function scheduledArgv(files: UnitFile[], flavour: "systemd" | "launchd"): string[] {
  if (flavour === "launchd") return parsePlistDict(files.find(f => f.path.endsWith(".plist"))!.text).ProgramArguments as string[]
  const command = /^ExecStart=(.+)$/m.exec(files.find(f => f.path.endsWith(".service"))!.text)![1]
  return (command.match(/"(?:\\.|[^"\\])*"|\S+/g) ?? []).map(s => s.startsWith('"') ? JSON.parse(s) : s)
}

// The fake manager records activation. It never forwards a native command.
// fire() represents one timer firing and executes the installed argv verbatim.
export function scheduleProbe(f: SyncFixture, flavour: "systemd" | "launchd") {
  const dir = join(f.stateDir, `units-${flavour}`)
  mkdirSync(dir)
  const log = join(dir, "manager.jsonl")
  const bin = join(dir, "manager")
  writeFileSync(log, "")
  writeFileSync(bin, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(log)},JSON.stringify(process.argv.slice(2))+'\\n');\n`, { mode: 0o755 })
  const os = flavour === "systemd" ? systemd({ unitDir: dir, bin }) : launchd({ unitDir: dir, bin })
  return {
    os,
    calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as string[]),
    async fire(files: UnitFile[], env: Record<string, string | undefined>) {
      // Read what install wrote, not the caller's potentially different text.
      const installed = files.map(file => ({ ...file, text: readFileSync(file.path, "utf8") }))
      return syncChild(f, env, f.id, scheduledArgv(installed, flavour))
    },
  }
}

// Observe transaction identity without replacing either production writer.
export async function auditSyncWrites(f: SyncFixture) {
    await f.read.sql(`create table sync_audit (sheet text, transaction_id bigint, data jsonb)`)
    await f.read.sql(`create function audit_sync() returns trigger language plpgsql as $$ begin
      if NEW.sheet in ('sync', 'job_success') then
        insert into sync_audit values (NEW.sheet, txid_current(), NEW.data);
      end if; return NEW; end $$`)
    await f.read.sql(`create trigger sync_audit_trigger after insert or update on state_row for each row execute function audit_sync()`)
    await f.read.sql(`grant insert on sync_audit to hub_hub`)
}
