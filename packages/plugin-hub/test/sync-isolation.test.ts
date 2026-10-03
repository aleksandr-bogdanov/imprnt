import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startCluster, type Cluster } from "./helpers/cluster.ts";
import { syncFixture } from "./helpers/rollout-sync.ts";
import { fixtureGit } from "./helpers/rollout-git.ts";
import { listRepositories } from "../src/registry/entries.ts";
import { inSyncIsolation, isolatedGit, grantSyncRemotes } from "../src/sync/isolation.ts";
import { runSync } from "../src/sync/run.ts";

let cluster: Cluster;
beforeAll(async () => { cluster = await startCluster(); });
afterAll(async () => { await cluster?.stop(); });

async function git(path: string, args: string[], input?: string) {
  const boxed = isolatedGit(["-C", path, "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args]);
  const child = Bun.spawn(boxed.argv, { env: boxed.env, stdin: input === undefined ? "ignore" : new Blob([input]), stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { out, err, code };
}
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

test("a filter planted AFTER config preflight runs only inside the sync boundary; unboxed control escapes", async () => {
  const f = await syncFixture(cluster);
  try {
    const registry = f.registry();
    const repo = listRepositories(registry)[0];
    const ran = join(repo.path, "filter-ran");
    const outside = join(f.root, "outside-marker");
    const secret = join(f.root, "outside-secret");
    const stolen = join(repo.path, "stolen");
    writeFileSync(secret, "synthetic-other-person-secret\n");
    writeFileSync(join(repo.path, ".gitattributes"), "*.txt filter=race\n");
    writeFileSync(join(repo.path, "race.txt"), "new content\n");
    const program = `printf ran > ${quote(ran)}; printf escaped > ${quote(outside)}; if read value < ${quote(secret)}; then printf '%s' "$value" > ${quote(stolen)}; fi; cat`;
    await inSyncIsolation(registry, repo, async () => {
      const before = await git(repo.path, ["config", "--list", "--name-only"]);
      expect(before.code, before.err).toBe(0);
      expect(before.out).not.toContain("filter.race.clean");
      // Deterministic concurrent writer: the check finished, but Git has not started its add yet.
      fixtureGit(repo.path, "config", "filter.race.clean", program);
      const added = await git(repo.path, ["add", "race.txt"]);
      expect(added.code, added.err).toBe(0);
      expect(readFileSync(ran, "utf8")).toBe("ran");
      expect(existsSync(outside)).toBe(false);
      expect(existsSync(stolen)).toBe(false);
    });
    // The same payload really has host authority without the new boundary.
    writeFileSync(join(repo.path, "race.txt"), "another change\n");
    fixtureGit(repo.path, "add", "race.txt");
    expect(readFileSync(outside, "utf8")).toBe("escaped");
    expect(readFileSync(stolen, "utf8")).toBe("synthetic-other-person-secret");
  } finally { await f.stop(); }
});

test("ordinary sync commits uncommitted notes and reaches its approved local bare destinations", async () => {
  const f = await syncFixture(cluster);
  try {
    for (const repo of f.repos) writeFileSync(join(repo.path, "sync-note.md"), "a legitimate note\n");
    await runSync(f.entry(), f.registry());
    for (const repo of f.repos) {
      expect(fixtureGit(f.root, "--git-dir", repo.remote, "show", "main:sync-note.md")).toBe("a legitimate note");
      expect(fixtureGit(repo.path, "rev-parse", "refs/remotes/origin/main")).toBe(fixtureGit(repo.path, "rev-parse", "HEAD"));
    }
  } finally { await f.stop(); }
});

test("explicit credential helper and key remain usable; undeclared auth and inherited secrets do not enter", async () => {
  const f = await syncFixture(cluster);
  const prior = process.env.HUB_SYNTHETIC_SECRET;
  try {
    const registry = f.registry();
    const repo = listRepositories(registry)[0];
    const auth = join(f.root, "auth"); mkdirSync(auth);
    const key = join(auth, "key");
    const config = join(auth, ".gitconfig");
    writeFileSync(key, "username=synthetic\npassword=synthetic-key\n");
    writeFileSync(config, `[credential]\n helper = !cat ${quote(key)}\n`);
    process.env.HUB_SYNTHETIC_SECRET = "never-in-child";
    await inSyncIsolation(registry, { ...repo, sync_read_paths: [config, key] }, async () => {
      const credentials = await git(repo.path, ["credential", "fill"], "protocol=https\nhost=fixture.invalid\n\n");
      expect(credentials.code, credentials.err).toBe(0);
      expect(credentials.out).toContain("password=synthetic-key");
      expect(isolatedGit([]).env.HUB_SYNTHETIC_SECRET).toBeUndefined();
      expect(isolatedGit([]).env.SSH_AUTH_SOCK).toBeUndefined();
    });
    await inSyncIsolation(registry, repo, async () => {
      const credentials = await git(repo.path, ["credential", "fill"], "protocol=https\nhost=fixture.invalid\n\n");
      expect(credentials.code).not.toBe(0);
      expect(credentials.out).not.toContain("synthetic-key");
    });
  } finally {
    if (prior === undefined) delete process.env.HUB_SYNTHETIC_SECRET; else process.env.HUB_SYNTHETIC_SECRET = prior;
    await f.stop();
  }
});

test("repository URLs cannot enlarge owner-declared local remote capabilities", async () => {
  const f = await syncFixture(cluster);
  try {
    const registry=f.registry(), repo=listRepositories(registry)[0];
    const privateDir=join(f.root,"undeclared-private"); mkdirSync(privateDir);
    const secret=join(privateDir,"secret"), marker=join(privateDir,"marker"), stolen=join(repo.path,"stolen");
    writeFileSync(secret,"synthetic-private-data");
    await inSyncIsolation(registry,repo,async()=>{
      expect(()=>grantSyncRemotes(realpathSync(f.repos[0].remote),[realpathSync(privateDir)])).toThrow();
      expect(()=>grantSyncRemotes(realpathSync(privateDir),[])).toThrow();
      // A rejected URL never leaves a partial grant behind for a raced filter.
      fixtureGit(repo.path,"config","filter.race.clean",`printf escaped > ${quote(marker)}; cat ${quote(secret)} > ${quote(stolen)}; cat`);
      writeFileSync(join(repo.path,".gitattributes"),"*.txt filter=race\n"); writeFileSync(join(repo.path,"race.txt"),"content\n");
      const added=await git(repo.path,["add","race.txt"]); expect(added.code,added.err).toBe(0);
      expect(existsSync(marker)).toBe(false); expect(readFileSync(stolen,"utf8")).toBe("");
    });
    fixtureGit(repo.path,"config","--remove-section","filter.race");
    fixtureGit(repo.path,"remote","set-url","--push","origin",privateDir);
    const before=fixtureGit(repo.path,"rev-parse","HEAD");
    await expect(runSync(f.entry(),f.registry())).rejects.toThrow();
    expect(fixtureGit(repo.path,"rev-parse","HEAD")).toBe(before);
  } finally {await f.stop();}
});

test("root read grants are refused and Mac toolchain access excludes Homebrew private var", async () => {
  const f=await syncFixture(cluster);
  try {
    const registry=f.registry(), repo=listRepositories(registry)[0];
    await expect(inSyncIsolation(registry,{...repo,sync_read_paths:["/"]},async()=>{})).rejects.toThrow();
    if(process.platform==="darwin") await inSyncIsolation(registry,repo,async()=>{
      const profile=isolatedGit([]).argv[2];
      expect(profile).not.toContain('(allow file-read* (subpath "/opt/homebrew"))');
      if(existsSync("/opt/homebrew/var")) expect(profile).toContain('(deny file-read* file-write* (subpath "/opt/homebrew/var"))');
    });
  } finally {await f.stop();}
});


test("Mac sync permits only the measured SSH account lookup service", async () => {
  if (process.platform !== "darwin") return;
  const f = await syncFixture(cluster);
  try {
    const registry = f.registry(), repo = listRepositories(registry)[0];
    await inSyncIsolation(registry, repo, async () => {
      const boxed = isolatedGit([]), profile = boxed.argv[2];
      const grant = '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))';
      expect(profile.split("\n").filter(line => line.includes("mach-lookup"))).toEqual([grant]);
      expect(profile).toContain("(deny job-creation)");
      expect(profile).toContain('(allow network-outbound (literal "/private/var/run/mDNSResponder"))');
      if (existsSync("/opt/homebrew/etc/ca-certificates")) expect(profile).toContain('(allow file-read* (subpath "/opt/homebrew/etc/ca-certificates"))');
      const initialize = async (policy: string) => {
        const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", policy, "/usr/bin/ssh", "-F", "/dev/null", "-G", "fixture.invalid"],
          { env: boxed.env, stdout: "ignore", stderr: "pipe" });
        const error = await new Response(child.stderr).text();
        return { code: await child.exited, error };
      };
      // -G evaluates configuration locally; it never connects or reads a private key.
      expect((await initialize(profile)).code).toBe(0);
      const denied = await initialize(profile.replace(grant, ""));
      expect(denied.code).not.toBe(0);
      expect(denied.error).toContain("No user exists for uid");
    });
  } finally { await f.stop(); }
});
