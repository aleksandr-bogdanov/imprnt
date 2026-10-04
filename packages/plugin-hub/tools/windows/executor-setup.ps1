# ==== imprnt hub: a Windows PC as an execution machine (runner + hub in a WSL2 distro of its own) ====
#
# Paste this WHOLE block into a normal (not Administrator) Windows PowerShell window on the PC, after
# editing the values in section 1. The procedure, the registry lines it expects and what it does not do
# are in packages/plugin-hub/docs/windows-executor.md.
#
# What it does, in order, stopping with the reason at the first step that cannot be done:
#   1. checks Windows, virtualization and WSL 2 (reads only)
#   2. makes a Debian WSL distro of its own (never your everyday one), with systemd on, Windows interop
#      off and the Windows drives unmounted: both are ways around the agents' box
#   3. installs the pinned toolchain inside it: bubblewrap, earlyoom, git, Node, Postgres binaries (no
#      database cluster, nothing listening), bun, Claude Code, the imprnt core and the Hub release you name
#   4. copies your registry file in byte for byte and checks it describes this machine as a spoke
#   5. asks you to paste the two store role passwords (never shown, never on a command line)
#   6. logs the runner in, once, with a login of its own (it prints a URL you open on this PC)
#   7. `imprnt hub check` against the household store, stopping if interop or a Windows drive is still
#      open; optionally one paid proof turn in a throwaway store; optionally this machine's units
#      (runner + hub) and a logon task that keeps the distro up, only after a proof that was asked for passed
#   8. prints a summary to paste back. No secret is ever printed.
# Nothing here copies, exports or refreshes any existing login, opens a listener, or touches the Pi.

& {
  # ---- 1. Your values. Edit these before pasting. ----
  $MachineId       = 'desktop-oscsid6'   # the [[machines]] id you added to the store machine's registry
  $Distro          = 'imprnt-hub'        # the WSL distro this creates; never an existing everyday distro
  $LinuxUser       = 'imprnt'            # the Linux account the units run as (state_dir lives in its home)
  $DistroLocation  = "$env:LOCALAPPDATA\imprnt-hub\wsl"
  $RegistryFile    = "$env:USERPROFILE\imprnt-registry.toml"  # a byte-exact copy of the store machine's registry
  $HubRepo         = 'https://github.com/aleksandr-bogdanov/imprnt.git'
  $HubRef          = ''                  # REQUIRED: the full 40-character commit the household's Hub release is
  $CoreVersion     = ''                  # REQUIRED: the imprnt core version on npm (`imprnt --version` on the Pi)
  $ClaudeVersion   = '2.1.286'           # a measured build only: 2.1.285 or 2.1.286
  $BunVersion      = '1.3.14'
  $RunProofTurn    = $false              # $true: one paid proof (three short turns) on this runner's own login
  $ProofModel      = 'claude-haiku-4-5-20251001'
  $InstallServices = $false              # $true: install and start this machine's units after the checks pass
  $PreflightOnly   = $false              # $true: step 1 only, change nothing

  # ---- the machinery; nothing below needs editing ----
  $ErrorActionPreference = 'Stop'
  Set-StrictMode -Version 2.0
  $savedWslUtf8 = $env:WSL_UTF8
  $env:WSL_UTF8 = '1'
  $savedOutputEncoding = [Console]::OutputEncoding
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $Summary = [ordered]@{ setup = 'imprnt-windows-executor/1'; machine = $MachineId; distro = $Distro; started = (Get-Date).ToUniversalTime().ToString('s') + 'Z' }
  $Stopped = $null
  $Attention = @()

  function Say([string]$Text) { Write-Host "[imprnt] $Text" -ForegroundColor Cyan }
  function Stop-Setup([string]$Why) { throw "IMPRNT-STOP: $Why" }
  function Note([string]$Key, $Value) { $Summary[$Key] = "$Value" }

  # One bash script, as a user of the distro, with the console attached so its progress and any prompt
  # reach you. The script travels base64-encoded as one argument, so nothing in it is reinterpreted by
  # Windows argument quoting; it carries no secret.
  function Invoke-Linux([string]$User, [string]$Script, [switch]$Capture) {
    $prelude = "set -euo pipefail`nHOME=`$(getent passwd `"`$(id -un)`" | cut -d: -f6)`nexport HOME`ncd `"`$HOME`"`nXDG_RUNTIME_DIR=/run/user/`$(id -u)`n" +
      "export PATH=`"`$HOME/.local/bin:`$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin`" XDG_RUNTIME_DIR DISABLE_AUTOUPDATER=1 BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING=1`n" +
      "export DBUS_SESSION_BUS_ADDRESS=unix:path=`$XDG_RUNTIME_DIR/bus`n"
    $text = ($prelude + $Script) -replace "`r", ''
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
    if ($Capture) {
      $out = & wsl.exe --distribution $Distro --user $User --cd '~' --exec /bin/bash -c 'source <(printf %s $1 | base64 -d)' bash $b64
      return @{ Code = $LASTEXITCODE; Lines = @($out) }
    }
    # To the console, not into this function's return value, which is the exit code alone.
    & wsl.exe --distribution $Distro --user $User --cd '~' --exec /bin/bash -c 'source <(printf %s $1 | base64 -d)' bash $b64 | Out-Host
    return @{ Code = $LASTEXITCODE; Lines = @() }
  }

  # Bytes into a file of the distro through stdin, base64 so nothing is re-encoded on the way, written
  # 0600 under umask 077 and moved into place whole. Used for the registry and the role passwords.
  function Send-LinuxFile([string]$User, [byte[]]$Bytes, [string]$Path) {
    $b64 = [Convert]::ToBase64String($Bytes)
    $b64 | & wsl.exe --distribution $Distro --user $User --cd '~' --exec /bin/sh -c 'umask 077 && tr -d ''\015\012'' | base64 -d > $1.part && mv -f $1.part $1' sh $Path | Out-Host
    if ($LASTEXITCODE -ne 0) { Stop-Setup "could not write $Path in $Distro" }
  }

  # A path or name from the registry goes into a Linux command line only when it is this plain.
  function Assert-Plain([string]$What, [string]$Value) {
    if ($Value -notmatch '^[A-Za-z0-9._/@:+-]+$') { Stop-Setup "$What is '$Value', and this setup only uses plain paths and names (letters, digits, . _ / @ : + -)" }
  }

  function Get-WslLines([string[]]$Arguments) {
    $out = & wsl.exe @Arguments
    return @($out | ForEach-Object { ($_ -replace "`0", '').TrimEnd() } | Where-Object { $_ -ne '' })
  }

  try {
    # ---- step 1: Windows, virtualization, WSL (reads only) ----
    Say 'step 1: checking Windows, virtualization and WSL'
    foreach ($pair in @(@('MachineId', $MachineId, '^[a-z0-9][a-z0-9-]{0,62}$'), @('Distro', $Distro, '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'),
                        @('LinuxUser', $LinuxUser, '^[a-z_][a-z0-9_-]{0,30}$'), @('ClaudeVersion', $ClaudeVersion, '^2\.1\.28[56]$'),
                        @('BunVersion', $BunVersion, '^\d+\.\d+\.\d+$'), @('ProofModel', $ProofModel, '^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$'),
                        @('HubRepo', $HubRepo, '^https://[A-Za-z0-9./_-]+\.git$'))) {
      if ($pair[1] -notmatch $pair[2]) { Stop-Setup "$($pair[0]) is '$($pair[1])', which is not $($pair[2])" }
    }
    if (-not $PreflightOnly) {
      if ($HubRef -notmatch '^[0-9a-f]{40}$') { Stop-Setup 'HubRef is required: the full 40-character commit of the Hub release the household runs' }
      if ($CoreVersion -notmatch '^\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$') { Stop-Setup 'CoreVersion is required: the imprnt core version on npm, as `imprnt --version` prints it on the store machine' }
      if (-not (Test-Path -LiteralPath $RegistryFile -PathType Leaf)) { Stop-Setup "RegistryFile $RegistryFile is not a file: copy the store machine's registry here first (scp pi:/srv/imprnt-hub/registry.toml `"$RegistryFile`")" }
    }
    $os = Get-CimInstance Win32_OperatingSystem
    Note 'windows' "$($os.Caption) $($os.Version) build $($os.BuildNumber)"
    Note 'powershell' $PSVersionTable.PSVersion.ToString()
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      Stop-Setup 'this window runs as Administrator: open a normal PowerShell window, so the distro and the logon task belong to your own account'
    }
    if ([int]$os.BuildNumber -lt 19044) { Stop-Setup "Windows build $($os.BuildNumber) is older than 19044 (Windows 10 21H2), the oldest that runs WSL 2 with systemd" }
    $cs = Get-CimInstance Win32_ComputerSystem
    $cpu = @(Get-CimInstance Win32_Processor)[0]
    Note 'virtualization' "hypervisor_present=$($cs.HypervisorPresent) firmware_enabled=$($cpu.VirtualizationFirmwareEnabled)"
    if (-not $cs.HypervisorPresent -and -not $cpu.VirtualizationFirmwareEnabled) {
      Stop-Setup 'hardware virtualization is off: switch on Intel VT-x / AMD-V (SVM) in the PC firmware, then run this again'
    }
    if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
      Stop-Setup 'WSL is not installed: in an Administrator PowerShell run `wsl.exe --install --no-distribution`, restart the PC, then paste this block again'
    }
    $wslVersion = Get-WslLines @('--version')
    if ($LASTEXITCODE -ne 0 -or $wslVersion.Count -eq 0) {
      Stop-Setup 'this WSL is the old built-in one: run `wsl.exe --update` (or install WSL from the Microsoft Store), then paste this block again'
    }
    $found = [regex]::Match($wslVersion[0], '(\d+)\.(\d+)\.(\d+)')
    Note 'wsl' $wslVersion[0]
    if (-not $found.Success) { Stop-Setup "cannot read the WSL version from '$($wslVersion[0])'" }
    $wv = [version]("{0}.{1}.{2}" -f $found.Groups[1].Value, $found.Groups[2].Value, $found.Groups[3].Value)
    if ($wv -lt [version]'2.4.4') { Stop-Setup "WSL $wv cannot name a new distro: run `wsl.exe --update` (2.4.4 or newer), then paste this block again" }
    $wslConfig = Join-Path $env:USERPROFILE '.wslconfig'
    if (Test-Path -LiteralPath $wslConfig) {
      $modes = @(Select-String -LiteralPath $wslConfig -Pattern '^\s*(networkingMode|localhostForwarding|guiApplications|kernelCommandLine|kernel)\s*=' | ForEach-Object { $_.Line.Trim() })
      Note 'wslconfig' ($(if ($modes.Count) { $modes -join '; ' } else { 'present, no networking keys' }))
    } else { Note 'wslconfig' 'absent (NAT networking, localhost forwarding on)' }
    $tailscale = Get-Service -Name 'Tailscale' -ErrorAction SilentlyContinue
    Note 'tailscale_service' ($(if ($tailscale) { $tailscale.Status } else { 'not installed on Windows' }))
    if ($PreflightOnly) { Stop-Setup 'preflight only, as asked: nothing was changed' }

    # ---- step 2: the distro of its own ----
    Say "step 2: the WSL distro $Distro"
    $distros = Get-WslLines @('--list', '--quiet')
    if ($distros -notcontains $Distro) {
      New-Item -ItemType Directory -Force -Path $DistroLocation | Out-Null
      & wsl.exe --install Debian --name $Distro --location $DistroLocation --no-launch --web-download
      if ($LASTEXITCODE -ne 0) { Stop-Setup "wsl.exe --install Debian --name $Distro failed (exit $LASTEXITCODE); if it did not know --name or --location, run wsl.exe --update" }
      $distros = Get-WslLines @('--list', '--quiet')
      if ($distros -notcontains $Distro) { Stop-Setup "$Distro is not listed after the install" }
      Note 'distro_created' 'now'
    } else { Note 'distro_created' 'already there, reused' }
    $row = Get-WslLines @('--list', '--verbose') | Where-Object { ($_.Trim() -replace '^\*\s*', '') -match "^$([regex]::Escape($Distro))\s" } | Select-Object -First 1
    if (-not $row -or $row.Trim() -notmatch '\s2$') { Stop-Setup "$Distro is not a WSL 2 distro ($row): run wsl.exe --set-version $Distro 2" }

    # ---- step 3: the account, systemd on, interop off, Windows drives unmounted ----
    Say 'step 3: the runner account and /etc/wsl.conf (systemd on, interop off, no Windows drives)'
    $base = @'
id -u __USER__ >/dev/null 2>&1 || useradd --create-home --shell /bin/bash __USER__
cat > /etc/wsl.conf.imprnt <<'CONF'
# Written by the imprnt hub Windows setup (docs/windows-executor.md). This distro runs the
# household's runner. Interop and the Windows drives are ways around the agents' box: keep both off.
[boot]
systemd = true

[user]
default = __USER__

[interop]
enabled = false
appendWindowsPath = false

[automount]
enabled = false
mountFsTab = false
CONF
if ! cmp -s /etc/wsl.conf.imprnt /etc/wsl.conf; then
  [ -e /etc/wsl.conf ] && cp -p /etc/wsl.conf "/etc/wsl.conf.before-imprnt.$(date +%s)"
  mv -f /etc/wsl.conf.imprnt /etc/wsl.conf
  echo "wsl.conf written"
else
  rm -f /etc/wsl.conf.imprnt
fi
'@
    $r = Invoke-Linux 'root' ($base -replace '__USER__', $LinuxUser)
    if ($r.Code -ne 0) { Stop-Setup "the account or /etc/wsl.conf could not be written (exit $($r.Code))" }
    & wsl.exe --terminate $Distro | Out-Null
    Start-Sleep -Seconds 3
    $boot = @'
pid1=$(cat /proc/1/comm)
[ "$pid1" = systemd ] || { echo "PID 1 is $pid1, not systemd"; exit 3; }
state=$(timeout 180 systemctl is-system-running --wait 2>/dev/null || true)
echo "systemd: $state"
case "$state" in running|degraded) ;; *) exit 4 ;; esac
'@
    $r = Invoke-Linux 'root' $boot
    if ($r.Code -ne 0) { Stop-Setup "systemd did not come up in $Distro (exit $($r.Code)); /etc/wsl.conf must say [boot] systemd = true" }

    # ---- step 3b: system packages, lingering, earlyoom, the box tool ----
    Say 'step 3b: system packages (bubblewrap, earlyoom, git, Node, Postgres binaries with no cluster)'
    $packages = @'
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q --no-install-recommends postgresql-common
# The proof turn starts its own throwaway cluster on loopback. No standing database is made here,
# so nothing listens: the default cluster is switched off BEFORE the server package is installed.
conf=/etc/postgresql-common/createcluster.conf
if grep -Eq '^[#[:space:]]*create_main_cluster' "$conf"; then
  sed -i -E 's/^[#[:space:]]*create_main_cluster.*/create_main_cluster = false/' "$conf"
else
  echo 'create_main_cluster = false' >> "$conf"
fi
apt-get install -y -q --no-install-recommends ca-certificates curl git unzip bubblewrap earlyoom nodejs npm postgresql procps iproute2
loginctl enable-linger __USER__
systemctl enable --now earlyoom >/dev/null
bus="/run/user/$(id -u __USER__)/bus"
for _ in $(seq 1 30); do [ -S "$bus" ] && break; sleep 1; done
[ -S "$bus" ] || { echo "the user manager of __USER__ did not start"; exit 5; }
'@
    $r = Invoke-Linux 'root' ($packages -replace '__USER__', $LinuxUser)
    if ($r.Code -ne 0) { Stop-Setup "system packages failed (exit $($r.Code))" }
    $probe = @'
/usr/bin/bwrap --unshare-pid --die-with-parent --ro-bind / / --dev /dev --proc /proc /bin/true
echo "bwrap box: ok"
'@
    $r = Invoke-Linux $LinuxUser $probe
    if ($r.Code -ne 0) { Stop-Setup "bubblewrap cannot make a box in $Distro (exit $($r.Code)): the hub runs no agent unboxed, so this machine cannot run one" }

    # ---- step 3c: the pinned toolchain and the Hub release, as the runner account ----
    Say "step 3c: bun $BunVersion, Claude Code $ClaudeVersion, imprnt $CoreVersion, Hub $HubRef"
    $tools = @'
mkdir -p -m 700 "$HOME/.imprnt-hub" "$HOME/.imprnt-hub/setup"
if [ "$("$HOME/.bun/bin/bun" --version 2>/dev/null || true)" != "__BUN__" ]; then
  curl -fsSL https://bun.sh/install -o /tmp/imprnt-bun-install.sh
  bash /tmp/imprnt-bun-install.sh "bun-v__BUN__"
fi
# Claude Code at the measured build. Auto-update is off for every call this setup makes, and the
# hub's own launches turn it off too; an update takes every agent on this machine offline.
if ! "$HOME/.local/bin/claude" --version 2>/dev/null | grep -q '^__CLAUDE__ '; then
  curl -fsSL https://claude.ai/install.sh -o /tmp/imprnt-claude-install.sh
  bash /tmp/imprnt-claude-install.sh "__CLAUDE__"
fi
"$HOME/.local/bin/claude" --version | grep -q '^__CLAUDE__ ' || { echo "claude is not __CLAUDE__"; exit 6; }
npm install --global --prefix "$HOME/.local" --no-fund --no-audit "imprnt@__CORE__"
release="$HOME/imprnt-hub-releases/__REF__"
if [ ! -d "$release/.git" ]; then
  rm -rf "$release.part"
  git clone --quiet --filter=blob:none "__REPO__" "$release.part"
  git -C "$release.part" -c advice.detachedHead=false checkout --quiet --detach "__REF__"
  mv "$release.part" "$release"
fi
[ "$(git -C "$release" rev-parse HEAD)" = "__REF__" ] || { echo "the release is not at __REF__"; exit 7; }
[ -z "$(git -C "$release" status --porcelain --untracked-files=no)" ] || { echo "the release directory was edited"; exit 7; }
[ -f "$release/packages/plugin-hub/src/install/spoke.ts" ] || { echo "__REF__ has no Windows executor support (src/install/spoke.ts)"; exit 7; }
(cd "$release" && "$HOME/.bun/bin/bun" install --frozen-lockfile)
# A core that cannot register a global command would fail the link below for that reason, not
# because another release is registered. Asked of its own help text, never assumed.
said=$(imprnt help 2>&1 || true)
case "$said" in
  *"plugin link <name> --global"*) ;;
  *) echo "imprnt __CORE__ cannot register a global command (imprnt plugin link --global): name a published core release that can"; exit 9 ;;
esac
if ! linked=$(imprnt plugin link hub --global --from "$release/packages/plugin-hub" 2>&1); then
  printf '%s\n' "$linked"
  case "$linked" in
    *"already linked to"*)
      echo "another Hub release is registered for imprnt hub. To replace it on purpose:"
      echo "  imprnt plugin link hub --global --from $release/packages/plugin-hub --force"
      exit 8 ;;
  esac
  exit 10
fi
printf '%s\n' "$linked"
'@
    $tools = $tools -replace '__BUN__', $BunVersion -replace '__CLAUDE__', $ClaudeVersion -replace '__CORE__', $CoreVersion -replace '__REF__', $HubRef -replace '__REPO__', $HubRepo
    $r = Invoke-Linux $LinuxUser $tools
    if ($r.Code -eq 9) { Stop-Setup "imprnt $CoreVersion cannot register a global command (imprnt plugin link --global): a published core release that can is a prerequisite of this setup; set CoreVersion to one" }
    if ($r.Code -eq 8) { Stop-Setup 'another Hub release is registered for imprnt hub; the lines above give the command that replaces it on purpose' }
    if ($r.Code -eq 10) { Stop-Setup 'imprnt plugin link hub --global failed; the lines above say why' }
    if ($r.Code -ne 0) { Stop-Setup "the toolchain or the Hub release could not be installed (exit $($r.Code))" }
    $release = "/home/$LinuxUser/imprnt-hub-releases/$HubRef"
    $hubDir = "$release/packages/plugin-hub"

    # ---- step 3d: the hub's own box, with this distro's WSL masks, resolves a name ----
    # The bare bwrap box above has no masks. An agent's box empties WSL's shared folder, which is
    # where WSL keeps the name server's file by default; a box that resolves nothing fails every turn.
    Say "step 3d: the hub's own box, with this distro's WSL masks, resolves a name"
    $r = Invoke-Linux $LinuxUser "cd $hubDir && bun tools/windows/box-probe.ts api.anthropic.com" -Capture
    $r.Lines | ForEach-Object { Write-Host "  $_" }
    Note 'box_probe' ($r.Lines -join ' ')
    if ($r.Code -ne 0 -or (($r.Lines -join ' ') -notmatch '^box: ok')) { Stop-Setup "the hub's box on $Distro does not work as an agent needs it (exit $($r.Code)); the line above says why" }

    # ---- step 4: the registry, and what it asks of this machine ----
    Say 'step 4: the registry copy and the plan for this machine'
    $registry = "/home/$LinuxUser/.imprnt-hub/registry.toml"
    Send-LinuxFile $LinuxUser ([IO.File]::ReadAllBytes((Resolve-Path -LiteralPath $RegistryFile).Path)) $registry
    $r = Invoke-Linux $LinuxUser "chmod 600 $registry && sha256sum $registry | cut -c1-16" -Capture
    Note 'registry_sha256_16' ($r.Lines -join '')
    $r = Invoke-Linux $LinuxUser "cd $hubDir && bun src/install/spoke.ts $registry $MachineId" -Capture
    try { $plan = ($r.Lines -join "`n") | ConvertFrom-Json } catch { Stop-Setup "the plan for $MachineId could not be read (exit $($r.Code)); the lines above say why" }
    Note 'plan_entries' (($plan.entries | ForEach-Object { "$($_.id)($($_.kind))" }) -join ', ')
    Note 'plan_agents' ($(if (@($plan.agents).Count -gt 0) { (@($plan.agents) | ForEach-Object { "$($_.id) tree_present=$($_.tree_present)" }) -join ', ' } else { 'none bound to this runner yet' }))
    if (@($plan.problems).Count -gt 0) {
      Note 'plan_problems' (@($plan.problems) -join ' | ')
      Stop-Setup 'the registry does not yet describe this machine as a spoke; fix it on the store machine, copy it here again and paste this block again'
    }
    Note 'plan_problems' 'none'
    Assert-Plain 'state_dir' $plan.state_dir; Assert-Plain 'secrets_dir' $plan.secrets_dir; Assert-Plain 'the hub entry' $plan.hub
    Assert-Plain 'the store address' $plan.store.host
    foreach ($login in @($plan.logins)) { Assert-Plain "the login file of $($login.credential)" $login.file }

    # ---- step 5: the two store role passwords ----
    Say 'step 5: the store role passwords for this machine'
    $mk = Invoke-Linux $LinuxUser "mkdir -p -m 700 '$($plan.state_dir)' '$($plan.secrets_dir)'"
    if ($mk.Code -ne 0) { Stop-Setup "cannot make $($plan.state_dir) and $($plan.secrets_dir)" }
    foreach ($role in @('hub_runner', 'hub_hub')) {
      $target = "$($plan.secrets_dir)/$role.password"
      $has = Invoke-Linux $LinuxUser "test -s '$target' && echo yes || echo no" -Capture
      if (($has.Lines -join '') -eq 'yes') { Note "password_$role" 'already there, kept'; continue }
      Write-Host "Paste the $role password from the store machine (there: sudo cat $($plan.store_secrets_dir)/$role.password). It is not shown." -ForegroundColor Yellow
      $secure = Read-Host -AsSecureString "$role password"
      $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
      try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if ([string]::IsNullOrWhiteSpace($plain)) { Stop-Setup "an empty $role password was pasted" }
        Send-LinuxFile $LinuxUser ([Text.Encoding]::UTF8.GetBytes($plain)) $target
      } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
        $plain = $null
      }
      Note "password_$role" 'written now (0600)'
    }

    # ---- step 6: the runner's own login, once ----
    Say 'step 6: the runner login (a login of its own; no existing login is read or copied)'
    foreach ($login in @($plan.logins)) {
      $dir = $login.file.Substring(0, $login.file.LastIndexOf('/'))
      if ($login.present) { Note "login_$($login.credential)" 'already there, kept (not refreshed)'; continue }
      $mk = Invoke-Linux $LinuxUser "mkdir -p -m 700 '$dir'"
      Write-Host "Claude Code will print a URL. Open it in your browser on this PC, approve, and paste the code back here." -ForegroundColor Yellow
      & wsl.exe --distribution $Distro --user $LinuxUser --cd '~' --exec /usr/bin/env DISABLE_AUTOUPDATER=1 "CLAUDE_CONFIG_DIR=$dir/config" "CLAUDE_SECURESTORAGE_CONFIG_DIR=$dir" "/home/$LinuxUser/.local/bin/claude" auth login
      $has = Invoke-Linux $LinuxUser "test -s '$($login.file)' && chmod 600 '$($login.file)' && echo yes || echo no" -Capture
      if (($has.Lines -join '') -ne 'yes') { Stop-Setup "the login did not write $($login.file)" }
      Note "login_$($login.credential)" 'made now'
    }

    # ---- step 7: reach the store, then check ----
    Say "step 7: the store at $($plan.store.host):$($plan.store.port), the registry copy, and check"
    $winReach = Test-NetConnection -ComputerName $plan.store.host -Port $plan.store.port -InformationLevel Quiet -WarningAction SilentlyContinue
    Note 'store_reach_windows' $winReach
    $r = Invoke-Linux $LinuxUser "timeout 6 bash -c 'exec 3<>/dev/tcp/$($plan.store.host)/$($plan.store.port)' && echo yes || echo no" -Capture
    Note 'store_reach_wsl' ($r.Lines -join '')
    if (($r.Lines -join '') -ne 'yes') {
      Stop-Setup ($(if ($winReach) { 'Windows reaches the store and the distro does not: see "Networking" in docs/windows-executor.md' } else { 'Windows does not reach the store either: is Tailscale up on this PC, and is this PC on the tailnet the store admits?' }))
    }
    # Interop and the Windows drives are ways around the box. /etc/wsl.conf closed both in step 3;
    # if either is open now it did not take effect, and nothing runs an agent here until it does.
    $gate = @'
on=""; for f in /proc/sys/fs/binfmt_misc/WSLInterop*; do [ -e "$f" ] && [ "$(head -1 "$f")" = enabled ] && on="$on $(basename "$f")"; done
drives=$(awk '$3=="drvfs"||(($3=="9p"||$3=="virtiofs")&&$4~/aname=drvfs/){print $2}' /proc/self/mounts | grep -v '^/usr/lib/wsl' | paste -sd, - || true)
echo "gate_interop=${on:-off}"
echo "gate_drives=${drives:-none}"
'@
    $r = Invoke-Linux $LinuxUser $gate -Capture
    $interopNow = (@($r.Lines | Where-Object { $_ -like 'gate_interop=*' }) -join '').Replace('gate_interop=', '').Trim()
    $drivesNow = (@($r.Lines | Where-Object { $_ -like 'gate_drives=*' }) -join '').Replace('gate_drives=', '').Trim()
    Note 'gate' "interop=$interopNow drives=$drivesNow"
    if ($r.Code -ne 0 -or $interopNow -ne 'off' -or $drivesNow -ne 'none') {
      Stop-Setup "interop ($interopNow) or the Windows drives ($drivesNow) are open in $Distro, so /etc/wsl.conf did not take effect: run wsl.exe --terminate $Distro and paste this block again"
    }
    $r = Invoke-Linux $LinuxUser "imprnt hub registry $registry $MachineId || true" -Capture
    Note 'registry_copy' ($r.Lines -join ' ')
    $r = Invoke-Linux $LinuxUser "c=0; imprnt hub check $registry $MachineId || c=`$?; echo exit=`$c" -Capture
    $r.Lines | ForEach-Object { Write-Host "  $_" }
    Note 'check_before_units' ($r.Lines -join ' | ')

    # ---- step 7b: one proof turn through the real runner, in a throwaway store (paid, optional) ----
    $proofPassed = $null
    if ($RunProofTurn) {
      $first = @($plan.logins)[0]
      Say "step 7b: the proof turn on $ProofModel (three short paid turns, a throwaway store, no household chat)"
      $proof = @'
evidence="$HOME/.imprnt-hub/setup/proof"
mkdir -p -m 700 "$evidence"
cd "__HUB__"
code=0
bun live/prove-engine-runner.ts --adapter claude-code --model "__MODEL__" --provider anthropic --effort low \
  --credential-kind claude-login --credential-file "__LOGIN__" --bin "$(readlink -f "$HOME/.local/bin/claude")" \
  --evidence-dir "$evidence" --label windows-wsl --allow-paid-call || code=$?
echo "proof exit: $code"
'@
      $proof = $proof -replace '__HUB__', $hubDir -replace '__MODEL__', $ProofModel -replace '__LOGIN__', $first.file
      $r = Invoke-Linux $LinuxUser $proof
      $read = @'
report=$(ls -1t "$HOME"/.imprnt-hub/setup/proof/engine-proof-claude-code-*/report.json 2>/dev/null | head -1)
[ -n "$report" ] || { echo "none"; exit 0; }
node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.verdict+" "+(r.failures||[]).join(","))' "$report"
'@
      $v = Invoke-Linux $LinuxUser $read -Capture
      Note 'proof' (($v.Lines -join ' ') + " (exit $($r.Code))")
      $proofPassed = (($v.Lines -join ' ') -match '^PASS_SCOPED')
      if (-not $proofPassed) { Stop-Setup 'the proof turn did not pass (see proof above), so no unit was installed' }
    } else { Note 'proof' 'not run (RunProofTurn is false)' }

    # ---- step 7c: this machine's units, and the logon task that keeps the distro up ----
    if ($InstallServices) {
      Say "step 7c: installing this machine's units through $($plan.hub)"
      $r = Invoke-Linux $LinuxUser "imprnt hub install $registry services $($plan.hub)"
      Note 'units_install' "exit $($r.Code)"
      if ($r.Code -ne 0) { Stop-Setup "imprnt hub install services failed (exit $($r.Code)); no logon task was registered or started" }
      $task = 'imprnt-hub-keepalive'
      try {
        if (-not (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue)) {
          $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"& wsl.exe --distribution $Distro --cd ~ --exec /bin/sleep infinity`""
          $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
          $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
          Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Description 'Keeps the imprnt-hub WSL distro (runner + hub) running while you are logged in.' | Out-Null
        }
        Start-ScheduledTask -TaskName $task
        Note 'keepalive_task' (Get-ScheduledTask -TaskName $task).State
      } catch { Note 'keepalive_task' "failed: $($_.Exception.Message)" }
      Start-Sleep -Seconds 10
      $r = Invoke-Linux $LinuxUser "c=0; imprnt hub status $registry $MachineId || c=`$?; echo exit=`$c" -Capture
      Note 'status' ($r.Lines -join ' | ')
      $r = Invoke-Linux $LinuxUser "c=0; imprnt hub check $registry $MachineId || c=`$?; echo exit=`$c" -Capture
      Note 'check_after_units' ($r.Lines -join ' | ')
      if (@($r.Lines)[-1] -ne 'exit=0') { $Attention += 'check_after_units' }
      if ("$($Summary['keepalive_task'])" -like 'failed*') { $Attention += 'keepalive_task' }
    } else { Note 'units_install' 'not asked (InstallServices is false)' }
  } catch {
    $message = $_.Exception.Message
    if ($message -like 'IMPRNT-STOP: *') { $Stopped = $message.Substring(13) } else { $Stopped = "unexpected: $message" }
  } finally {
    # ---- step 8: facts and the summary to paste back. Reads only; prints no secret. ----
    try {
      $listed = Get-WslLines @('--list', '--quiet')
      if ($listed -contains $Distro) {
        $facts = @'
echo "kernel=$(uname -r)"
. /etc/os-release && echo "linux=$PRETTY_NAME"
echo "pid1=$(cat /proc/1/comm)"
echo "systemd=$(systemctl is-system-running 2>/dev/null || true)"
echo "linger=$([ -e "/var/lib/systemd/linger/$(id -un)" ] && echo yes || echo no)"
on=""; for f in /proc/sys/fs/binfmt_misc/WSLInterop*; do [ -e "$f" ] && on="$on $(basename "$f"):$(head -1 "$f")"; done
echo "interop=${on:- none registered}"
echo "windows_mounts=$(awk '$3=="drvfs"||(($3=="9p"||$3=="virtiofs")&&$4~/aname=drvfs/){print $2}' /proc/self/mounts | grep -v '^/usr/lib/wsl' | paste -sd, - || true)"
echo "listening=$(ss -Hltnu 2>/dev/null | awk '{print $1":"$5}' | paste -sd, - || true)"
echo "bwrap=$(bwrap --version 2>/dev/null || echo missing)"
echo "earlyoom=$(systemctl is-active earlyoom 2>/dev/null || true)"
echo "bun=$(bun --version 2>/dev/null || echo missing)"
echo "node=$(node --version 2>/dev/null || echo missing)"
echo "claude=$(claude --version 2>/dev/null || echo missing)"
echo "imprnt=$(node -p 'require(process.env.HOME+"/.local/lib/node_modules/imprnt/package.json").version' 2>/dev/null || echo missing)"
echo "hub_link=$(imprnt plugin list --global 2>/dev/null | paste -sd' ' - || echo none)"
echo "units=$(systemctl --user list-units 'imprnt-hub-*' --all --no-legend --plain 2>/dev/null | awk '{print $1"="$3"/"$4}' | paste -sd, - || true)"
'@
        $r = Invoke-Linux $LinuxUser $facts -Capture
        foreach ($line in $r.Lines) { $at = $line.IndexOf('='); if ($at -gt 0) { Note ('linux_' + $line.Substring(0, $at)) $line.Substring($at + 1) } }
      }
    } catch { Note 'facts' "unreadable: $($_.Exception.Message)" }
    Note 'result' ($(if ($Stopped) { "STOPPED: $Stopped" } elseif ($Attention.Count) { "completed, with findings to read first: $($Attention -join ', ')" } else { 'completed' }))
    Write-Host ''
    Write-Host '===== imprnt windows executor: paste everything from here to "end" back =====' -ForegroundColor Green
    foreach ($key in $Summary.Keys) { Write-Host ("{0}: {1}" -f $key, $Summary[$key]) }
    Write-Host '===== end =====' -ForegroundColor Green
    [Console]::OutputEncoding = $savedOutputEncoding
    $env:WSL_UTF8 = $savedWslUtf8
  }
}
