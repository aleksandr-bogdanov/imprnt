// Relay the installed CLI stream without changing its events.
import { readFileSync } from "node:fs"
export function observedCli(file: string, argv: string[]) {
  return [process.execPath, "-e", `
const {appendFileSync}=require('node:fs');
const child=Bun.spawn(${JSON.stringify(argv)},{stdin:'inherit',stdout:'pipe',stderr:'inherit'});
process.on('SIGTERM',()=>child.kill());
for await(const chunk of child.stdout){appendFileSync(${JSON.stringify(file)},chunk);process.stdout.write(chunk);}
process.exit(await child.exited);
`]
}
export function toolResults(file: string) {
  const events = readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line))
  const blocks = events.flatMap(e => Array.isArray(e.message?.content) ? e.message.content : [])
  return blocks.filter(b => b.type === "tool_use").map(call => ({ call,
    result: blocks.find(b => b.type === "tool_result" && b.tool_use_id === call.id),
  }))
}
