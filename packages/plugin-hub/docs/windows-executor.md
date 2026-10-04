# A Windows PC as an execution machine

A Windows PC runs agents for the household the way the owner's Mac does: one runner and one hub of its own, controlled from the store machine's registry, reaching the one store over the tailnet. It does that **inside a WSL 2 Linux distro made for it**, with systemd running the units and bubblewrap boxing every agent, exactly as on the Pi. There is no native Windows runner and no Windows sandbox: the hub boxes with `bwrap` and `sandbox-exec` and nothing else, and a Windows process is not given an agent to run.

To the registry the PC is a Linux machine (`os = "linux"`). What makes it different is WSL itself, which opens three ways out of Linux that no other Linux host has. Each is a way around the box, so each is closed:

- **Interop.** A WSL process can start a Windows program (`cmd.exe`, `powershell.exe`), which runs as the Windows account outside every namespace. The setup writes `[interop] enabled = false` and `appendWindowsPath = false` into the distro's `/etc/wsl.conf`, `check` reports `wsl-interop-open` while a registration is on, and the box masks `/run/WSL`, where the interop sockets live.
- **The Windows drives.** `C:` at `/mnt/c` is the Windows account's whole profile. The setup writes `[automount] enabled = false`, `check` reports `wsl-windows-mounts` while one is mounted, and the box masks every Windows mount it finds (WSL's own read-only driver share under `/usr/lib/wsl` aside).
- **WSL's shared folders.** `/mnt/wsl` is shared with every other distro of the Windows account, and `/mnt/wslg` and `/tmp/.X11-unix` are WSLg's display. The box masks all of them.

The masks are in `src/os/wsl.ts` and apply only on a host whose kernel names itself WSL; they change nothing on the Pi or the Mac. A mask that would cover a path the launch grants is left out (a tree kept on a Windows drive would otherwise be a box the agent cannot work in), and the supported setup keeps no tree there.

**The distro is the setup's own** (`imprnt-hub`, Debian), never the owner's everyday distro: the `wsl.conf` it writes turns interop off for that distro, and a distro somebody also works in would lose it.

**What the PC runs, and what it does not.** A runner, its hub and optionally a sync. Never a door: a door is one connection per bot token, and a second one for the same Discord or Telegram bot makes the platform drop one of them. Never a board or a recognizer: both listen, and this setup opens no listener. `src/install/spoke.ts` refuses a registry that puts any of them on the PC, before anything is installed.

## 1. On the store machine: describe the PC

Edit the registry on the store machine the way it is always edited (by line, or with the hub's editor). The Mac's procedure in `operations.md` ("A runner on another machine") is the same one; the lines that differ are these. `store_machine` must already be in `[hub]` (it is, once the Mac runs a runner). The address is the store machine's tailnet address, as in the Mac's entry. The machine id is the PC's own name in the registry; the setup's default is `desktop-oscsid6`.

<!-- windows-executor-registry: begin -->
```toml
# The Windows PC. To the hub it is the Linux of its WSL 2 distro `imprnt-hub`,
# account `imprnt`; docs/windows-executor.md says why and what is closed.
[[machines]]
id = "desktop-oscsid6"
os = "linux"
state_dir = "/home/imprnt/.imprnt-hub"
store_url = "postgres://100.64.0.1:5432/hub"
imprnt = "imprnt"

[[run]]
id = "runner-desktop-oscsid6"
kind = "runner"
machine = "desktop-oscsid6"
schedule = "always"
memory_limit_mb = 512
child_memory_limit_mb = 2048

[[run]]
id = "hub-desktop-oscsid6"
kind = "hub"
machine = "desktop-oscsid6"
schedule = "always"
memory_limit_mb = 128
```
<!-- windows-executor-registry: end -->

And on the runner's login credential (the `claude-login` entry its agents' presets name), the PC's own login file, a login made on the PC for this runner and never a copy:

```toml
on = { "desktop-oscsid6" = { file = "/home/imprnt/.imprnt-hub/login/.credentials.json" } }
```

(A credential that already has an `on` table for the Mac gets the PC as a second key in the same table.) Binding an agent to the PC (`runner = "runner-desktop-oscsid6"` on its `[[agents]]` entry) and placing its person's tree and vault there (`on."desktop-oscsid6"` on the `[[people]]` entry, a checkout made on the PC) are the owner's decisions and are not part of the setup: the runner starts with no agents and claims nothing until one is bound.

**The store.** The Mac's steps 1 to 3 admitted the hub roles from `100.64.0.0/10`, the whole tailnet, with a password. A PC on the same tailnet needs nothing more on the store machine. Without those steps, do them first; the setup does not touch the store machine.

Then copy the registry to the PC, for example in PowerShell on the PC: `scp pi:/srv/imprnt-hub/registry.toml $env:USERPROFILE\imprnt-registry.toml`. After every later edit, copy it again and rerun the block: until the PC's copy matches the store machine's byte for byte, its runner claims nothing (`registry-stale`).

## 2. On the PC: the paste block

`tools/windows/executor-setup.ps1` is one self-contained block. Open it, set `$HubRef` (the full commit of the Hub release the household runs, which must contain this setup) and `$CoreVersion` (the imprnt core version on npm), check the other values at the top, and paste the whole block into a normal PowerShell window. It needs WSL 2.4.4 or newer and hardware virtualization; if WSL is missing it says to run `wsl.exe --install --no-distribution` as Administrator and restart, and stops.

It stops with the reason at the first step that cannot be done, and it can be pasted again: every step keeps what is already right (the distro, the passwords, the login, the release) and does the rest.

1. **Windows** (reads only): build, virtualization, WSL version, `.wslconfig`'s networking keys, the Windows Tailscale service. `$PreflightOnly = $true` stops here.
2. **The distro**: `wsl.exe --install Debian --name imprnt-hub --location <dir> --no-launch`, unless it exists.
3. **The account and `/etc/wsl.conf`**: the `imprnt` account; systemd on, interop off, no Windows drives (an existing `wsl.conf` is kept as `wsl.conf.before-imprnt.<time>`). The distro is restarted and systemd must answer `running` or `degraded`.
4. **System packages**: bubblewrap, earlyoom, git, Node, and the Postgres server binaries with `create_main_cluster = false` set first, so no database is made and nothing listens. Lingering is switched on for the account. A trivial `bwrap` box must run, or the setup stops: the hub runs no agent unboxed.
5. **The toolchain, as `imprnt`**: bun at `$BunVersion`, Claude Code at a measured build (`2.1.285` or `2.1.286`; the hub refuses any other at launch), the core with `npm --prefix ~/.local`, and the Hub release cloned at `$HubRef` into `~/imprnt-hub-releases/<commit>`, with `bun install --frozen-lockfile`, registered with `imprnt plugin link hub --global`. A different release already registered is not replaced; the block prints the `--force` command and stops.
6. **The registry**: copied in byte for byte, then `bun src/install/spoke.ts <registry> <machine>` reads what it asks of this machine. Any problem it names stops the setup (the machine missing, a door or a listener placed here, no login placed here, no `store_url` of its own, no `store_machine`).
7. **The role passwords** `hub_runner` and `hub_hub`: pasted at a hidden prompt (`Read-Host -AsSecureString`), sent through stdin and written `0600`. They are never on a command line, in a file on the Windows disk, or in the output. Get them on the store machine with `sudo cat <its secrets_dir>/<role>.password`; the prompt names the directory.
8. **The runner's login**: `claude auth login` with the login directory the registry names (`loginCommand` in `src/adapters/launch.ts`). With interop off nothing can open a browser, so Claude Code prints a URL: open it on the PC, approve, paste the code back. It is a second device on the account, as the Mac's runner is. A login file already there is kept and not refreshed; nothing reads, copies or exports any other login.
9. **The store**: reached from Windows (`Test-NetConnection`) and from the distro, then `imprnt hub registry` (is the copy current) and `imprnt hub check <registry> <machine>`. Before the units are installed, `check` names their absence; that is expected.
10. **The proof turn** (`$RunProofTurn = $true`, paid): `live/prove-engine-runner.ts` drives three short turns through the production door, runner, box and adapter on this runner's own login, in a throwaway Postgres on loopback with the fake platform, then removes it. It writes to no household chat and no household store, so it is not a synthetic message in the household: the spec forbids those. Its verdict is in the summary; the evidence stays under `~/.imprnt-hub/setup/proof` (the replies file is `0600`; do not share it).
11. **The units** (`$InstallServices = $true`, and only when a proof that was asked for passed): `imprnt hub install <registry> services hub-<machine>` writes and starts this machine's systemd user units, and a Windows scheduled task `imprnt-hub-keepalive`, at your logon, keeps one `wsl.exe` session open so the distro stays up. Then `status` and `check` again.
12. **The summary**, between two marked lines: every fact above, the distro's listening sockets, its interop and mount state, every version, the check lines and the proof's verdict. It holds no password, token or login content. Paste it back.

**The acceptance** is the one the spec allows: once an agent is bound to `runner-desktop-oscsid6` and its person's tree is on the PC, a person sends one real message in that agent's chat and reads the answer, as in the Mac's step 9.

## Networking

The runner and the hub only connect out: to the store over the tailnet and to the model API. The PC joins the tailnet with Tailscale on Windows; under WSL's default NAT networking the distro's connections to a `100.x` address leave through Windows. Both reachability probes are in the summary, so "Windows reaches the store and the distro does not" is told apart from "this PC is not on the tailnet".

Nothing the setup installs listens. The proof's throwaway Postgres listens on the distro's loopback for the minutes it runs, as it does on the Mac, and an OpenCode agent's engine listens on loopback with its own password, as everywhere. With WSL's localhost forwarding (on by default) a loopback listener in the distro is reachable from programs on the same PC; it is never reachable from the network under NAT mode. In `mirrored` networking mode, check `listening=` in the summary before binding agents. The setup does not edit `%UserProfile%\.wslconfig`, which is shared by every distro of the account.

## Lifetime

The units are systemd user units with lingering, inside a distro that runs while some `wsl.exe` session holds it: the logon task is that session, so the PC runs agents while you are logged in (a locked screen is fine), like the Mac's login agents. Sleep, hibernation, a logout and a Windows Update restart stop it; the task brings it back at the next logon, and the runner then reconnects and claims what waited. Keep the PC from sleeping if it is to answer at night.

## Undo

Remove the PC's lines from the registry on the store machine and copy it out again. On the PC: `Unregister-ScheduledTask imprnt-hub-keepalive`, then `wsl.exe --unregister imprnt-hub`, which deletes the distro and everything in it, the login and the role passwords included. On the Claude account, the runner's login is a device of its own and can be signed out there.

## Proven, and not

Proven offline, on the Mac, by `test/wsl-host.test.ts` and `test/windows-executor.test.ts`: the WSL view is read from WSL's mount table and binfmt registrations as the code reads them, and the findings fire on it; the rendered Linux box carries the WSL masks on a WSL view and none without one, and leaves out a mask over a granted path; the registry lines above load through the real loader for both machines and render systemd units for the PC; the spoke plan refuses a door, a missing machine, a login not placed on the PC, a store route to the PC itself and a file with no `store_machine`; every embedded shell script is valid for `bash -n`; no PowerShell 7 operator is used (the check fails when one is added); the passwords reach only stdin. With PowerShell 7.4 (in a container, since the Mac has none): the block parses with no error, PSScriptAnalyzer 1.23.0 reports no error (style warnings only), and the dry run in `test/helpers/windows-dry-run` (a stand-in `wsl.exe` that runs nothing, Windows cmdlets stubbed) goes through every step to the summary, delivers the registry byte for byte and the passwords by stdin, stops before any prompt on a plan problem, and prints no secret; the shell scripts it sends pass shellcheck at warning level (SC2174 aside: every parent already exists at `0700`). The dry run is a test that runs wherever `pwsh` is installed and is skipped by name where it is not. `.github/workflows/windows-executor.yml` (started by hand only) parses the block with Windows PowerShell 5.1 and PowerShell 7 on a real Windows and runs its preflight there; GitHub's Windows runners run elevated and have no WSL 2, so that run ends at the block's refusal of an Administrator window. Windows PowerShell 5.1's own argument quoting to `wsl.exe` is exercised only there and on the PC.

**Not proven, because the PC was offline when this was written:** that `wsl.exe --install --name --location --no-launch --web-download` behaves as described on that PC's WSL build; that its WSL kernel lets bubblewrap make a box and delegates the memory controller (`check` says `kernel-memory-cgroup` if not, with the `.wslconfig` fix); that systemd's user manager starts with lingering there; that the interop binfmt registration is gone with `[interop] enabled = false`, and that masking `/run/WSL` stops `/init` from starting a Windows program from inside a box; that the distro reaches the store over the Windows Tailscale route; that `claude auth login` completes headless; that the logon task keeps the distro up and starts hidden; and anything about a real turn on that PC. None of it is claimed until the owner runs the block and the summary says so.
