// Runs the checkout's real core dispatch under Node. Test-only Bun preload spies.
import { mkdirSync, symlinkSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { hubPath } from "./cluster.ts"
export async function commandHarness(root: string) {
  const cwd = join(root, `command-${crypto.randomUUID()}`)
  mkdirSync(join(cwd, "plugins"), { recursive: true })
  mkdirSync(join(cwd, "bin"))
  const link = join(cwd, "plugins", "hub")
  symlinkSync(hubPath("."), link)
  const core = join(cwd, "core.mjs")
  const build = await Bun.build({ entrypoints: [hubPath("../imprnt/scripts/cli.ts")], target: "node", format: "esm" })
  if (!build.success) throw new Error(`core fixture build failed: ${build.logs.join("\n")}`)
  await Bun.write(core, build.outputs[0])
  const trace = join(cwd, "calls.jsonl")
  const preload = join(cwd, "preload.ts")
  writeFileSync(trace, "")
  writeFileSync(preload, "")
  // Core launches hub.mjs with Node. Only its Bun child receives this preload.
  writeFileSync(join(cwd, "bin", "bun"), `#!${Bun.which("node")}\nconst {spawn}=require('node:child_process');\nconst c=spawn(${JSON.stringify(process.execPath)},['--preload',${JSON.stringify(preload)},...process.argv.slice(2)],{stdio:'inherit'});\nfor(const s of ['SIGTERM','SIGINT'])process.on(s,()=>c.kill(s));\nc.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exit(code??1)});\n`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${join(cwd, "bin")}:${process.env.PATH}`, IMPRNT_ROOT: cwd }
  const calls = () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  return { cwd, trace, env, core, calls,
    async run(argv: string[], extra: Record<string,string> = {}) {
      writeFileSync(trace, "")
      const child = Bun.spawn([Bun.which("node")!, core, "hub", ...argv], { cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" })
      // Rehearsal commands measured max 544 ms in 12 runs on the Linux box, so 10000 stays. Two SD card stalls took 11 and 34 s.
      const timer = setTimeout(() => child.kill(9), 10000)
      try {
        const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        return { out, err, code, calls: calls() }
      } finally { clearTimeout(timer) }
    },
    // Imports and delegates to the actual library. The spy records real results.
    spy(module: string, exported: string, optionsSource = "{}") {
      const path = module.startsWith("/") ? module : hubPath(module)
      writeFileSync(preload, `import {mock} from 'bun:test';\nimport {appendFileSync} from 'node:fs';\nconst m=await import(${JSON.stringify(path)});\nconst original=m[${JSON.stringify(exported)}];\nmock.module(${JSON.stringify(path)},()=>({...m,[${JSON.stringify(exported)}]:async(...args)=>{\nappendFileSync(${JSON.stringify(trace)},JSON.stringify({phase:'call',name:${JSON.stringify(exported)},args})+'\\n');\nconst result=await original(...(args.length&&typeof args[0]==='object'?[{...args[0],...(${optionsSource})},...args.slice(1)]:args));\nappendFileSync(${JSON.stringify(trace)},JSON.stringify({phase:'result',name:${JSON.stringify(exported)},result})+'\\n');return result}}));\n`)
    },
    replacePlugin(script: string) {
      rmSync(link)
      mkdirSync(link)
      writeFileSync(join(link, "hub.mjs"), script)
    },
    restorePlugin() { rmSync(link, { recursive: true, force: true }); symlinkSync(hubPath("."), link) },
    clearSpy() { writeFileSync(preload, "") },
    stop() { rmSync(cwd, { recursive: true, force: true }) },
  }
}
