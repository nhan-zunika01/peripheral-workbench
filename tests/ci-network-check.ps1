#requires -Version 7.5
$ErrorActionPreference = 'Stop'
$wrapper = Join-Path $PSScriptRoot '../scripts/ci-network.ps1'
if (!(Test-Path -LiteralPath $wrapper)) { throw 'CI network wrapper is missing' }

$oldHosted = $env:RUNNER_ENVIRONMENT
$oldActions = $env:GITHUB_ACTIONS
$oldTemp = $env:RUNNER_TEMP
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ("ci-network-test-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
$env:RUNNER_ENVIRONMENT = 'github-hosted'
$env:GITHUB_ACTIONS = 'true'
$env:RUNNER_TEMP = $testRoot

function Resolve-DnsName { [pscustomobject]@{ IPAddress = '203.0.113.10' } }
function Get-NetFirewallProfile {
  param($PolicyStore)
  foreach ($name in 'Domain', 'Private', 'Public') {
    [pscustomobject]@{ Name = $name; Enabled = 'True'; DefaultOutboundAction = $script:policy }
  }
}
function Set-NetFirewallProfile {
  param($Profile, $Enabled, $DefaultOutboundAction)
  $script:events.Add('set-profile')
  $script:policy = $DefaultOutboundAction
}
function Get-NetFirewallRule {
  param($PolicyStore, $Direction, $Action, $Enabled)
  if ($PolicyStore -eq 'ActiveStore' -and $script:failure -eq 'unexpected-allow') { [pscustomobject]@{ Name = 'external'; Direction = 'Outbound'; Action = 'Allow'; Enabled = 'True' } }
  $script:rules.Values | Where-Object { (!$Direction -or $_.Direction -eq $Direction) -and (!$Action -or $_.Action -eq $Action) -and (!$Enabled -or $_.Enabled -eq $Enabled) -and !($PolicyStore -eq 'ActiveStore' -and $script:failure -eq 'missing-allow' -and $_.Name -like '*-dns') }
}
function Disable-NetFirewallRule {
  param([Parameter(ValueFromPipeline)]$InputObject)
  process {
    $script:events.Add('disable-rule')
    if ($script:failure -eq 'disable') { throw 'simulated disable failure' }
    $script:rules[$InputObject.Name].Enabled = 'False'
  }
}
function New-NetFirewallRule {
  param($Name, $DisplayName, $Direction, $Action, $Program, $Service, $RemoteAddress, $Profile)
  $script:events.Add('add-rule')
  $script:rules[$Name] = [pscustomobject]@{ Name = $Name; Direction = $Direction; Action = $Action; Enabled = 'True' }
  $script:rules[$Name]
}

. $wrapper

function Invoke-CIFirewallNetsh([string]$Command, [string]$Path) {
  $script:events.Add("netsh-$Command")
  switch ($Command) {
    'export' {
      if ($script:failure -eq 'export') { throw 'simulated export failure' }
      $script:savedPolicy = $script:policy
      $script:savedRules = @{}; foreach ($key in $script:rules.Keys) { $script:savedRules[$key] = $script:rules[$key].PSObject.Copy() }
      Set-Content -LiteralPath $Path -Value 'test backup'
    }
    'import' {
      if ($script:failure -eq 'import') { throw 'simulated import failure' }
      $script:policy = $script:savedPolicy
      $script:rules = $script:savedRules
    }
    'dump' {
      $rows = @($script:rules.Values | Sort-Object Name | ForEach-Object { "$($_.Name):$($_.Enabled)" })
      if ($script:failure -eq 'restore-mismatch' -and $script:events.Contains('netsh-import')) { $rows += 'unexpected' }
      "$script:policy|$($rows -join ',')"
    }
  }
}
function Get-CIRunnerPrograms { @('C:\runner\Runner.Listener.exe', 'C:\runner\Runner.Worker.exe') }
function Invoke-CIProbe([string]$Address, [int]$Port, [string]$ProbePath) {
  $stage = if ($script:policy -eq 'Block') { 'blocked' } elseif ($script:events.Contains('netsh-import')) { 'restored' } else { 'before' }
  $script:events.Add("probe-$stage")
  [pscustomobject]@{ pid = $PID; utc = [DateTime]::UtcNow.ToString('o'); address = $Address; port = $Port; connected = (($stage -ne 'blocked' -or $script:failure -eq 'blocked-connects') -and !($stage -eq 'before' -and $script:failure -eq 'baseline')); loopback = $true }
}
function Invoke-CIProjectGate([string]$Suite, [string]$Output) { $script:events.Add('gates'); if ($script:failure -eq 'gate') { throw 'simulated gate failure' } }

function Run-Scenario([string]$Name, [string]$Failure, [bool]$ExpectedSuccess) {
  $script:events = [Collections.Generic.List[string]]::new()
  $script:failure = $Failure
  $script:policy = 'Allow'
  $script:rules = @{ existing = [pscustomobject]@{ Name = 'existing'; Direction = 'Outbound'; Action = 'Allow'; Enabled = 'True' } }
  $output = Join-Path $testRoot $Name
  $failed = $false
  try { Invoke-CINetwork -Suite core -Output $output 6>$null } catch { $failed = $true }
  if ($failed -eq $ExpectedSuccess) { throw "Scenario $Name returned an unexpected result" }
  if ($Failure -in @('export', 'baseline')) {
    if ($script:events.Contains('add-rule') -or $script:events.Contains('disable-rule') -or $script:events.Contains('set-profile')) { throw 'Policy changed after export failure' }
    return
  }
  if (!$script:events.Contains('netsh-import')) { throw "Scenario $Name did not restore the firewall" }
  if ($Failure -notin @('import', 'restore-mismatch') -and ($script:policy -ne 'Allow' -or $script:rules.Count -ne 1 -or $script:rules.existing.Enabled -ne 'True')) { throw "Scenario $Name did not restore the original state" }
  if ($Failure -eq 'blocked-connects' -and $script:events.Contains('gates')) { throw 'Gates ran despite a successful blocked connection' }
  if ($ExpectedSuccess) {
    $proof = Get-Content -LiteralPath (Join-Path $output 'network-proof.json') -Raw | ConvertFrom-Json
    if (!$proof.restored -or !$proof.before.connected -or $proof.blocked.connected -or !$proof.blocked.loopback -or !$proof.after.connected -or !$proof.sources.probe) { throw 'Network proof is incomplete' }
    if ($script:events.IndexOf('netsh-export') -gt $script:events.IndexOf('add-rule') -or $script:events.IndexOf('probe-blocked') -gt $script:events.IndexOf('gates') -or $script:events.IndexOf('gates') -gt $script:events.IndexOf('netsh-import')) { throw 'Network operations occurred out of order' }
  }
}

try {
  $env:RUNNER_ENVIRONMENT = 'self-hosted'
  $rejected = $false
  try { Invoke-CINetwork -Suite core -Output (Join-Path $testRoot 'local') } catch { $rejected = $true }
  if (!$rejected -or (Test-Path -LiteralPath (Join-Path $testRoot 'local'))) { throw 'Non-hosted execution was accepted' }
  $env:RUNNER_ENVIRONMENT = 'github-hosted'
  Run-Scenario 'success' '' $true
  Run-Scenario 'export' 'export' $false
  Run-Scenario 'baseline' 'baseline' $false
  Run-Scenario 'disable' 'disable' $false
  Run-Scenario 'blocked-connects' 'blocked-connects' $false
  Run-Scenario 'unexpected-allow' 'unexpected-allow' $false
  Run-Scenario 'missing-allow' 'missing-allow' $false
  Run-Scenario 'gate' 'gate' $false
  Run-Scenario 'import' 'import' $false
  Run-Scenario 'restore-mismatch' 'restore-mismatch' $false
  Write-Output 'PASS CI network policy sequencing and cleanup'
} finally {
  $env:RUNNER_ENVIRONMENT = $oldHosted
  $env:GITHUB_ACTIONS = $oldActions
  $env:RUNNER_TEMP = $oldTemp
  $fullRoot = [IO.Path]::GetFullPath($testRoot)
  $tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (!$fullRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe temporary directory' }
  Remove-Item -LiteralPath $fullRoot -Recurse -Force
}
