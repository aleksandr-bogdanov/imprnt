// Evidence validation only. Never executes a cutover action or infers a pass.
import { strict as assert } from "node:assert"
export const policy = {
  "ROLL-01": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "owner-cutover"
    ],
    "forbidden": null,
    "plans": []
  },
  "ROLL-02": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "owner-cutover"
    ],
    "forbidden": null,
    "plans": []
  },
  "ROLL-03": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "live-login/linux",
      "live-login/macos",
      "owner-cutover"
    ],
    "forbidden": null,
    "plans": []
  },
  "ROLL-04": {
    "gates": [
      "automated/linux",
      "automated/macos"
    ],
    "forbidden": "two implementations of a control verb",
    "plans": [
      "06-07"
    ]
  },
  "ROLL-05": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "owner-cutover"
    ],
    "forbidden": null,
    "plans": []
  },
  "ROLL-06": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "live-login/linux",
      "live-login/macos"
    ],
    "forbidden": null,
    "plans": []
  },
  "ROLL-07": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "native/linux",
      "native/macos"
    ],
    "forbidden": null,
    "plans": []
  },
  "ROLL-08": {
    "gates": [
      "automated/linux",
      "automated/macos"
    ],
    "forbidden": "an unchanged permanently refused answer retried forever.",
    "plans": [
      "06-05"
    ]
  },
  "ROLL-09": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "native/linux",
      "native/macos"
    ],
    "forbidden": "an open turn waiting forever on a dead child.",
    "plans": [
      "06-03"
    ]
  },
  "ROLL-10": {
    "gates": [
      "automated/linux",
      "automated/macos"
    ],
    "forbidden": "a finished agent task counted as serving.",
    "plans": [
      "06-03"
    ]
  },
  "ROLL-11": {
    "gates": [
      "automated/linux",
      "automated/macos"
    ],
    "forbidden": "acknowledging an accepted message before its durable write.",
    "plans": [
      "06-04"
    ]
  },
  "ROLL-12": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "native/linux",
      "native/macos",
      "owner-cutover"
    ],
    "forbidden": "a hub that needs an open terminal to keep running.",
    "plans": [
      "06-07"
    ]
  },
  "ROLL-13": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "live-login/linux",
      "live-login/macos"
    ],
    "forbidden": "a copied credential or an undeclared fallback login.",
    "plans": [
      "06-02"
    ]
  },
  "ROLL-14": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "native/linux",
      "native/macos",
      "live-login/linux",
      "live-login/macos",
      "owner-cutover"
    ],
    "forbidden": "an idle on-demand agent holding a model child indefinitely.",
    "plans": [
      "06-03"
    ]
  },
  "ROLL-15": {
    "gates": [
      "automated/linux",
      "automated/macos"
    ],
    "forbidden": "an empty allowlist granting access or a display name granting authority.",
    "plans": [
      "06-04"
    ]
  },
  "ROLL-16": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "native/linux",
      "native/macos"
    ],
    "forbidden": "private chat logs or inbox files outside the enforced person boundary.",
    "plans": [
      "06-02"
    ]
  },
  "ROLL-17": {
    "gates": [
      "automated/linux",
      "automated/macos"
    ],
    "forbidden": "falling back to the hub program for another run kind.",
    "plans": [
      "06-07"
    ]
  },
  "ROLL-18": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "owner-cutover"
    ],
    "forbidden": "old completed instructions replayed as new work or an owed reply silently abandoned.",
    "plans": [
      "06-08"
    ]
  },
  "ROLL-20": {
    "gates": [
      "automated/linux",
      "automated/macos"
    ],
    "forbidden": "a committed message permanently absent from the tail or a reply duplicated in it after restart.",
    "plans": [
      "06-01",
      "06-05"
    ]
  },
  "ROLL-21": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "owner-cutover"
    ],
    "forbidden": "a door declared healthy solely because its process or token is healthy.",
    "plans": [
      "06-05"
    ]
  },
  "ROLL-22": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "native/linux",
      "native/macos"
    ],
    "forbidden": "restarting the asker's unit or healthy sibling agents to recover one agent.",
    "plans": [
      "06-07"
    ]
  },
  "ROLL-23": {
    "gates": [
      "automated/linux",
      "automated/macos"
    ],
    "forbidden": "a routine binding edit waiting on a process restart.",
    "plans": [
      "06-03",
      "06-05"
    ]
  },
  "ROLL-24": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "live-login/linux",
      "live-login/macos"
    ],
    "forbidden": "ambient account configuration silently changing an agent's behavior.",
    "plans": [
      "06-02"
    ]
  },
  "ROLL-25": {
    "gates": [
      "automated/linux",
      "automated/macos"
    ],
    "forbidden": "a local error reported as a household credential outage.",
    "plans": [
      "06-03"
    ]
  },
  "ROLL-26": {
    "gates": [
      "automated/linux",
      "automated/macos"
    ],
    "forbidden": "a skipped-only batch pinning the saved cursor indefinitely.",
    "plans": [
      "06-04"
    ]
  },
  "ROLL-29": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "native/linux",
      "native/macos"
    ],
    "forbidden": "discarding the only diagnostic cause of a failed operation.",
    "plans": [
      "06-07"
    ]
  },
  "ROLL-30": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "live-login/linux",
      "live-login/macos",
      "owner-cutover"
    ],
    "forbidden": "using permission bypass without the person box or giving the harvester write tools.",
    "plans": [
      "06-02",
      "06-08"
    ]
  },
  "ROLL-31": {
    "gates": [
      "automated/linux",
      "automated/macos",
      "owner-cutover"
    ],
    "forbidden": "a sync stamp written when a required repository failed.",
    "plans": [
      "06-06"
    ]
  }
} as const
export const protectedWindows = ["test/door-typing.test.ts", "test/door-outbox.test.ts", "test/door-clock.test.ts", "test/runner-drain.test.ts", "test/wait-idle.test.ts", "test/check-silence.test.ts"] as const
export const deferred = ["ROLL-19", "ROLL-27", "ROLL-28", "ROLL-32"]
export type Evidence = { result: "pass" | "fail" | "skip" | "missing", observed: "pass" | "fail" | "skip" | "missing", record: string, origin: string, facts: Record<string, unknown> }
export type RequirementEvidence = { status: string, evidence: Record<string, Evidence | null>, forbidden: string | null, controls: { plan: string, red: string | null, green: string | null }[] }
export type Manifest = { version: number, status: string, synthetic: boolean, requirements: Record<string, RequirementEvidence>, deferred: string[], windows: Record<string, Record<string, Evidence | null>>, ownerProcedure: string }
const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort())
function passed(e: Evidence | null | undefined) { return e?.result === "pass" && e.observed === "pass" && Boolean(e.record?.trim()) }
export function requirementIssues(id: string, row: RequirementEvidence | undefined): string[] {
  const p = policy[id as keyof typeof policy]
  if (!p || !row) return [`${id}: missing requirement`]
  const issues: string[] = []
  for (const gate of p.gates) {
    const e = row.evidence[gate]
    if (!passed(e)) { issues.push(`${id}: missing passing ${gate} evidence`); continue }
    const origin = gate.split("/")[0]
    if (e!.origin !== origin) issues.push(`${id}: wrong provenance for ${gate}`)
    if (gate.startsWith("live-login/") && e!.facts.declaredLogin !== true) issues.push(`${id}: declared live login not proved`)
    if (gate.startsWith("native/") && e!.facts.os !== gate.split("/")[1]) issues.push(`${id}: native OS mismatch`)
    if (gate === "owner-cutover") {
      const f = e!.facts
      if (f.ownerConfirmed !== true) issues.push(`${id}: owner confirmation absent`)
      if (id === "ROLL-01" && !(f.bothRealDoors === true && f.savedMedia === true && f.fiveStamps === true)) issues.push(`${id}: both real doors and media stamps required`)
      if (id === "ROLL-02" && f.sourceReviewed !== true) issues.push(`${id}: actual source review required`)
      if (id === "ROLL-14" && !(typeof f.peakBytes === "number" && f.peakBytes > 0 && typeof f.budgetBytes === "number" && f.peakBytes <= f.budgetBytes && f.idleRelease === true && f.wake === true)) issues.push(`${id}: measured fleet peak release and wake required`)
      if (id === "ROLL-18" && f.frozenInventoryReconciled !== true) issues.push(`${id}: frozen inventory reconciliation required`)
      if (id === "ROLL-21" && f.realChatReadable !== true) issues.push(`${id}: real chat read preflight required`)
      if (id === "ROLL-05" && !(f.phoneP1 === "human" && f.phoneP2 === "human" && f.registryReviewed === true && f.v2Retired === true)) issues.push(`${id}: real registry retirement and both human phone actions required`)
      if (id === "ROLL-12" && !(f.bootChanged === true && f.operatorLogin === false && f.startedBeforeLogin === true && f.phoneP1 === "human" && f.phoneP2 === "human" && f.v2Disabled === true)) issues.push(`${id}: unattended reboot and both human phone replies required`)
      if (id === "ROLL-30" && !(f.everyImport === true && f.ownWrite === true && f.otherWriteDenied === true && f.mcpReceipt === true && f.harvestWriteDenied === true)) issues.push(`${id}: every imported launch and real tool outcomes required`)
      if (id === "ROLL-31" && !(f.allRequiredRemotes === true && f.freshStamps === true && f.beforeRetirement === true)) issues.push(`${id}: required remote proofs before retirement required`)
      if (id === "ROLL-03" && !(f.fullSecondHistory === true && f.realApply === true && f.watermarkAtBound === true && f.realDemandReport === true && f.ownerHistoryExcluded === true)) issues.push(`${id}: full second-person catch-up and actual demand apply required`)
    }
  }
  if (row.forbidden !== p.forbidden) issues.push(`${id}: Forbidden binding changed`)
  if (!same(row.controls.map(c => c.plan), [...p.plans])) issues.push(`${id}: owning plan control links missing`)
  for (const c of row.controls) if (!c.red || !c.green || c.red === c.green) issues.push(`${id}: ${c.plan} red and green evidence required`)
  return issues
}
export function manifestIssues(m: Manifest): string[] {
  const issues: string[] = []
  if (m.version !== 1) issues.push("manifest version")
  if (!same(Object.keys(m.requirements), Object.keys(policy))) issues.push("all 28 6a requirements required exactly once")
  if (!same(m.deferred, deferred)) issues.push("four 6b requirements must stay deferred")
  for (const id of Object.keys(policy)) issues.push(...requirementIssues(id, m.requirements[id]))
  if (!same(Object.keys(m.windows), [...protectedWindows])) issues.push("six exact protected filenames required")
  for (const file of protectedWindows) for (const os of ["linux", "macos"]) {
    const e = m.windows[file]?.[os]
    if (!passed(e) || e!.origin !== "automated" || e!.facts.unchanged !== true) issues.push(`${file}: unchanged ${os} result required`)
  }
  if (m.ownerProcedure !== "06-CONTEXT.md#d-186-owner-cutover-procedure") issues.push("D-186 verbatim procedure reference required")
  return issues
}
export function serializeAccepted(m: Manifest) {
  const issues = manifestIssues(m)
  if (m.synthetic) issues.push("synthetic evidence cannot close cutover")
  if (issues.length) throw new Error(issues.join("\n"))
  return JSON.stringify({ ...m, status: "accepted" })
}
// A positive validator fixture, never written to the closure document.
export function completeEvidenceFixture(): Manifest {
  const receipt = (gate: string): Evidence => ({ result: "pass", observed: "pass", record: "synthetic-proof", origin: gate.split("/")[0], facts: {
    bothRealDoors:true, savedMedia:true, fiveStamps:true, sourceReviewed:true, peakBytes:1024, budgetBytes:2048, idleRelease:true, wake:true, frozenInventoryReconciled:true, realChatReadable:true,
    declaredLogin: true, os: gate.split("/")[1], ownerConfirmed: true, phoneP1: "human", phoneP2: "human", registryReviewed: true, v2Retired: true,
    bootChanged: true, operatorLogin: false, startedBeforeLogin: true, v2Disabled: true, everyImport: true, ownWrite: true, otherWriteDenied: true, mcpReceipt: true, harvestWriteDenied: true,
    allRequiredRemotes: true, freshStamps: true, beforeRetirement: true, fullSecondHistory: true, realApply: true, watermarkAtBound: true, realDemandReport: true, ownerHistoryExcluded: true, unchanged: true,
  } })
  return { version: 1, status: "open", synthetic: true, requirements: Object.fromEntries(Object.entries(policy).map(([id,p]) => [id, {status:"open", forbidden:p.forbidden, evidence:Object.fromEntries(p.gates.map(g=>[g,receipt(g)])), controls:p.plans.map(plan=>({plan,red:"synthetic-red",green:"synthetic-green"}))}])), deferred:[...deferred], windows:Object.fromEntries(protectedWindows.map(f=>[f,{linux:receipt("automated/linux"),macos:receipt("automated/macos")}])), ownerProcedure:"06-CONTEXT.md#d-186-owner-cutover-procedure" }
}
export function proveEvidenceValidator() {
  const good = completeEvidenceFixture()
  assert.equal(Object.keys(good.requirements).length, 28)
  assert.deepEqual(manifestIssues(good), [])
  assert.throws(() => serializeAccepted(good), /synthetic evidence/)
  // Serialization positive control remains in memory and carries no real claims.
  assert.equal(JSON.parse(serializeAccepted({...good, synthetic:false})).status, "accepted")
  let mutations = 0
  const reject = (change: (m: Manifest) => void) => {
    const bad = structuredClone(good)
    change(bad)
    assert(manifestIssues(bad).length > 0)
    assert.throws(() => serializeAccepted({...bad, synthetic:false}))
    mutations++
  }
  for (const [id,p] of Object.entries(policy)) {
    reject(m => { delete m.requirements[id] })
    for (const gate of p.gates) {
      for (const result of ["skip", "fail", "missing"] as const) reject(m => { m.requirements[id].evidence[gate]!.result = result; m.status = "accepted" })
      reject(m => { m.requirements[id].evidence[gate]!.observed = "skip"; m.requirements[id].evidence[gate]!.result = "pass"; m.status = "accepted" })
      reject(m => { m.requirements[id].evidence[gate] = null })
      reject(m => { m.requirements[id].evidence[gate]!.origin = "test-message" })
      reject(m => { m.requirements[id].evidence[gate]!.record = "" })
    }
    for (const plan of p.plans) reject(m => { m.requirements[id].controls.find(c=>c.plan===plan)!.green=null })
  }
  for (const id of deferred) reject(m => { m.deferred=m.deferred.filter(x=>x!==id) })
  for (const file of protectedWindows) reject(m => { delete m.windows[file] })
  for (const [id, field, value] of [
    ["ROLL-05","phoneP1","test-message"], ["ROLL-05","phoneP2","test-message"],
    ["ROLL-12","operatorLogin",true], ["ROLL-12","startedBeforeLogin",false], ["ROLL-12","bootChanged",false],
    ["ROLL-30","harvestWriteDenied",false], ["ROLL-31","allRequiredRemotes",false], ["ROLL-03","realApply",false],
  ] as const) reject(m=>{m.requirements[id].evidence["owner-cutover"]!.facts[field]=value})
  console.log(`H09 evidence proof: complete in-memory control accepted, ${mutations} defective receipts rejected, synthetic serialization refused`)
}
