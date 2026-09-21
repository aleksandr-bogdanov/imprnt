// One shared zone is one branch of one remote.
//
// Every zone checkout is compared with the zone's remote, and each is synced
// and verified against the branch its own entry names. Two checkouts that name
// different branches of the same remote therefore pass every check while
// neither person ever sees what the other shares. So the loader refuses a zone
// checkout whose branch differs from the first one's, by the line of that key.
//
// PURE: the registry is a file and none of its paths exists.
import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeRegistry, type RegistrySpec, type RepositorySpec } from "./helpers/registry.ts"
import { loadRegistry, RegistryRefused } from "../src/registry/load.ts"

const MOUNT = "shared-notes"
const VAULT: Record<string, string> = { p1: "/srv/hub/p1", p2: "/srv/hub/p2" }

function marked(person: string, branch: string): RepositorySpec {
  return { id: `${person}-zone`, person, path: `${VAULT[person]}/vault/${MOUNT}`, remote: "origin", branch, required: true, zone: true }
}

function household(branches: [string, string]): RegistrySpec {
  return {
    hub: { store_url: "postgres://127.0.0.1:5432/hub", state_dir: "/srv/hub/state" },
    people: [{ id: "p1", tree: VAULT.p1, vault: VAULT.p1 }, { id: "p2", tree: VAULT.p2, vault: VAULT.p2 }],
    zone: { mount: MOUNT, remote: "origin", url: "file:///srv/zone.git" },
    repositories: [marked("p1", branches[0]), marked("p2", branches[1])],
  }
}

let dir: string
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), "hub-zone-branch-")) })
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }) })

test("two zone checkouts on different branches of the one remote are refused by the second one's branch line", () => {
  const file = writeRegistry(dir, household(["main", "other"]))
  let refused: RegistryRefused | null = null
  try { loadRegistry(file) } catch (error) { refused = error as RegistryRefused }
  expect(refused).toBeInstanceOf(RegistryRefused)
  const rows = readFileSync(file, "utf8").split("\n")
  const second = rows.findIndex(line => line.trim() === 'id = "p2-zone"')
  const branch = rows.findIndex((line, at) => at > second && line.trim().startsWith("branch ="))
  expect(refused!.line).toBe(branch + 1)
  expect(refused!.key).toBe("repositories[1].branch")
  expect(refused!.reason).toContain("main")
  expect(refused!.reason).toContain("other")
})

test("zone checkouts that share a branch load, whichever branch that is", () => {
  for (const branch of ["main", "shared"]) {
    const registry = loadRegistry(writeRegistry(dir, household([branch, branch])))
    expect(registry.repositories.filter(one => one.zone).map(one => one.branch)).toEqual([branch, branch])
  }
})
