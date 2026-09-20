// Local Git graphs. No command contacts a network remote.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

export function fixtureGit(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync([
    "git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false",
    "-c", "tag.gpgsign=false", "-c", "user.name=p1",
    "-c", "user.email=p1@example.invalid", ...args,
  ], {
    cwd,
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ALLOW_PROTOCOL: "file",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0) {
    throw new Error(`fixture Git ${args[0]} failed: ${result.stderr.toString()}`)
  }
  return result.stdout.toString().trim()
}

export function localRepository(root: string, id: string) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("invalid fixture repository ID")
  const remote = join(root, `${id}-remote.git`)
  const path = join(root, id)
  const peer = join(root, `${id}-peer`)
  mkdirSync(path, { recursive: true })
  fixtureGit(root, "init", "--bare", "--initial-branch=main", remote)
  fixtureGit(path, "init", "--initial-branch=main")
  writeFileSync(join(path, "base.txt"), "synthetic base\n")
  fixtureGit(path, "add", "base.txt")
  fixtureGit(path, "commit", "-m", "synthetic base")
  fixtureGit(path, "remote", "add", "origin", remote)
  fixtureGit(path, "push", "--set-upstream", "origin", "main")
  fixtureGit(root, "clone", remote, peer)
  return { id, path, peer, remote, branch: "main", required: true }
}
