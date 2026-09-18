// Child-local transport and module observations. No conversion or harvest policy.
import { writeFileSync } from "node:fs"
import { join } from "node:path"
export function harvestPreload(root: string, module: string, capture: string, refuse: boolean) {
  const file = join(root, `preload-${crypto.randomUUID()}.ts`)
  writeFileSync(file, `import {mock} from 'bun:test'
import {writeFileSync} from 'node:fs'
mock.module(${JSON.stringify(module)},()=>({catchUpHarvest:async(registry,person,from,until)=>{
writeFileSync(${JSON.stringify(capture)},JSON.stringify({person,from,until,store:registry.data.hub.store_url}))
await Bun.sleep(20)
if(${refuse}) throw new Error('synthetic catch-up refusal')
return {slices:[],until}
}}))
`)
  return file
}
export function discordPreload(root: string, capture: string, channels: unknown[]) {
  const file = join(root, `preload-${crypto.randomUUID()}.ts`)
  writeFileSync(file, `import {appendFileSync} from 'node:fs'
globalThis.fetch=async(input,init)=>{
const request=new Request(input,init)
appendFileSync(${JSON.stringify(capture)},JSON.stringify({url:request.url,method:request.method,authorization:request.headers.get('authorization')})+'\\n')
if(request.url!=='https://discord.com/api/v10/guilds/synthetic-guild/channels'||request.method!=='GET') throw new Error('unexpected synthetic transport request')
return Response.json(${JSON.stringify(channels)})
}
`)
  return file
}
