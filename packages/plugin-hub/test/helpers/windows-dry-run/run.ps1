# A dry run of tools/windows/executor-setup.ps1 under pwsh on Linux, with ./wsl.exe first on PATH
# and the Windows-only cmdlets stubbed. It proves the block's own control flow, strict mode, the
# base64 transport, the password path and the summary. It proves nothing about Windows, WSL or
# Windows PowerShell 5.1's argument quoting.
param([string]$Block, [string]$Registry, [string]$State, [ValidateSet('stop', 'full')][string]$Mode)
$env:LOCALAPPDATA = "$State/local"; $env:USERPROFILE = "$State/home"; $env:USERDOMAIN = 'PC'; $env:USERNAME = 'owner'
$global:registered = $null
function global:Get-CimInstance([string]$ClassName) {
  switch ($ClassName) {
    'Win32_OperatingSystem' { [pscustomobject]@{ Caption = 'Microsoft Windows 11 Pro'; Version = '10.0.26100'; BuildNumber = '26100' } }
    'Win32_ComputerSystem' { [pscustomobject]@{ HypervisorPresent = $true } }
    'Win32_Processor' { [pscustomobject]@{ VirtualizationFirmwareEnabled = $false } }
  }
}
function global:Get-Service { $null }
function global:Test-NetConnection { $true }
function global:Read-Host { param([switch]$AsSecureString, [Parameter(Position = 0)]$Prompt) ConvertTo-SecureString 'pw-dry-run' -AsPlainText -Force }
function global:New-ScheduledTaskAction { 'action' }
function global:New-ScheduledTaskTrigger { 'trigger' }
function global:New-ScheduledTaskSettingsSet { 'settings' }
function global:Register-ScheduledTask { param($TaskName) $global:registered = [pscustomobject]@{ TaskName = $TaskName; State = 'Ready' } }
function global:Start-ScheduledTask { param($TaskName) $global:registered.State = 'Running' }
function global:Get-ScheduledTask { param($TaskName, $ErrorAction) $global:registered }
function global:Start-Sleep { }
$text = Get-Content -Raw $Block
$text = $text.Replace('New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())',
  '([pscustomobject]@{} | Add-Member -MemberType ScriptMethod -Name IsInRole -Value { $false } -PassThru)')
$text = $text -replace "\`$HubRef\s+= ''", ('$HubRef = ''' + ('a' * 40) + '''') -replace "\`$CoreVersion\s+= ''", '$CoreVersion = ''0.1.4'''
$text = $text -replace '\$RegistryFile\s+= "[^"]*"', ('$RegistryFile = ''' + $Registry + '''')
if ($Mode -eq 'full') { $text = $text -replace '\$RunProofTurn\s+= \$false', '$RunProofTurn = $true' -replace '\$InstallServices\s+= \$false', '$InstallServices = $true' }
& ([scriptblock]::Create($text))
