#requires -Version 7.5
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '../scripts/ci-disconnect-spike.ps1'
if (!(Test-Path -LiteralPath $source)) { throw 'Missing hosted spike controller' }
. $source
$stopImplementation = ${function:Stop-SpikeChild}
$setImplementation = ${function:Set-SpikeAdapter}
function Assert-Throws([scriptblock]$Action, [string]$Name) {
  $failed = $false
  try { & $Action } catch { $failed = $true }
  if (!$failed) { throw "Accepted unsafe scenario: $Name" }
}
function Get-SpikePlatform { @{ windows = $true; admin = $true; actions = 'true'; runner = 'github-hosted'; workflow = 'T00 disconnect feasibility'; job = 'spike'; temp = 'C:\runner\temp'; branch = 'refs/heads/codex/t00-offline-spike' } }
Assert-SpikeHost (Get-SpikePlatform)
foreach ($field in @('windows','admin','actions','runner','workflow','job','temp','branch')) {
  $context = Get-SpikePlatform
  $context[$field] = if ($context[$field] -is [bool]) { $false } else { '' }
  Assert-Throws { Assert-SpikeHost $context } "host $field"
}
$script:inventory = @(
  [pscustomobject]@{ guid = '00000000-0000-0000-0000-000000000001'; device = 'pci1'; index = 4; admin = 'Up'; status = 'Up' },
  [pscustomobject]@{ guid = '00000000-0000-0000-0000-000000000002'; device = 'pci2'; index = 5; admin = 'Up'; status = 'Disconnected' },
  [pscustomobject]@{ guid = '00000000-0000-0000-0000-000000000003'; device = 'pci3'; index = 6; admin = 'Down'; status = 'Disabled' }
)
$manifest = @{ schema = 1; seconds = 15; adapters = $script:inventory; scriptHash = ('a' * 64); mainPid = 100 }
Assert-SpikeManifest $manifest
foreach ($change in @({ $bad.seconds = 0 }, { $bad.adapters = @() }, { $bad.adapters[0].guid = 'garbage' }, { $bad.adapters[0].admin = 'Unknown' })) {
  $bad = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json -AsHashtable
  & $change
  Assert-Throws { Assert-SpikeManifest $bad } 'malformed manifest'
}
$ack = @{ pid = 99; sid = 'S-1-5-18'; trackingAbsent = $true; independent = $true; snapshot = (Get-SpikeAdapterKey $manifest.adapters) }
Assert-SpikeAck $ack $manifest
foreach ($field in @('pid','sid','trackingAbsent','independent','snapshot')) {
  $badAck = $ack.Clone(); $badAck[$field] = $null
  Assert-Throws { Assert-SpikeAck $badAck $manifest } "watchdog ACK $field"
}
Assert-Throws { Assert-SpikeAck $null $manifest } 'missing watchdog ACK'
function Get-SpikeInventory {
  if ($script:failure -eq 'delayed-monitor') { $script:tick += 30 * [Diagnostics.Stopwatch]::Frequency }
  $rows = $script:inventory | ConvertTo-Json | ConvertFrom-Json
  if ($script:failure -eq 'restore-mismatch' -and @($script:events | Where-Object { $_ -like '*:True' }).Count) { $rows[0].admin = 'Down' }
  @{ adapters = $rows }
}
function Set-SpikeAdapter($Adapter, [bool]$Enable) {
  $script:events.Add("$($Adapter.guid):$Enable")
  ($script:inventory | Where-Object guid -eq $Adapter.guid).admin = if ($Enable) { 'Up' } else { 'Down' }
}
function Stop-SpikeChild($Child, [bool]$RequireCleanExit = $false) { $script:events.Add('child-stop'); if ($script:stopFails -or ($script:failure -eq 'supervisor-kill-fails' -and $Child.id -eq 41)) { throw 'termination failed' }; $true }
function Test-SpikeProcess($Identity) { $Identity.id -eq 41 -and $script:failure -in @('supervisor-hung','supervisor-kill-fails','late-disable') }
function Test-SpikeRelease($Manifest) { $script:failure -ne 'supervisor-died-mid-disable' }
function Get-SpikeTick { $script:tick }
function Wait-SpikeTick([long]$Deadline) { $script:tick = [Math]::Max($script:tick, $Deadline) }
function Save-SpikeJson($Value, [string]$Path) { $script:saved[$Path] = $Value }
foreach ($failure in @('supervisor-died-mid-disable','', 'child', 'mismatch', 'restore-mismatch', 'late', 'supervisor-hung','supervisor-kill-fails','late-disable','delayed-monitor')) {
  $script:failure = $failure
  $script:inventory = $manifest.adapters | ConvertTo-Json | ConvertFrom-Json
  $script:inventory | Where-Object admin -eq 'Up' | ForEach-Object { $_.admin = 'Down' }
  $script:events = [Collections.Generic.List[string]]::new(); $script:saved = @{}
  $script:stopFails = $failure -eq 'child'; $script:tick = 100
  $arm = @{ tick = 100; deadline = 100 + 15 * [Diagnostics.Stopwatch]::Frequency; child = @{ id = 42; start = 123 }; supervisor = @{ id = 41; start = 122 } }
  if ($failure -eq 'late') { $script:tick = $arm.deadline + [Diagnostics.Stopwatch]::Frequency * 3 }
  if ($failure -eq 'mismatch') { $script:inventory[0].device = 'replaced' }
  $result = Invoke-SpikeRecovery $manifest $arm 'receipt'
  if ($result.pass -ne ($failure -in @('','delayed-monitor'))) { throw "Wrong recovery verdict: $failure" }
  if ($script:events[0] -ne 'child-stop') { throw 'Restoration preceded child termination attempt' }
  $mustHold = $failure -in @('child','supervisor-hung','supervisor-kill-fails','late-disable','supervisor-died-mid-disable')
  $enabled = @($script:events | Where-Object { $_ -like '*:True' }).Count
  if ($mustHold -and $enabled) { throw "Recovery enabled networking with unconfirmed termination: $failure" }
  if (!$mustHold -and $failure -ne 'mismatch' -and ($script:events -notcontains '00000000-0000-0000-0000-000000000002:True')) { throw 'Link-down enabled adapter was not restored' }
  if ($failure -eq 'delayed-monitor' -and $result.restoreStart -gt $arm.deadline) { throw 'Delayed inventory blocked the recovery timer' }
  if ($script:events -contains '00000000-0000-0000-0000-000000000003:True') { throw 'Initially disabled adapter was enabled' }
}
Assert-Throws { Assert-SpikeArm @{ tick = 100; deadline = 101; child = @{ id = 42; start = 123 }; supervisor = @{ id = 41; start = 122 } } $manifest } 'invalid deadline'
Assert-Throws { Assert-SpikeProbe @{ connected = $true; loopback = $true } $false } 'external connection during disconnection'
Assert-Throws { Assert-SpikeProbe @{ connected = $false; loopback = $false } $false } 'broken loopback'
$script:events.Clear(); $script:failure = ''; $script:saved = @{}
function Wait-SpikeFile([string]$Path, [int]$Seconds = 30) { throw 'No watchdog acknowledgement' }
Assert-Throws { Invoke-SpikeSupervisor $manifest } 'missing ACK at supervisor boundary'
if ($script:events.Count -or $script:saved.Count) { throw 'Supervisor mutated state without acknowledgement' }
function Wait-SpikeFile([string]$Path, [int]$Seconds = 30) { @{ pid = 99; sid = 'S-1-5-18'; trackingAbsent = $true; independent = $true; snapshot = 'wrong-adapters' } }
Assert-Throws { Invoke-SpikeSupervisor $manifest } 'wrong ACK at supervisor boundary'
if ($script:events.Count -or $script:saved.Count) { throw 'Supervisor mutated state with mismatched acknowledgement' }
function Get-SpikeSid { 'S-1-5-21-100' }
Assert-Throws { Invoke-SpikeWatchdog $manifest } 'recovery from non-SYSTEM identity'
if ($script:events.Count -or $script:saved.Count) { throw 'Non-SYSTEM recovery mutated state' }
$fakeProcess = [pscustomobject]@{ HasExited = $true; ExitCode = 0; StartTime = [DateTime]::new(123, [DateTimeKind]::Utc) }
$fakeProcess | Add-Member ScriptMethod Kill { if ($script:killFails) { throw 'Kill denied' }; $this.HasExited = $true }
$fakeProcess | Add-Member ScriptMethod WaitForExit { param($Milliseconds) if ($Milliseconds -gt 500) { throw 'Unbounded termination wait' }; !$script:waitFails }
$script:spikeHandles['42'] = $fakeProcess
if (!(& $stopImplementation @{ id = 42; start = 123 } $true)) { throw 'Clean recorded child exit was rejected' }
$fakeProcess.ExitCode = 1
if (& $stopImplementation @{ id = 42; start = 123 } $true) { throw 'Abnormal child exit was accepted as clean' }
$fakeProcess.HasExited = $false; $fakeProcess.ExitCode = 0
if (& $stopImplementation @{ id = 42; start = 123 } $true) { throw 'Forced probe termination was treated as proof of descendant cleanup' }
$fakeProcess.HasExited = $false; $script:killFails = $true
Assert-Throws { & $stopImplementation @{ id = 42; start = 123 } $true } 'failed native termination'
$script:killFails = $false; $script:waitFails = $true
Assert-Throws { & $stopImplementation @{ id = 42; start = 123 } $true } 'termination confirmation timeout'
$script:waitFails = $false; $script:spikeHandles.Clear()
$script:spikeAdapterHandles[$manifest.adapters[0].guid] = [pscustomobject]@{ cached = $true }
$script:enableCount = 0
function Get-NetAdapter { param([switch]$IncludeHidden) throw 'Inventory query entered the restoration path' }
function Enable-NetAdapter { param([Parameter(ValueFromPipeline)]$InputObject,[switch]$Confirm) process { $script:enableCount++ } }
& $setImplementation $manifest.adapters[0] $true
if ($script:enableCount -ne 1) { throw 'Cached exact adapter was not used for restoration' }
$script:spikeAdapterHandles.Clear()
Remove-Item Function:\Get-NetAdapter,Function:\Enable-NetAdapter
function Test-Path { param([string]$Path) $script:fence }
function Get-Process { param($Id,$ErrorAction) $fakeProcess }
function Read-SpikeJson([string]$Path) { if ($Path -like '*child.json') { @{ id = 42; start = 123 } } else { @{ id = 41; start = 122 } } }
function Wait-SpikeFile([string]$Path, [int]$Seconds = 30) {
  if ($Path -like '*ack.json') { return $ack }
  if ($script:failure -eq 'fenced') { $script:fence = $true }
  $script:saved['C:\sealed\arm.json']
}
function Set-SpikeAdapter($Adapter, [bool]$Enable) {
  $script:events.Add("disable:$($Adapter.index)")
  $script:tick = $script:saved['C:\sealed\arm.json'].deadline
}
$manifest.root = 'C:\sealed'
foreach ($fenceCase in @('fenced','deadline-during-disable')) {
  $script:failure = $fenceCase; $script:fence = $false; $script:tick = 100; $script:saved = @{}; $script:events.Clear()
  Assert-Throws { Invoke-SpikeSupervisor $manifest } $fenceCase
  $expectedCount = if ($fenceCase -eq 'fenced') { 0 } else { 1 }
  if ($script:events.Count -ne $expectedCount -or $script:saved.ContainsKey('C:\sealed\release.json')) { throw 'Supervisor disabled an adapter after recovery fenced it' }
}
Remove-Item Function:\Test-Path,Function:\Get-Process
Write-Output 'PASS hosted spike guards, malformed state, ACK, child failure, adapter restoration and deadline checks (platform operations mocked)'


