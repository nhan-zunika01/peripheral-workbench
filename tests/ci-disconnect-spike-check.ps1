#requires -Version 7.5
$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot '../scripts/ci-disconnect-spike.ps1'
if (!(Test-Path -LiteralPath $source)) { throw 'Missing hosted spike controller' }
. $source
$stopImplementation = ${function:Stop-SpikeChild}
$setImplementation = ${function:Set-SpikeAdapter}
$sealedImplementation = ${function:Assert-SpikeSealed}
$installImplementation = ${function:Install-SpikeTools}
$completionImplementation = ${function:Test-SpikeRelease}
function Assert-Throws([scriptblock]$Action, [string]$Name) {
  $failed = $false
  try { & $Action } catch { $failed = $true }
  if (!$failed) { throw "Accepted unsafe scenario: $Name" }
}
$script:bindingFailure = ''; $script:bindingQueries = 0
function Get-NetAdapter {
  param([switch]$IncludeHidden)
  foreach ($row in @(@('Ethernet','Hosted Ethernet',4), @('Ethernet (Kernel Debugger)','Kernel Debugger',5), @('Hidden Without Bindings','Empty Binding Adapter',6))) {
    if ($IncludeHidden -or $row[2] -eq 4) { [pscustomobject]@{ Name = $row[0]; InterfaceDescription = $row[1]; InterfaceGuid = [guid]("00000000-0000-0000-0000-00000000000" + ($row[2] - 3)); PnPDeviceID = "device-$($row[2])"; ifIndex = $row[2]; AdminStatus = 'Up'; Status = 'Disconnected' } }
  }
}
function Get-NetAdapterBinding {
  param($Name,[switch]$IncludeHidden,[switch]$AllBindings,$ErrorAction)
  $script:bindingQueries++
  if ($script:bindingFailure -eq 'provider') { throw 'Simulated binding provider failure' }
  if ($Name -and $Name -ne 'Ethernet' -and !$IncludeHidden) { throw "No MSFT_NetAdapterBindingSettingData found for hidden adapter '$Name'" }
  $rows = @([pscustomobject]@{ Name = 'Ethernet'; InterfaceDescription = 'Hosted Ethernet'; ComponentID = 'ms_tcpip'; Enabled = $true })
  if ($IncludeHidden) { $rows += [pscustomobject]@{ Name = 'Ethernet (Kernel Debugger)'; InterfaceDescription = 'Kernel Debugger'; ComponentID = 'ms_tcpip6'; Enabled = $true } }
  if ($script:bindingFailure -eq 'unaccounted') { $rows += [pscustomobject]@{ Name = 'Unexpected Tunnel'; InterfaceDescription = 'Unknown'; ComponentID = 'ms_tcpip'; Enabled = $true } }
  $rows | Where-Object { !$Name -or $_.Name -like $Name }
}
function Get-NetIPInterface { foreach ($index in @(1,4,5,6)) { [pscustomobject]@{ InterfaceIndex = $index } } }
function Get-NetRoute { [pscustomobject]@{ InterfaceIndex = 4 } }
function Get-NetIPAddress { param($InterfaceIndex) foreach ($address in @('127.0.0.1','::1')) { [pscustomobject]@{ IPAddress = $address } } }
$hiddenInventory = Get-SpikeInventory
if ($hiddenInventory.adapters.Count -ne 3 -or $hiddenInventory.adapters[1].bindings[0].ComponentID -ne 'ms_tcpip6' -or $hiddenInventory.adapters[2].bindings.Count -ne 0 -or $hiddenInventory.adapters[2].admin -ne 'Up' -or $script:bindingQueries -ne 1) { throw 'Hidden adapter bindings or exact empty binding evidence was lost' }
$script:bindingFailure = 'provider'
Assert-Throws { Get-SpikeInventory } 'binding provider failure cannot become empty binding evidence'
$script:bindingFailure = 'unaccounted'
Assert-Throws { Get-SpikeInventory } 'binding for an unaccounted external interface'
Remove-Item Function:\Get-NetAdapter,Function:\Get-NetAdapterBinding,Function:\Get-NetIPInterface,Function:\Get-NetRoute,Function:\Get-NetIPAddress
function Start-Process {
  param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,[switch]$PassThru,$RedirectStandardOutput,$RedirectStandardError,$Credential,[switch]$LoadUserProfile,$Environment)
  $script:launch = $PSBoundParameters
}
$launchManifest = @{ root = 'C:\Program Files\T00-sealed'; childRoot = 'C:\Program Files\T00-sealed\child'; pwsh = 'C:\Program Files\T00-sealed\powershell\pwsh.exe'; node = 'C:\Program Files\T00-sealed\node.exe'; script = 'C:\Program Files\T00-sealed\controller.ps1' }
$mockCredential = [pscredential]::new('mock-only-user', [Security.SecureString]::new())
foreach ($launchStage in @('before','during','after')) {
  $null = Start-SpikeMode $launchManifest 'Child' $mockCredential $launchStage
  if ($script:launch.RedirectStandardOutput -cne "$($launchManifest.root)\Child-$launchStage.log" -or $script:launch.RedirectStandardError -cne "$($launchManifest.root)\Child-$launchStage.stderr") { throw 'Elevated standard-user launch opened a child-controlled redirection path' }
}
foreach ($launchMode in @('Supervisor','Monitor')) {
  $null = Start-SpikeMode $launchManifest $launchMode $null
  if ($script:launch.RedirectStandardOutput -cne "$($launchManifest.root)\$launchMode-before.log" -or $script:launch.RedirectStandardError -cne "$($launchManifest.root)\$launchMode-before.stderr") { throw 'Elevated controller launch used a writable redirection path' }
}
Remove-Item Function:\Start-Process
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
for ($i = 0; $i -lt $script:inventory.Count; $i++) {
  $item = $script:inventory[$i]
  $item | Add-Member NoteProperty identityProperties @{ deviceId = "logical-device-$i"; interfaceName = "interface-$i"; netLuid = "100$i"; interfaceIndex = $item.index; interfaceAdminStatus = $(if ($item.admin -eq 'Up') { 1 } else { 2 }); hidden = ($i -eq 2); virtual = ($i -ne 0); hardware = ($i -eq 0) }
  $item | Add-Member NoteProperty bindings @()
}
$manifest = @{ schema = 1; seconds = 15; adapters = $script:inventory; scriptHash = ('a' * 64); mainPid = 100 }
Assert-SpikeManifest $manifest
$logicalManifest = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json -AsHashtable
$logicalManifest.adapters[1].device = $null; $logicalManifest.adapters[2].device = $null
Assert-SpikeManifest $logicalManifest
foreach ($logicalFailure in @('physical','ambiguous','unknown-hardware','whitespace','empty-pnp','device-id','interface-name','luid-zero','luid-overflow','luid-fraction','guid','index','index-inconsistent','admin-inconsistent','duplicate-guid','duplicate-device','duplicate-interface','duplicate-luid')) {
  $invalidLogical = $logicalManifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json -AsHashtable
  $target = $invalidLogical.adapters[1]; $properties = $target.identityProperties
  switch ($logicalFailure) {
    'physical' { $properties.hardware = $true }
    'ambiguous' { $properties.virtual = 'true' }
    'unknown-hardware' { $properties.hardware = $null }
    'whitespace' { $target.device = ' ' }
    'empty-pnp' { $target.device = '' }
    'device-id' { $properties.deviceId = $null }
    'interface-name' { $properties.interfaceName = ' ' }
    'luid-zero' { $properties.netLuid = '0' }
    'luid-overflow' { $properties.netLuid = '18446744073709551616' }
    'luid-fraction' { $properties.netLuid = '1.5' }
    'guid' { $target.guid = '' }
    'index' { $target.index = 0 }
    'index-inconsistent' { $properties.interfaceIndex = 99 }
    'admin-inconsistent' { $properties.interfaceAdminStatus = 2 }
    'duplicate-guid' { $target.guid = $invalidLogical.adapters[0].guid }
    'duplicate-device' { $properties.deviceId = $invalidLogical.adapters[0].identityProperties.deviceId }
    'duplicate-interface' { $properties.interfaceName = $invalidLogical.adapters[0].identityProperties.interfaceName }
    'duplicate-luid' { $properties.netLuid = $invalidLogical.adapters[0].identityProperties.netLuid }
  }
  Assert-Throws { Assert-SpikeManifest $invalidLogical } "logical identity: $logicalFailure"
}
$disabledSnapshot = $logicalManifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json -AsHashtable
foreach ($adapter in $disabledSnapshot.adapters) { $adapter.admin = 'Down'; $adapter.identityProperties.interfaceAdminStatus = 2 }
Assert-SpikeSnapshot $logicalManifest $disabledSnapshot $true
$disabledSnapshot.adapters[2].admin = 'Up'
Assert-Throws { Assert-SpikeSnapshot $logicalManifest $disabledSnapshot $true } 'initially disabled adapter became enabled during isolation'
$manifest = $logicalManifest
$receiptArm = @{ tick = 100; deadline = 100 + 15 * [Diagnostics.Stopwatch]::Frequency; supervisor = @{ id = 41; start = 122 } }
$receiptInventory = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json -AsHashtable
foreach ($adapter in $receiptInventory.adapters) { $adapter.admin = 'Down'; $adapter.identityProperties.interfaceAdminStatus = 2 }
$receiptInventory.tick = 150; $receiptInventory.interfaces = @(@{ InterfaceIndex = 44 },@{ InterfaceIndex = 5 },@{ InterfaceIndex = 6 }); $receiptInventory.routes = @(@{ InterfaceIndex = 44 })
$receiptInventory.adapters[0].index = 44; $receiptInventory.adapters[0].identityProperties.interfaceIndex = 44
$validCompletion = @{ armTick = 100; deadline = $receiptArm.deadline; supervisor = $receiptArm.supervisor; scriptHash = $manifest.scriptHash; completedTick = 200; inventory = $receiptInventory }
$script:completionReceipt = $validCompletion; $script:testFence = $false; $script:testRelease = $true
function Test-Path { param($LiteralPath) if ($LiteralPath -like '*recovery-fence.json') { return $script:testFence }; if ($LiteralPath -like '*release.json') { if ($script:fenceOnRelease) { $script:testFence = $true }; return $script:testRelease }; $true }
function Read-SpikeJson { param($Path) $script:completionReceipt }
if (!(& $completionImplementation $manifest $receiptArm)) { throw 'Coherent index drift blocked an otherwise complete recovery fence' }
Assert-Throws { Assert-SpikeSnapshot $manifest $receiptInventory $true } 'coherent index drift cannot pass strict disconnected proof'
foreach ($receiptFailure in @('arm','deadline','supervisor','script','late','index','duplicate-index','missing-index','admin','logical','route','bindings')) {
  $script:completionReceipt = $validCompletion | ConvertTo-Json -Depth 12 | ConvertFrom-Json -AsHashtable
  switch ($receiptFailure) {
    'arm' { $script:completionReceipt.armTick++ }
    'deadline' { $script:completionReceipt.deadline++ }
    'supervisor' { $script:completionReceipt.supervisor.start++ }
    'script' { $script:completionReceipt.scriptHash = 'changed' }
    'late' { $script:completionReceipt.completedTick = $receiptArm.deadline }
    'index' { $script:completionReceipt.inventory.adapters[0].identityProperties.interfaceIndex = 45 }
    'duplicate-index' { $script:completionReceipt.inventory.adapters[0].index = 5; $script:completionReceipt.inventory.adapters[0].identityProperties.interfaceIndex = 5 }
    'missing-index' { $script:completionReceipt.inventory.adapters[0].identityProperties.Remove('interfaceIndex') | Out-Null }
    'admin' { $script:completionReceipt.inventory.adapters[0].identityProperties.interfaceAdminStatus = 1 }
    'logical' { $script:completionReceipt.inventory.adapters[0].identityProperties.deviceId = 'changed' }
    'route' { $script:completionReceipt.inventory.routes[0].InterfaceIndex = 999 }
    'bindings' { $script:completionReceipt.inventory.adapters[0].Remove('bindings') | Out-Null }
  }
  if (& $completionImplementation $manifest $receiptArm) { throw "Malformed completion receipt allowed recovery: $receiptFailure" }
}
function Get-SpikeTick { $script:tick }
$script:tick = 100
if (!(Wait-SpikeProbeRelease $manifest $receiptArm)) { throw 'Valid probe release was rejected' }
$script:fenceOnRelease = $true
if (Wait-SpikeProbeRelease $manifest $receiptArm) { throw 'Fence appearing during release observation allowed a probe' }
$script:fenceOnRelease = $false; $script:testFence = $false; $script:tick = $receiptArm.deadline
if (Wait-SpikeProbeRelease $manifest $receiptArm) { throw 'Deadline allowed a late probe release' }
$script:tick = 100; $script:testFence = $true; $script:testRelease = $false
if (Wait-SpikeProbeRelease $manifest $receiptArm) { throw 'Never-released child ignored the recovery fence' }
Remove-Item Function:\Test-Path,Function:\Read-SpikeJson
$unexpectedInventory = $receiptInventory | ConvertTo-Json -Depth 10 | ConvertFrom-Json -AsHashtable
$extra = $unexpectedInventory.adapters[0] | ConvertTo-Json -Depth 6 | ConvertFrom-Json -AsHashtable
$extra.guid = '00000000-0000-0000-0000-000000000009'; $extra.index = 99; $extra.identityProperties.interfaceIndex = 99; $extra.identityProperties.deviceId = 'new-device'; $extra.identityProperties.interfaceName = 'new-interface'; $extra.identityProperties.netLuid = '9999'
$unexpectedInventory.adapters += $extra
Assert-Throws { Assert-SpikeSnapshot $manifest $unexpectedInventory $true $false } 'new interface cannot satisfy the completion fence'
foreach ($invalidField in @('guid','device','index','admin','duplicate')) {
  $invalidManifest = $manifest | ConvertTo-Json -Depth 8 | ConvertFrom-Json -AsHashtable
  switch ($invalidField) {
    'guid' { $invalidManifest.adapters[0].guid = $null; $expectedIssue = 'guid-missing-or-invalid' }
    'device' { $invalidManifest.adapters[0].device = $null; $expectedIssue = 'pnp-device-missing' }
    'index' { $invalidManifest.adapters[0].index = 0; $expectedIssue = 'interface-index-invalid' }
    'admin' { $invalidManifest.adapters[0].admin = 'Unknown'; $expectedIssue = 'admin-state-unknown' }
    'duplicate' { $invalidManifest.adapters[1].guid = $invalidManifest.adapters[0].guid; $expectedIssue = 'duplicate-guid' }
  }
  $diagnostic = ''
  try { Assert-SpikeManifest $invalidManifest } catch { $diagnostic = $_.Exception.Message }
  if ($diagnostic -notmatch "fields=.*$expectedIssue" -or $diagnostic -notmatch 'row=\d+ category=') { throw "Adapter failure lost its field/category: $invalidField" }
}
$invalidManifest.adapters[0].device = $null; $invalidManifest.adapters[1].device = ''; $invalidManifest.adapters[2].device = ' '
$failureProof = @{ pass = $false; error = 'pnp-device-missing'; beforeInventory = @{ adapters = $invalidManifest.adapters } }
$publicFailure = Protect-SpikeEvidence ($failureProof | ConvertTo-Json -Depth 10) $invalidManifest 'C:\controller'
$publicFailureObject = $publicFailure | ConvertFrom-Json
if ($publicFailureObject.error -ne 'pnp-device-missing' -or $publicFailureObject.beforeInventory.adapters.Count -ne 3 -or $publicFailure -match '00000000-0000-0000-0000-000000000001' -or $publicFailureObject.pass) { throw 'Null/empty identities masked the original failed proof or escaped redaction' }
$opaqueManifest = @{ adapters = @(@{ guid = '00000000-0000-0000-0000-000000000004'; device = 'PCI\opaque-pnp'; identityProperties = @{ deviceId = 'opaque-device'; interfaceName = 'NDIS\opaque-interface'; netLuid = '987654321012345' } }) }
$opaquePublic = Protect-SpikeEvidence ($opaqueManifest | ConvertTo-Json -Depth 6) $opaqueManifest 'C:\controller'
if ($opaquePublic -match 'opaque-|987654321012345' -or ($opaquePublic | ConvertFrom-Json).adapters[0].identityProperties.netLuid -notmatch '^sha256:[a-f0-9]{64}$') { throw 'Additional adapter identifiers escaped public evidence redaction' }
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
  $row = $script:inventory | Where-Object guid -eq $Adapter.guid
  $row.admin = if ($Enable) { 'Up' } else { 'Down' }; $row.identityProperties.interfaceAdminStatus = if ($Enable) { 1 } else { 2 }
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
  $script:inventory | Where-Object admin -eq 'Up' | ForEach-Object { $_.admin = 'Down'; $_.identityProperties.interfaceAdminStatus = 2 }
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
$fakeProcess | Add-Member ScriptMethod WaitForExit { param($Milliseconds) if ($Milliseconds -gt 500) { throw 'Unbounded termination wait' }; if ($script:cooperativeExit) { $this.HasExited = $true }; $this.HasExited -and !$script:waitFails }
$script:spikeHandles['42'] = $fakeProcess
if (!(& $stopImplementation @{ id = 42; start = 123 } $true)) { throw 'Clean recorded child exit was rejected' }
$fakeProcess.ExitCode = 1
if (& $stopImplementation @{ id = 42; start = 123 } $true) { throw 'Abnormal child exit was accepted as clean' }
$fakeProcess.HasExited = $false; $fakeProcess.ExitCode = 0
if (& $stopImplementation @{ id = 42; start = 123 } $true) { throw 'Forced probe termination was treated as proof of descendant cleanup' }
$fakeProcess.HasExited = $false; $script:cooperativeExit = $true
if (!(& $stopImplementation @{ id = 42; start = 123 } $true)) { throw 'Cooperative clean child cancellation was rejected' }
$script:cooperativeExit = $false
$fakeProcess.HasExited = $false; $script:killFails = $true
Assert-Throws { & $stopImplementation @{ id = 42; start = 123 } $true } 'failed native termination'
$script:killFails = $false; $script:waitFails = $true
Assert-Throws { & $stopImplementation @{ id = 42; start = 123 } $true } 'termination confirmation timeout'
$script:waitFails = $false; $script:spikeHandles.Clear()
function New-CimFixture($Record, [int]$Index = 0) {
  $p = $Record.identityProperties; if (!$Index) { $Index = $Record.index }
  [pscustomobject]@{ InterfaceGuid = [guid]$Record.guid; PnPDeviceID = $Record.device; DeviceID = $p.deviceId; InterfaceName = $p.interfaceName; NetLuid = [uint64]$p.netLuid; Virtual = $p.virtual; HardwareInterface = $p.hardware; Hidden = $p.hidden; ifIndex = $Index; InterfaceIndex = $Index; AdminStatus = 'Down'; InterfaceAdminStatus = 2 }
}
$cachedAdapter = New-CimFixture $manifest.adapters[0] 44
$script:spikeAdapterHandles[$manifest.adapters[0].guid] = $cachedAdapter
$script:enableCount = 0; $script:queryForbidden = $true; $script:enabledObjects = [Collections.Generic.List[object]]::new()
function Get-NetAdapter { param([switch]$IncludeHidden) if ($script:queryForbidden) { throw 'Inventory query entered the restoration path' }; $script:adapterCandidates }
function Enable-NetAdapter { param([Parameter(ValueFromPipeline)]$InputObject,[switch]$Confirm) process { $script:enableCount++; $script:enabledObjects.Add($InputObject) } }
& $setImplementation $manifest.adapters[0] $true
if ($script:enableCount -ne 1 -or ![object]::ReferenceEquals($cachedAdapter, $script:enabledObjects[0])) { throw 'Changed index prevented restoration of the exact cached logical adapter' }
foreach ($mismatch in @('InterfaceGuid','PnPDeviceID','DeviceID','InterfaceName','NetLuid','Virtual','HardwareInterface','Hidden')) {
  $badCache = $cachedAdapter.PSObject.Copy()
  $badCache.$mismatch = switch ($mismatch) { 'InterfaceGuid' { [guid]'00000000-0000-0000-0000-000000000009' } 'Virtual' { $true } 'HardwareInterface' { $false } 'Hidden' { $true } default { 'changed' } }
  $script:spikeAdapterHandles[$manifest.adapters[0].guid] = $badCache
  Assert-Throws { & $setImplementation $manifest.adapters[0] $true } "cached identity mismatch: $mismatch"
}
$script:spikeAdapterHandles[$manifest.adapters[2].guid] = New-CimFixture $manifest.adapters[2]
Assert-Throws { & $setImplementation $manifest.adapters[2] $true } 'initially Down adapter mutation'
if ($script:enableCount -ne 1) { throw 'Invalid or initially Down cached adapter was enabled' }
$script:spikeAdapterHandles.Clear()
$script:enabledObjects.Clear(); $script:enableCount = 0; $script:failure = 'index-change'; $script:stopFails = $false; $script:tick = 100; $script:saved = @{}
$script:inventory = $manifest.adapters | ConvertTo-Json -Depth 8 | ConvertFrom-Json
foreach ($row in $script:inventory) { $row.admin = 'Down'; $row.identityProperties.interfaceAdminStatus = 2 }
$script:inventory[0].index = 44; $script:inventory[0].identityProperties.interfaceIndex = 44
foreach ($row in $manifest.adapters | Where-Object admin -eq 'Up') { $script:spikeAdapterHandles[$row.guid] = New-CimFixture $row $(if ($row.index -eq 4) { 44 } else { $row.index }) }
function Set-SpikeAdapter($Adapter, [bool]$Enable) { & $setImplementation $Adapter $Enable; $row = $script:inventory | Where-Object guid -eq $Adapter.guid; $row.admin = 'Up'; $row.identityProperties.interfaceAdminStatus = 1 }
$indexRecovery = Invoke-SpikeRecovery $manifest $arm 'index-recovery'
if ($indexRecovery.pass -or $indexRecovery.networkHeld -or $script:enableCount -ne 2 -or $indexRecovery.after.adapters[0].admin -ne 'Up') { throw 'Coherent changed-index recovery did not restore exact adapters and then fail strict proof' }
foreach ($row in $manifest.adapters | Where-Object admin -eq 'Up') { if (@($script:enabledObjects | Where-Object { [object]::ReferenceEquals($_, $script:spikeAdapterHandles[$row.guid]) }).Count -ne 1) { throw 'Recovery did not pass the exact cached CIM object to Enable-NetAdapter' } }
$script:spikeAdapterHandles.Clear(); $script:queryForbidden = $false; $script:adapterCandidates = @($cachedAdapter,$cachedAdapter.PSObject.Copy()); $script:disableCount = 0
function Disable-NetAdapter { param([Parameter(ValueFromPipeline)]$InputObject,[switch]$Confirm) process { $script:disableCount++; $script:disabledObject = $InputObject } }
Assert-Throws { & $setImplementation $manifest.adapters[0] $false } 'duplicate live logical identity'
if ($script:disableCount) { throw 'Ambiguous logical match reached adapter mutation' }
$script:adapterCandidates = @($cachedAdapter)
& $setImplementation $manifest.adapters[0] $false
if ($script:disableCount -ne 1 -or ![object]::ReferenceEquals($script:disabledObject, $cachedAdapter)) { throw 'Disable did not receive the exact unique logical CIM match' }
Remove-Item Function:\Get-NetAdapter,Function:\Enable-NetAdapter,Function:\Disable-NetAdapter
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
$adminSid = 'S-1-5-32-544'; $usersSid = 'S-1-5-32-545'; $controllerSid = 'S-1-5-21-500'
function New-AclRule([string]$Sid, [string]$Rights, [string]$Propagation = 'None') {
  [pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $Sid }; FileSystemRights = [Security.AccessControl.FileSystemRights]$Rights; AccessControlType = 'Allow'; PropagationFlags = [Security.AccessControl.PropagationFlags]$Propagation }
}
function New-AclFixture([string]$Owner, $Rules) {
  $acl = [pscustomobject]@{ owner = $Owner; rules = @($Rules); sddl = 'D:' }
  $acl | Add-Member ScriptMethod GetAccessRules { param($Explicit,$Inherited,$IdentityType) $this.rules }
  $acl | Add-Member ScriptMethod GetOwner { param($IdentityType) [pscustomobject]@{ Value = $this.owner } }
  $acl | Add-Member ScriptMethod GetSecurityDescriptorSddlForm { param($Sections) $this.sddl }
  $acl
}
$aclParent = [pscustomobject]@{ FullName = 'C:\Program Files'; PSIsContainer = $true; Attributes = [IO.FileAttributes]::Directory; Parent = $null }
$aclLeaf = [pscustomobject]@{ FullName = 'C:\Program Files\T00-test'; PSIsContainer = $true; Attributes = [IO.FileAttributes]::Directory; Parent = $aclParent }
$script:aclRows = @{
  $aclLeaf.FullName = (New-AclFixture $usersSid @((New-AclRule $adminSid 'FullControl')))
  $aclParent.FullName = (New-AclFixture $adminSid @((New-AclRule $adminSid 'FullControl')))
}
function Get-Item { param($LiteralPath) $aclLeaf }
function Get-Acl { param($LiteralPath) $script:aclRows[$LiteralPath] }
Assert-Throws { & $sealedImplementation $aclLeaf.FullName $controllerSid } 'untrusted owner can replace the controller DACL'
$script:aclRows[$aclLeaf.FullName] = New-AclFixture $adminSid @((New-AclRule $adminSid 'FullControl'))
foreach ($unsafeRight in @('DeleteSubdirectoriesAndFiles','Delete','ChangePermissions','TakeOwnership')) {
  $script:aclRows[$aclParent.FullName] = New-AclFixture $adminSid @((New-AclRule $usersSid $unsafeRight))
  Assert-Throws { & $sealedImplementation $aclLeaf.FullName $controllerSid } "ancestor $unsafeRight"
}
$script:aclRows[$aclParent.FullName] = New-AclFixture $adminSid @((New-AclRule $usersSid 'WriteData,AppendData'),(New-AclRule $usersSid 'Modify' 'InheritOnly'))
& $sealedImplementation $aclLeaf.FullName $controllerSid
$script:aclRows[$aclLeaf.FullName] = New-AclFixture $adminSid @((New-AclRule $usersSid 'WriteData'))
Assert-Throws { & $sealedImplementation $aclLeaf.FullName $controllerSid } 'write permission on controller leaf'
$script:aclRows[$aclLeaf.FullName] = New-AclFixture $adminSid @((New-AclRule $adminSid 'FullControl'))
$script:aclRows[$aclLeaf.FullName].sddl = 'D:NO_ACCESS_CONTROL'
Assert-Throws { & $sealedImplementation $aclLeaf.FullName $controllerSid } 'null controller DACL'
$script:aclRows[$aclLeaf.FullName].sddl = ''
Assert-Throws { & $sealedImplementation $aclLeaf.FullName $controllerSid } 'missing controller DACL'
$script:aclRows[$aclLeaf.FullName].sddl = 'D:'
$trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$script:aclRows[$aclParent.FullName] = New-AclFixture $trustedInstaller @((New-AclRule $trustedInstaller 'FullControl'),(New-AclRule $usersSid 'ReadAndExecute'))
& $sealedImplementation $aclLeaf.FullName $controllerSid
$aclParent.FullName = 'C:\Users\private-profile\mutable-tool-cache'
$aclLeaf.FullName = Join-Path $aclParent.FullName 'powershell'
$script:aclRows[$aclLeaf.FullName] = New-AclFixture $adminSid @((New-AclRule $adminSid 'FullControl'))
$script:aclRows[$aclParent.FullName] = New-AclFixture $adminSid @((New-AclRule $usersSid 'DeleteSubdirectoriesAndFiles'))
$message = ''
try { & $sealedImplementation $aclLeaf.FullName $controllerSid } catch { $message = $_.Exception.Message }
if ($message -notmatch 'principal=S-1-5-32-545' -or $message -notmatch 'rights=DeleteSubdirectoriesAndFiles' -or $message -notmatch 'category=ancestor' -or $message -match 'private-profile' -or $message -notmatch '\[profile\]') { throw 'ACL failure diagnostics did not identify and redact the rejected ancestor' }
$script:accountAttempts = 0; $script:toolChecked = $false; $script:saved = @{}
function Save-SpikeJson($Value, [string]$Path) { if ($Path -like '*proof.json') { throw 'Simulated evidence export failure' }; $script:saved[$Path] = $Value }
function Test-Path { param($LiteralPath,$Path) $false }
function New-Item { param($ItemType,$Path) }
function Set-SpikeAcl { param($Path,$Sid,$Rights) }
function Assert-SpikeSealed { param($Path,$ControllerSid) }
function Get-ChildItem { param($LiteralPath,[switch]$File,$Filter,$ErrorAction) }
function Install-SpikeTools {
  param($Root,$Pwsh,$Node)
  $script:toolChecked = $true
  & $sealedImplementation $aclLeaf.FullName $controllerSid
}
function New-LocalUser { param($Name,$Password,[switch]$AccountNeverExpires,[switch]$PasswordNeverExpires) $script:accountAttempts++; throw 'Account creation preceded immutable tool preparation' }
$oldTemp = $env:RUNNER_TEMP; $env:RUNNER_TEMP = 'C:\mutable-runner-temp'
try { Invoke-SpikeRun 1>$null 3>$null } catch { $setupError = $_.Exception.Message } finally { $env:RUNNER_TEMP = $oldTemp }
if (!$script:toolChecked -or $script:accountAttempts -ne 0 -or $setupError -notmatch 'category=ancestor') { throw 'Setup reached account creation before rejecting the replaceable bootstrap runtime' }
Remove-Item Function:\Test-Path,Function:\New-Item,Function:\Get-ChildItem,Function:\New-LocalUser
Remove-Item Function:\Get-Item,Function:\Get-Acl
$script:sealedPaths = [Collections.Generic.List[string]]::new(); $script:copies = [Collections.Generic.List[string]]::new(); $script:copyMismatch = $false
$script:runtimeFixture = @('pwsh.exe','engine.dll','Modules\fixture.psm1')
function Assert-SpikeSealed([string]$Path) { $script:sealedPaths.Add($Path); if ($Path -like 'C:\mutable-runtime*') { throw 'Mutable bootstrap runtime rejected' } }
function Get-Item([string]$LiteralPath) { [pscustomobject]@{ FullName = $LiteralPath; Attributes = [IO.FileAttributes]::Normal; PSIsContainer = $LiteralPath -notmatch '\.exe$' } }
function Get-ChildItem([string]$LiteralPath, [switch]$Recurse, [switch]$Force) {
  foreach ($relative in $script:runtimeFixture) { [pscustomobject]@{ FullName = (Join-Path $LiteralPath $relative); PSIsContainer = $false } }
}
function New-Item { param($ItemType,$Path) }
function Copy-Item { param($LiteralPath,$Destination,[switch]$Recurse,[Parameter(ValueFromPipeline)]$InputObject) process { $script:copies.Add($Destination) } }
function Get-FileHash([string]$LiteralPath) {
  $digit = switch ([IO.Path]::GetFileName($LiteralPath)) { 'fixture.psm1' { 'C' } 'engine.dll' { 'B' } default { 'A' } }
  if ($script:copyMismatch -and $LiteralPath -eq 'C:\Program Files\T00-sealed\powershell\engine.dll') { $digit = 'D' }
  @{ Hash = $digit * 64 }
}
$installed = & $installImplementation 'C:\Program Files\T00-sealed' 'C:\sealed-bootstrap\pwsh.exe' 'D:\mutable-cache\node.exe'
if ($installed.node -cne 'C:\Program Files\T00-sealed\node.exe' -or $installed.pwsh -cne 'C:\Program Files\T00-sealed\powershell\pwsh.exe' -or $installed.runtimeFiles -ne 3 -or $installed.runtimeHash -notmatch '^[a-f0-9]{64}$') { throw 'Tools escaped the sealed run root or omitted runtime dependencies' }
$expectedManifest = '{"schema":1,"files":{"Modules/fixture.psm1":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","engine.dll":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","pwsh.exe":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}'
$expectedHash = '7ec711547ea816345580875e380472652c1b05a8f7f2320f2c163e59cda8ca1b'
if (!$installed.runtimeManifest) { throw 'Missing retained PowerShell runtime manifest' }
if ($installed.runtimeManifest -cne $expectedManifest -or $installed.runtimeHash -cne $expectedHash) { throw 'PowerShell runtime manifest bytes or SHA-256 differ from the canonical fixture' }
[array]::Reverse($script:runtimeFixture)
$reordered = & $installImplementation 'C:\Program Files\T00-sealed' 'C:\sealed-bootstrap\pwsh.exe' 'D:\mutable-cache\node.exe'
if ($reordered.runtimeManifest -cne $expectedManifest -or $reordered.runtimeHash -cne $expectedHash) { throw 'PowerShell runtime manifest depends on file enumeration order' }
foreach ($target in @('C:\Program Files\T00-sealed\powershell\engine.dll','C:\Program Files\T00-sealed\powershell\Modules\fixture.psm1','C:\Program Files\T00-sealed\node.exe')) { if ($script:sealedPaths -notcontains $target) { throw 'Copied tool dependency ACL was not verified' } }
$script:copyMismatch = $true
Assert-Throws { & $installImplementation 'C:\Program Files\T00-sealed' 'C:\sealed-bootstrap\pwsh.exe' 'D:\mutable-cache\node.exe' } 'changed runtime copy bytes'
$script:copies.Clear()
Assert-Throws { & $installImplementation 'C:\Program Files\T00-sealed' 'C:\mutable-runtime\pwsh.exe' 'D:\mutable-cache\node.exe' } 'replaceable parent bootstrap runtime'
if ($script:copies.Count) { throw 'Tool copying started before bootstrap trust validation' }
Remove-Item Function:\Get-Item,Function:\Get-ChildItem,Function:\New-Item,Function:\Copy-Item,Function:\Get-FileHash
$script:rejectAck = $true; $script:mainAncestor = $true; $script:supervisorAncestor = $true; $script:sealedChecks = [Collections.Generic.List[string]]::new()
$script:fakeMain = $PID + 100000; $script:fakeSupervisor = $PID + 200000; $script:fakeChild = $PID + 300000
$manifest.mainPid = $script:fakeMain; $manifest.root = 'C:\sealed'; $manifest.controllerSid = 'S-1-5-21-500'
$manifest.script = $script:spikeSource; $manifest.pwsh = 'C:\sealed\pwsh.exe'; $manifest.node = 'C:\sealed\node.exe'
$State = 'C:\sealed\manifest.json'; $Mode = 'Watchdog'
function Get-SpikeSid { 'S-1-5-18' }
function Assert-SpikeSealed($Path, $ControllerSid) { $script:sealedChecks.Add($Path) }
function Get-ChildItem { param($Path) if ($script:overrideEnv) { $script:environmentRows } elseif ($script:rejectAck) { [pscustomobject]@{ Name = 'GITHUB_TEST_SECRET'; Value = 'secret-value-sentinel' }; [pscustomobject]@{ Name = 'UNRELATED'; Value = 'other-secret-value-sentinel' } } }
function Get-CimInstance {
  param($ClassName,$Filter)
  $parent = if ($Filter -eq "ProcessId=$PID" -and $script:rejectAck) { if ($script:mainAncestor) { $script:fakeMain } elseif ($script:supervisorAncestor) { $script:fakeSupervisor } else { 0 } } elseif ($Filter -eq "ProcessId=$script:fakeMain" -and $script:supervisorAncestor) { $script:fakeSupervisor } else { 0 }
  [pscustomobject]@{ ParentProcessId = $parent }
}
function Get-FileHash { param($Path) @{ Hash = ('a' * 64) } }
function Read-SpikeJson([string]$Path) { @{ id = $(if ($Path -like '*supervisor.json') { $script:fakeSupervisor } else { $script:fakeChild }); start = 123 } }
function Get-Process { param($Id,$ErrorAction) [pscustomobject]@{ StartTime = [DateTime]::new(123, [DateTimeKind]::Utc); Handle = 42 } }
function Get-NetAdapter { param([switch]$IncludeHidden) [pscustomobject]@{ mock = $true } }
function Get-SpikeAdapterMatches($Adapter,$Objects) { [pscustomobject]@{ mock = $true } }
function Get-SpikeInventory { @{ adapters = $(if ($script:rejectAck) { @($manifest.adapters[0],$manifest.adapters[1]) } else { @($manifest.adapters) }) } }
function Wait-SpikeFile { param($Path,$Seconds) @{ tick = 100; deadline = 100 + 15 * [Diagnostics.Stopwatch]::Frequency; child = @{ id = $script:fakeChild; start = 123 }; supervisor = @{ id = $script:fakeSupervisor; start = 123 } } }
function Invoke-SpikeRecovery { param($Manifest,$Arm,$Path) @{ pass = $true } }
$parseTokens = $null; $parseErrors = $null
$sourceAst = [Management.Automation.Language.Parser]::ParseFile($source, [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Unable to parse watchdog dispatch' }
$dispatch = $sourceAst.EndBlock.Statements[-1].Extent.Text
$script:saved = @{}
try { Invoke-Expression $dispatch } catch { $watchdogError = $_.Exception.Message }
$failure = $script:saved['C:\sealed\watchdog-error.json']
if (!$failure.ackFailure) { throw "Watchdog ACK failure diagnostics are missing: $watchdogError" }
if ($watchdogError -cne 'Missing or invalid independent SYSTEM watchdog acknowledgement: tracking,ancestry,snapshot' -or $failure.error -cne $watchdogError) { throw 'Watchdog did not retain each rejected ACK predicate' }
if ($script:saved.Count -ne 1 -or $script:sealedChecks[-1] -cne $manifest.root) { throw 'Rejected ACK was published or the watchdog failure path was not sealed' }
$detail = $failure.ackFailure
if (@($detail.trackingNames).Count -ne 1 -or $detail.trackingNames[0] -cne 'GITHUB_TEST_SECRET' -or !$detail.mainInAncestors -or !$detail.supervisorInAncestors) { throw 'ACK failure lost tracking names or ancestor membership' }
if ($detail.expectedAdapterCount -ne 3 -or $detail.actualAdapterCount -ne 2) { throw 'ACK failure lost adapter counts' }
$expectedKey = Get-SpikeAdapterKey $manifest.adapters; $actualKey = Get-SpikeAdapterKey @($manifest.adapters[0],$manifest.adapters[1])
$expectedHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($expectedKey))).ToLowerInvariant()
$actualHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($actualKey))).ToLowerInvariant()
if ($detail.expectedKeyHash -cne $expectedHash -or $detail.actualKeyHash -cne $actualHash -or $expectedHash -ceq $actualHash) { throw 'ACK failure did not hash both canonical keys' }
$failureJson = $failure | ConvertTo-Json -Depth 16
$publicFailureJson = Protect-SpikeEvidence $failureJson $manifest $manifest.root
if ($failureJson.Contains('secret-value-sentinel') -or $failureJson.Contains($expectedKey) -or $failureJson.Contains($actualKey) -or $publicFailureJson.Contains('secret-value-sentinel') -or $publicFailureJson.Contains($expectedKey) -or $publicFailureJson.Contains($actualKey)) { throw 'ACK diagnostics exposed a value or canonical key' }
$publicDetail = ($publicFailureJson | ConvertFrom-Json -AsHashtable).ackFailure
if ($publicDetail.expectedKeyHash -cne $expectedHash -or $publicDetail.actualKeyHash -cne $actualHash) { throw 'Evidence redaction changed the canonical key hashes' }
foreach ($role in @('main','supervisor')) {
  $script:mainAncestor = $role -eq 'main'; $script:supervisorAncestor = $role -eq 'supervisor'; $script:saved = @{}; $script:ackFailure = $null
  try { Invoke-Expression $dispatch } catch { }
  $roleDetail = $script:saved['C:\sealed\watchdog-error.json'].ackFailure
  if ($roleDetail.mainInAncestors -ne $script:mainAncestor -or $roleDetail.supervisorInAncestors -ne $script:supervisorAncestor) { throw "ACK diagnostics confused the $role ancestor" }
}
$script:rejectAck = $false; $script:saved = @{}; $script:ackFailure = $null
Invoke-Expression $dispatch
$validAck = $script:saved['C:\sealed\ack.json']
if (!$validAck -or $script:saved.ContainsKey('C:\sealed\watchdog-error.json') -or !$script:saved.ContainsKey('C:\sealed\armed.json')) { throw 'Valid watchdog ACK path did not reach armed state' }
Assert-SpikeAck $validAck $manifest
if (@($validAck.Keys).Count -ne 6 -or !$validAck.trackingAbsent -or !$validAck.independent -or $validAck.snapshot -cne $expectedKey) { throw 'Valid ACK fields or snapshot changed' }
foreach ($case in @(@('missing',''),@('pid','pid'),@('sid','sid'),@('tracking','trackingAbsent'),@('ancestry','independent'),@('snapshot','snapshot'))) {
  $badAck = if ($case[0] -eq 'missing') { $null } else { $ack.Clone() }
  if ($badAck) { $badAck[$case[1]] = $null }
  $diagnostic = $null; try { Assert-SpikeAck $badAck $manifest } catch { $diagnostic = $_.Exception.Message }
  if ($diagnostic -cne "Missing or invalid independent SYSTEM watchdog acknowledgement: $($case[0])") { throw "Incorrect ACK failure label: $($case[0])" }
}
$cacheVariable = [pscustomobject]@{ Name = 'ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE' }
$script:cacheValueReads = 0
$cacheVariable | Add-Member -MemberType ScriptProperty -Name Value -Value { $script:cacheValueReads++; 'cache-value-sentinel' }
$null = $cacheVariable.Value; if ($script:cacheValueReads -ne 1) { throw 'Cache value read sentinel is not working' }; $script:cacheValueReads = 0
$script:overrideEnv = $true; $script:environmentRows = @($cacheVariable); $script:saved = @{}; $script:ackFailure = $null
$cacheError = $null; try { Invoke-Expression $dispatch } catch { $cacheError = $_.Exception.Message }
if (!$script:saved.ContainsKey('C:\sealed\armed.json')) { throw "Cache-only watchdog did not arm: $cacheError" }
if (!$script:saved['C:\sealed\ack.json'].trackingAbsent -or $script:saved.ContainsKey('C:\sealed\watchdog-error.json')) { throw 'Cache-only watchdog published an invalid ACK' }
if ($script:cacheValueReads -ne 0 -or ($script:saved | ConvertTo-Json -Depth 16).Contains('cache-value-sentinel')) { throw 'Watchdog read or published the cache value' }
foreach ($name in @('RUNNER_TRACKING_ID','GITHUB_TOKEN','ACTIONS_RUNTIME_TOKEN','ACTIONS_UNKNOWN_MARKER','ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE_SUFFIX','actions_runner_action_archive_cache')) {
  $script:environmentRows = @($cacheVariable,[pscustomobject]@{ Name = $name; Value = 'tracking-value-sentinel' }); $script:saved = @{}; $script:ackFailure = $null
  try { Invoke-Expression $dispatch } catch { }
  $blocked = $script:saved['C:\sealed\watchdog-error.json']
  if ($script:saved.Count -ne 1 -or $blocked.error -cne 'Missing or invalid independent SYSTEM watchdog acknowledgement: tracking' -or @($blocked.ackFailure.trackingNames).Count -ne 1 -or $blocked.ackFailure.trackingNames[0] -cne $name) { throw "Tracking marker was accepted or misreported: $name" }
  $blockedJson = $blocked | ConvertTo-Json -Depth 16; $publicBlocked = Protect-SpikeEvidence $blockedJson $manifest $manifest.root
  if ($script:cacheValueReads -ne 0 -or $blockedJson.Contains('tracking-value-sentinel') -or $publicBlocked.Contains('tracking-value-sentinel') -or $blockedJson.Contains('cache-value-sentinel') -or $publicBlocked.Contains('cache-value-sentinel')) { throw 'Environment value was read or escaped diagnostics' }
}
Write-Output 'PASS hosted spike guards, recovery fences, deadline independence and immutable-path ACL checks (platform operations mocked)'
