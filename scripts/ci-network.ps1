#requires -Version 7.5
[CmdletBinding()]
param([ValidateSet('core', 'browser', 'hardware')][string]$Suite = 'core',
  [string]$Output = "test-results/ci/$Suite")
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$script:ciNetworkRoot = $PSScriptRoot
$script:ciNetworkPath = $PSCommandPath

function Invoke-CIFirewallNetsh([string]$Command, [string]$Path) {
  $rows = if ($Path) { @(& netsh.exe advfirewall $Command $Path 2>&1) } else { @(& netsh.exe advfirewall $Command 2>&1) }
  if ($LASTEXITCODE -ne 0) { throw "Firewall $Command failed" }
  if ($Command -eq 'export' -and (!(Test-Path -LiteralPath $Path -PathType Leaf) -or !(Get-Item -LiteralPath $Path).Length)) { throw 'Firewall backup is missing or empty' }
  if ($Command -eq 'dump') {
    if (!$rows.Count) { throw 'Firewall policy dump is empty' }
    return ($rows -join "`n")
  }
}

function Get-CIRunnerPrograms {
  foreach ($name in 'Runner.Listener', 'Runner.Worker') {
    $processes = @(Get-Process -Name $name -ErrorAction Stop)
    if (!$processes.Count) { throw "Missing $name process" }
    foreach ($process in $processes) {
      $path = $process.Path
      if (!$path -or ![IO.Path]::IsPathFullyQualified($path) -or [IO.Path]::GetFileName($path) -ine "$name.exe" -or !(Test-Path -LiteralPath $path -PathType Leaf)) { throw "Invalid $name executable path" }
      $path
    }
  }
}

function Invoke-CIProbe([string]$Address, [int]$Port, [string]$ProbePath) {
  $rows = @(& node.exe $ProbePath $Address "$Port")
  if ($LASTEXITCODE -ne 0 -or $rows.Count -ne 1) { throw 'Network probe failed' }
  $result = $rows[0] | ConvertFrom-Json -DateKind String
  if ($result.address -cne $Address -or $result.port -ne $Port -or $result.pid -le 0 -or !$result.utc -or $result.connected -isnot [bool] -or $result.loopback -isnot [bool]) { throw 'Invalid network probe result' }
  return $result
}

function Invoke-CIProjectGate([string]$Suite, [string]$Output) {
  & (Join-Path $script:ciNetworkRoot 'ci.ps1') -Suite $Suite -Output $Output
}

function Save-CINetworkProof($Proof, [string]$Output) {
  $Proof | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $Output 'network-proof.json')
}

function Get-CIFirewallSnapshot {
  $profiles = @(Get-NetFirewallProfile -PolicyStore PersistentStore | Sort-Object Name | Select-Object Name, Enabled, DefaultOutboundAction)
  $rules = @(Get-NetFirewallRule -PolicyStore PersistentStore | Sort-Object Name | Select-Object Name, Enabled, Direction, Action, Profile)
  [ordered]@{ dump = (Invoke-CIFirewallNetsh 'dump'); profiles = $profiles; rules = $rules } | ConvertTo-Json -Depth 8 -Compress
}

function Invoke-CINetwork([string]$Suite, [string]$Output) {
  if ($env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:GITHUB_ACTIONS -ne 'true' -or !$env:RUNNER_TEMP) { throw 'Network policy is restricted to GitHub-hosted Actions runners' }
  $Output = [IO.Path]::GetFullPath($Output)
  if (Test-Path -LiteralPath $Output) { throw 'CI output must be a new directory' }
  New-Item -ItemType Directory -Path $Output -Force | Out-Null
  $probePath = Join-Path $script:ciNetworkRoot 'ci-network-probe.mjs'
  $proof = [ordered]@{
    suite = $Suite; address = $null; runnerPrograms = @()
    sources = [ordered]@{ wrapper = (Get-FileHash -LiteralPath $script:ciNetworkPath).Hash.ToLowerInvariant(); probe = (Get-FileHash -LiteralPath $probePath).Hash.ToLowerInvariant() }
    before = $null; blocked = $null; after = $null; restored = $false
    limitation = 'Direct project TCP is checked; DNS and runner control traffic remain allowed.'
  }
  Save-CINetworkProof $proof $Output
  $addresses = @(Resolve-DnsName -Name 'github.com' -Type A | Where-Object IPAddress | Select-Object -ExpandProperty IPAddress)
  if (!$addresses.Count) { throw 'Could not resolve a GitHub IPv4 address' }
  $proof.address = $addresses[0]
  $programs = @(Get-CIRunnerPrograms | Sort-Object -Unique)
  $proof.runnerPrograms = $programs
  Write-Host "Runner executables: $($programs -join ', ')"
  $proof.before = Invoke-CIProbe $proof.address 443 $probePath
  Save-CINetworkProof $proof $Output
  if (!$proof.before.connected -or !$proof.before.loopback) { throw 'Baseline network probe failed' }
  Write-Host "Baseline TCP probe passed at $($proof.before.utc), Node PID $($proof.before.pid)"

  $backup = Join-Path $env:RUNNER_TEMP ("ci-firewall-" + [guid]::NewGuid() + '.wfw')
  $backedUp = $false
  try {
    $beforePolicy = Get-CIFirewallSnapshot
    Invoke-CIFirewallNetsh 'export' $backup
    $backedUp = $true
    Write-Host "Firewall policy backed up at $([DateTime]::UtcNow.ToString('o'))"
    try {
      $existing = @(Get-NetFirewallRule -PolicyStore PersistentStore | Where-Object { $_.Direction -eq 'Outbound' -and $_.Action -eq 'Allow' -and $_.Enabled -eq 'True' })
      $prefix = 'ci-offline-' + [guid]::NewGuid()
      $allowNames = [Collections.Generic.List[string]]::new()
      foreach ($program in $programs) {
        $name = "$prefix-runner-$($allowNames.Count)"; $allowNames.Add($name)
        New-NetFirewallRule -Name $name -DisplayName $name -Direction Outbound -Action Allow -Profile Any -Program $program | Out-Null
      }
      $name = "$prefix-dns"; $allowNames.Add($name)
      New-NetFirewallRule -Name $name -DisplayName $name -Direction Outbound -Action Allow -Profile Any -Service Dnscache | Out-Null
      $name = "$prefix-loopback"; $allowNames.Add($name)
      New-NetFirewallRule -Name $name -DisplayName $name -Direction Outbound -Action Allow -Profile Any -RemoteAddress @('127.0.0.0/8', '::1') | Out-Null
      if ($existing.Count) { $existing | Disable-NetFirewallRule }
      Set-NetFirewallProfile -Profile Domain,Private,Public -Enabled True -DefaultOutboundAction Block
      $active = @(Get-NetFirewallRule -PolicyStore ActiveStore -Direction Outbound -Action Allow -Enabled True)
      $unexpected = @($active | Where-Object { $_.Name -notin $allowNames })
      $missing = @($allowNames | Where-Object { $_ -notin $active.Name })
      if ($unexpected.Count -or $missing.Count) { throw 'Active outbound allow rules do not match the runner policy' }
      $profiles = @(Get-NetFirewallProfile -PolicyStore ActiveStore)
      if ($profiles.Count -ne 3 -or @($profiles | Where-Object { $_.Enabled -ne 'True' -or $_.DefaultOutboundAction -ne 'Block' }).Count) { throw 'Outbound blocking is not active for all profiles' }
      $proof.blocked = Invoke-CIProbe $proof.address 443 $probePath
      Save-CINetworkProof $proof $Output
      if ($proof.blocked.connected -or !$proof.blocked.loopback) { throw 'Blocked network probe failed' }
      Write-Host "Direct TCP probe blocked at $($proof.blocked.utc), Node PID $($proof.blocked.pid); loopback passed"
      Write-Host "Starting $Suite project gates at $([DateTime]::UtcNow.ToString('o'))"
      Invoke-CIProjectGate $Suite (Join-Path $Output 'gates')
      Write-Host "Finished $Suite project gates at $([DateTime]::UtcNow.ToString('o'))"
      if ((Get-FileHash -LiteralPath $script:ciNetworkPath).Hash.ToLowerInvariant() -cne $proof.sources.wrapper -or (Get-FileHash -LiteralPath $probePath).Hash.ToLowerInvariant() -cne $proof.sources.probe) { throw 'Network probe source changed during the gates' }
    } finally {
      Write-Host "Restoring firewall policy at $([DateTime]::UtcNow.ToString('o'))"
      Invoke-CIFirewallNetsh 'import' $backup
      $afterPolicy = Get-CIFirewallSnapshot
      if ($beforePolicy -cne $afterPolicy) { throw 'Firewall policy restoration did not match the backup' }
      $proof.restored = $true
      $proof.after = Invoke-CIProbe $proof.address 443 $probePath
      if (!$proof.after.connected -or !$proof.after.loopback) { throw 'Restored network probe failed' }
      Write-Host "Firewall restored; TCP probe passed at $($proof.after.utc), Node PID $($proof.after.pid)"
    }
  } finally {
    Save-CINetworkProof $proof $Output
    if ((!$backedUp -or $proof.restored) -and (Test-Path -LiteralPath $backup)) { Remove-Item -LiteralPath $backup -Force }
  }
}

if ($MyInvocation.InvocationName -eq '.') { return }
Invoke-CINetwork -Suite $Suite -Output $Output
