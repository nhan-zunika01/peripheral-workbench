#requires -Version 7.5
[CmdletBinding()]
param([ValidateSet('Run','Supervisor','Watchdog','Monitor','Child')][string]$Mode = 'Run',
  [ValidateSet('normal','supervisor-death')][string]$Scenario = 'normal', [string]$State,
  [ValidateSet('before','during','after')][string]$Stage = 'before', [string]$Output = 'test-results/t00-spike')
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$script:spikeSource = $PSCommandPath
$script:spikeHandles = @{}
$script:spikeAdapterHandles = @{}
function Get-SpikeTick { [Diagnostics.Stopwatch]::GetTimestamp() }
function Get-SpikeSid { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
function Test-SpikeProcess($Identity) {
  $process = if ($script:spikeHandles.ContainsKey([string]$Identity.id)) { $script:spikeHandles[[string]$Identity.id] } else { Get-Process -Id $Identity.id -ErrorAction SilentlyContinue }
  if (!$process) { return $false }
  if ($process.HasExited) { return $false }
  if ($process.StartTime.ToUniversalTime().Ticks -ne $Identity.start) { throw 'Recorded process PID was reused' }
  $true
}
function Save-SpikeJson($Value, [string]$Path) {
  $Value | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath "$Path.tmp"
  Move-Item -LiteralPath "$Path.tmp" -Destination $Path -Force
}
function Read-SpikeJson([string]$Path) { Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable }
function Get-SpikePlatform {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  @{ windows = $IsWindows; admin = ([Security.Principal.WindowsPrincipal]$identity).IsInRole('Administrators'); actions = $env:GITHUB_ACTIONS
    runner = $env:RUNNER_ENVIRONMENT; workflow = $env:GITHUB_WORKFLOW; job = $env:GITHUB_JOB; temp = $env:RUNNER_TEMP; branch = $env:GITHUB_REF }
}
function Assert-SpikeHost($Context) {
  if (!$Context.windows -or !$Context.admin -or $Context.actions -cne 'true' -or $Context.runner -cne 'github-hosted' -or
    $Context.workflow -cne 'T00 disconnect feasibility' -or $Context.job -cne 'spike' -or
    $Context.branch -cne 'refs/heads/codex/t00-offline-spike' -or $Context.temp -notmatch '^[A-Za-z]:\\[^\r\n]+$') { throw 'Restricted to the reviewed experimental GitHub-hosted Windows job' }
}
function ConvertTo-SpikeAdapter($Adapter) {
  @{ guid = [string]$Adapter.InterfaceGuid; device = $Adapter.PnPDeviceID; index = $Adapter.ifIndex; admin = [string]$Adapter.AdminStatus; status = [string]$Adapter.Status
    identityProperties = @{ deviceId = $Adapter.DeviceID; interfaceName = $Adapter.InterfaceName; netLuid = [string]$Adapter.NetLuid; interfaceIndex = $Adapter.InterfaceIndex; interfaceAdminStatus = $Adapter.InterfaceAdminStatus; hidden = $Adapter.Hidden; virtual = $Adapter.Virtual; hardware = $Adapter.HardwareInterface; state = $Adapter.State; availability = $Adapter.Availability; configManagerErrorCode = $Adapter.ConfigManagerErrorCode } }
}
function Get-SpikeAdapterIdentity($Adapter) {
  $p = $Adapter.identityProperties
  $identity = [ordered]@{ guid = ([guid]$Adapter.guid).ToString(); device = $Adapter.device; deviceId = $p.deviceId; interfaceName = $p.interfaceName; netLuid = $p.netLuid; virtual = $p.virtual; hardware = $p.hardware; hidden = $p.hidden } | ConvertTo-Json -Compress
  [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($identity)))
}
function Get-SpikeAdapterMatches($Adapter, $Objects) {
  $identity = Get-SpikeAdapterIdentity $Adapter
  @($Objects | Where-Object { (Get-SpikeAdapterIdentity (ConvertTo-SpikeAdapter $_)) -ceq $identity })
}
function Get-SpikeAdapterKey($Adapters, [bool]$IncludeIndex = $true) {
  (@($Adapters | Sort-Object guid | ForEach-Object { $index = if ($IncludeIndex) { "$($_.index)|$($_.identityProperties.interfaceIndex)" } else { '' }; "$(Get-SpikeAdapterIdentity $_)|$($_.admin)|$($_.identityProperties.interfaceAdminStatus)|$index" }) -join ';')
}
function Assert-SpikeManifest($Manifest) {
  if ($Manifest.schema -ne 1 -or $Manifest.seconds -ne 15 -or !$Manifest.mainPid -or $Manifest.scriptHash -notmatch '^[a-f0-9]{64}$' -or !@($Manifest.adapters).Count) { throw 'Malformed recovery manifest' }
  Assert-SpikeAdapters $Manifest.adapters
  if (!@($Manifest.adapters | Where-Object admin -eq 'Up').Count) { throw 'No enabled external adapter' }
}
function Assert-SpikeAdapters($Adapters) {
  $seen = @{ guid = @{}; deviceId = @{}; interfaceName = @{}; netLuid = @{}; index = @{} }; $row = 0
  foreach ($adapter in $Adapters) {
    $guid = [guid]::Empty; $index = [uint32]0; $luid = [uint64]0; $issues = @(); $p = $adapter.identityProperties
    if (![guid]::TryParse($adapter.guid, [ref]$guid) -or $guid -eq [guid]::Empty) { $issues += 'guid-missing-or-invalid' }
    $nonPnp = $null -eq $adapter.device -and $p.virtual -is [bool] -and $p.virtual -and $p.hardware -is [bool] -and !$p.hardware
    if (!$nonPnp -and ($adapter.device -isnot [string] -or [string]::IsNullOrWhiteSpace($adapter.device))) { $issues += 'pnp-device-missing' }
    foreach ($field in @('deviceId','interfaceName')) { if ($p.$field -isnot [string] -or [string]::IsNullOrWhiteSpace($p.$field)) { $issues += "$field-missing-or-invalid" } }
    if (![uint64]::TryParse([string]$p.netLuid, [Globalization.NumberStyles]::None, [Globalization.CultureInfo]::InvariantCulture, [ref]$luid) -or !$luid) { $issues += 'net-luid-invalid' }
    if (![uint32]::TryParse([string]$adapter.index, [ref]$index) -or !$index) { $issues += 'interface-index-invalid' }
    if ([string]$p.interfaceIndex -cne [string]$index) { $issues += 'interface-index-inconsistent' }
    if ($adapter.admin -notin @('Up','Down')) { $issues += 'admin-state-unknown' }
    $admin = if ($adapter.admin -eq 'Up') { 1 } elseif ($adapter.admin -eq 'Down') { 2 } else { 0 }
    if ([string]$p.interfaceAdminStatus -cne [string]$admin) { $issues += 'admin-state-inconsistent' }
    $ids = @{ guid = $guid.ToString(); deviceId = $p.deviceId; interfaceName = $p.interfaceName; netLuid = [string]$luid; index = [string]$index }
    foreach ($field in $seen.Keys) { if ($seen[$field].ContainsKey([string]$ids[$field])) { $issues += "duplicate-$field" } }
    $category = if ($adapter.identityProperties.hidden) { 'hidden' } elseif ($adapter.identityProperties.virtual) { 'virtual' } elseif ($adapter.identityProperties.hardware) { 'hardware' } else { 'unspecified' }
    if ($issues.Count) { throw "Invalid adapter row=$row category=$category fields=$($issues -join ',') admin=$($adapter.admin)" }
    foreach ($field in $seen.Keys) { $seen[$field][[string]$ids[$field]] = $true }; $row++
  }
}
function Protect-SpikeEvidence([string]$Text, $Manifest, [string]$Root) {
  $identities = @($Manifest.adapters | ForEach-Object { $_.guid; $_.device; $_.identityProperties.deviceId; $_.identityProperties.interfaceName; $_.identityProperties.netLuid } | Where-Object { ![string]::IsNullOrWhiteSpace([string]$_) -and [string]$_ -ne '0' } | ForEach-Object { [string]$_ } | Select-Object -Unique | Sort-Object Length -Descending)
  foreach ($identity in $identities) {
    $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($identity))).ToLowerInvariant()
    $Text = $Text.Replace($identity, "sha256:$hash").Replace(($identity | ConvertTo-Json -Compress).Trim('"'), "sha256:$hash")
  }
  if (![string]::IsNullOrWhiteSpace($Root)) { $Text = $Text.Replace($Root, '[controller]').Replace(($Root | ConvertTo-Json -Compress).Trim('"'), '[controller]') }
  $Text
}
function Assert-SpikeArm($Arm, $Manifest) {
  if (!$Arm -or $Arm.tick -le 0 -or $Arm.deadline -ne ($Arm.tick + $Manifest.seconds * [Diagnostics.Stopwatch]::Frequency) -or $Arm.child.id -le 0 -or $Arm.child.start -le 0 -or $Arm.supervisor.id -le 0 -or $Arm.supervisor.start -le 0) { throw 'Malformed monotonic arm or process identity' }
}
function Assert-SpikeAck($Ack, $Manifest) {
  $failed = @(if (!$Ack) { 'missing' } else { if ($Ack.pid -le 0) { 'pid' }; if ($Ack.sid -cne 'S-1-5-18') { 'sid' }; if ($Ack.trackingAbsent -ne $true) { 'tracking' }; if ($Ack.independent -ne $true) { 'ancestry' }; if ($Ack.snapshot -cne (Get-SpikeAdapterKey $Manifest.adapters)) { 'snapshot' } })
  if ($failed.Count) { throw "Missing or invalid independent SYSTEM watchdog acknowledgement: $($failed -join ',')" }
}
function Assert-SpikeProbe($Probe, [bool]$Connected) {
  if ($Probe.connected -isnot [bool] -or $Probe.connected -ne $Connected -or $Probe.loopback -ne $true) { throw 'Probe did not establish the required external/loopback state' }
}
function Get-SpikeInventory {
  $adapterObjects = @(Get-NetAdapter -IncludeHidden)
  $bindingObjects = @(Get-NetAdapterBinding -Name '*' -IncludeHidden -AllBindings -ErrorAction Stop)
  foreach ($binding in $bindingObjects) {
    if (@($adapterObjects | Where-Object { $_.Name -eq $binding.Name -and $_.InterfaceDescription -eq $binding.InterfaceDescription }).Count -ne 1) { throw 'Binding identity does not match exactly one inventoried adapter' }
  }
  $adapters = @($adapterObjects | ForEach-Object {
    $adapter = $_
    $record = ConvertTo-SpikeAdapter $adapter
    $record.bindings = @($bindingObjects | Where-Object { $_.Name -eq $adapter.Name -and $_.InterfaceDescription -eq $adapter.InterfaceDescription } | Select-Object ComponentID,Enabled)
    $record
  })
  $interfaces = @(Get-NetIPInterface | Select-Object InterfaceIndex,InterfaceAlias,AddressFamily,ConnectionState)
  $routes = @(Get-NetRoute | Select-Object InterfaceIndex,AddressFamily,DestinationPrefix,NextHop)
  $loopbackAddresses = @(Get-NetIPAddress -InterfaceIndex 1 | Select-Object -ExpandProperty IPAddress)
  if ($loopbackAddresses -notcontains '127.0.0.1' -or $loopbackAddresses -notcontains '::1' -or @($loopbackAddresses | Where-Object { $_ -notin @('127.0.0.1','::1') }).Count) { throw 'Built-in loopback identity is not accounted for' }
  $loopbacks = @(1)
  foreach ($interface in @($interfaces) + @($routes)) {
    if ($interface.InterfaceIndex -notin $adapters.index -and $interface.InterfaceIndex -notin $loopbacks) { throw 'Unaccounted IP interface or tunnel' }
  }
  @{ tick = (Get-SpikeTick); utc = [DateTime]::UtcNow.ToString('o'); adapters = $adapters; interfaces = $interfaces; routes = $routes }
}
function Set-SpikeAdapter($Adapter, [bool]$Enable) {
  if ($Adapter.admin -cne 'Up') { throw 'Only originally Up adapters may be mutated' }
  $objects = if ($Enable -and $script:spikeAdapterHandles.ContainsKey($Adapter.guid)) { @($script:spikeAdapterHandles[$Adapter.guid]) } else { @(Get-NetAdapter -IncludeHidden) }
  $actual = @(Get-SpikeAdapterMatches $Adapter $objects)
  if ($actual.Count -ne 1) { throw 'Recorded adapter identity changed' }
  if ($Enable) { $actual[0] | Enable-NetAdapter -Confirm:$false } else { $actual[0] | Disable-NetAdapter -Confirm:$false }
}
function Assert-SpikeSnapshot($Manifest, $Inventory, [bool]$Disabled, [bool]$IncludeIndex = $true) {
  Assert-SpikeAdapters $Inventory.adapters
  $expected = $Manifest.adapters | ConvertTo-Json -Depth 8 | ConvertFrom-Json -AsHashtable
  if ($Disabled) { foreach ($adapter in $expected) { $adapter.admin = 'Down'; $adapter.identityProperties.interfaceAdminStatus = 2 } }
  if ((Get-SpikeAdapterKey $expected $IncludeIndex) -cne (Get-SpikeAdapterKey $Inventory.adapters $IncludeIndex)) { throw 'Adapter inventory or administrative state mismatch' }
}
function Stop-SpikeChild($Child, [bool]$RequireCleanExit = $false) {
  $process = if ($script:spikeHandles.ContainsKey([string]$Child.id)) { $script:spikeHandles[[string]$Child.id] } else { Get-Process -Id $Child.id -ErrorAction SilentlyContinue }
  if (!$process) { return !$RequireCleanExit }
  if ($process.StartTime.ToUniversalTime().Ticks -ne $Child.start) { throw 'Child PID was reused' }
  if ($process.HasExited) { return (!$RequireCleanExit -or $process.ExitCode -eq 0) }
  if ($RequireCleanExit -and $process.WaitForExit(500)) { return $process.ExitCode -eq 0 }
  $process.Kill()
  if (!$process.WaitForExit(500)) { throw 'Process termination was not confirmed within 500ms' }
  # shortcut: forced probe exit cannot prove descendant cleanup; keep NICs disabled until full Job Object containment exists.
  !$RequireCleanExit
}
function Wait-SpikeTick([long]$Deadline) { while ((Get-SpikeTick) -lt $Deadline) { Start-Sleep -Milliseconds 10 } }
function Test-SpikeRelease($Manifest, $Arm) {
  try {
    if (!(Test-Path -LiteralPath "$($Manifest.root)\disabler-complete.json")) { return $false }
    $complete = Read-SpikeJson "$($Manifest.root)\disabler-complete.json"
    if ($complete.armTick -ne $Arm.tick -or $complete.deadline -ne $Arm.deadline -or $complete.supervisor.id -ne $Arm.supervisor.id -or $complete.supervisor.start -ne $Arm.supervisor.start -or $complete.scriptHash -cne $Manifest.scriptHash -or $complete.completedTick -lt $Arm.tick -or $complete.completedTick -ge $Arm.deadline -or $complete.inventory.tick -gt $complete.completedTick -or $complete.inventory.tick -lt $Arm.tick) { return $false }
    Assert-SpikeSnapshot $Manifest $complete.inventory $true $false
    if (@($complete.inventory.adapters | Where-Object { $_.bindings -isnot [Collections.IList] }).Count) { return $false }
    if ($complete.inventory.interfaces -isnot [Collections.IList] -or $complete.inventory.routes -isnot [Collections.IList]) { return $false }
    foreach ($interface in @($complete.inventory.interfaces) + @($complete.inventory.routes)) { if ($interface.InterfaceIndex -notin $complete.inventory.adapters.index -and $interface.InterfaceIndex -ne 1) { return $false } }
    $true
  } catch { $false }
}
function Invoke-SpikeRecovery($Manifest, $Arm, [string]$Receipt) {
  Assert-SpikeManifest $Manifest; Assert-SpikeArm $Arm $Manifest
  $result = @{ pass = $true; deadline = $Arm.deadline; childStopped = $false; supervisorStopped = $false; networkHeld = $false; errors = @(); after = $null }
  Wait-SpikeTick $Arm.deadline
  Save-SpikeJson @{ tick = (Get-SpikeTick); deadline = $Arm.deadline } "$($Manifest.root)\recovery-fence.json"
  $canRestore = $true
  try {
    if (Test-SpikeProcess $Arm.supervisor) { $canRestore = $false; $result.errors += 'Disabler remained live at deadline; queued adapter work cannot be excluded' }
    $result.supervisorStopped = Stop-SpikeChild $Arm.supervisor
  } catch { $canRestore = $false; $result.errors += $_.Exception.Message }
  try { $result.childStopped = Stop-SpikeChild $Arm.child $true } catch { $canRestore = $false; $result.errors += $_.Exception.Message }
  if ($result.childStopped -ne $true -or $result.supervisorStopped -ne $true) { $canRestore = $false }
  if (!(Test-SpikeRelease $Manifest $Arm)) { $canRestore = $false; $result.errors += 'No valid completed-disabler receipt; pending disable operations cannot be excluded' }
  if (!$canRestore) {
    $result.pass = $false; $result.networkHeld = $true; $result.errors += 'NICs remain disabled because safe restoration was not established; disposable VM teardown is required'
    Save-SpikeJson $result $Receipt
    return $result
  }
  $result.restoreStart = Get-SpikeTick
  if ($result.restoreStart -gt ($Arm.deadline + [Diagnostics.Stopwatch]::Frequency)) { $result.pass = $false; $result.errors += 'Restoration started over one second after the deadline' }
  foreach ($adapter in $Manifest.adapters | Where-Object admin -eq 'Up') {
    try { Set-SpikeAdapter $adapter $true } catch { $result.pass = $false; $result.errors += $_.Exception.Message }
  }
  try { $result.after = Get-SpikeInventory; Assert-SpikeSnapshot $Manifest $result.after $false } catch { $result.pass = $false; $result.errors += $_.Exception.Message }
  $result.restoreEnd = Get-SpikeTick
  Save-SpikeJson $result $Receipt
  $result
}
function Set-SpikeAcl([string]$Path, [string]$Sid, [string]$Rights = 'ReadAndExecute') {
  $acl = [Security.AccessControl.DirectorySecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetOwner([Security.Principal.SecurityIdentifier]'S-1-5-32-544')
  foreach ($entry in @(@('S-1-5-18','FullControl'), @('S-1-5-32-544','FullControl'), @($Sid,$Rights))) {
    if ($entry[0]) { $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]$entry[0], $entry[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')) }
  }
  Set-Acl -LiteralPath $Path -AclObject $acl
}
function Assert-SpikeSealed([string]$Path, [string]$ControllerSid = ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value)) {
  # Windows' servicing account owns Program Files; its SID cannot belong to the standard test account.
  $trustedSids = @('S-1-5-18','S-1-5-32-544',$ControllerSid,'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
  $current = Get-Item -LiteralPath $Path
  while ($current) {
    $category = if ($current.FullName -eq $Path) { 'leaf' } else { 'ancestor' }
    $safePath = $current.FullName -replace '(?i)([A-Z]:\\Users\\)[^\\]+', '$1[profile]'
    if ($current.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Unsafe ACL path category=$category path=$safePath rights=ReparsePoint" }
    $acl = Get-Acl -LiteralPath $current.FullName
    $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
    if ($owner -notin $trustedSids) { throw "Untrusted ACL principal=$owner rights=Owner/WriteDacl category=$category path=$safePath" }
    $sddl = $acl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
    if ($sddl -notmatch 'D:' -or $sddl -match 'NO_ACCESS_CONTROL') { throw "Untrusted ACL principal=Everyone rights=NullDacl category=$category path=$safePath" }
    foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
      if ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) { continue }
      $trusted = $rule.IdentityReference.Value -in $trustedSids
      $danger = [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
      if ($current.FullName -eq $Path -or !$current.PSIsContainer) { $danger = $danger -bor [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete }
      if (!$trusted -and $rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band $danger)) { throw "Untrusted ACL principal=$($rule.IdentityReference.Value) rights=$($rule.FileSystemRights) category=$category path=$safePath" }
    }
    $current = if ($current.PSIsContainer) { $current.Parent } else { $current.Directory }
  }
}
function Install-SpikeTools([string]$Root, [string]$Pwsh, [string]$Node) {
  Assert-SpikeSealed $Root
  $sourceRoot = Split-Path -Parent $Pwsh
  $sourceItems = @(Get-Item -LiteralPath $sourceRoot) + @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -Force)
  foreach ($item in $sourceItems) { Assert-SpikeSealed $item.FullName }
  if ((Get-Item -LiteralPath $Node).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Node preparation source is a reparse point' }
  $runtime = Join-Path $Root 'powershell'
  New-Item -ItemType Directory -Path $runtime | Out-Null
  Get-ChildItem -LiteralPath $sourceRoot -Force | Copy-Item -Destination $runtime -Recurse
  $nodeCopy = Join-Path $Root 'node.exe'; Copy-Item -LiteralPath $Node -Destination $nodeCopy
  $nodeHash = (Get-FileHash -LiteralPath $Node).Hash
  if ((Get-FileHash -LiteralPath $nodeCopy).Hash -cne $nodeHash) { throw 'Node copy bytes differ from the provisioned source' }
  Assert-SpikeSealed $nodeCopy
  $files = foreach ($item in $sourceItems) {
    $relative = [IO.Path]::GetRelativePath($sourceRoot, $item.FullName)
    $destination = [IO.Path]::GetFullPath((Join-Path $runtime $relative))
    if ($destination -ne $runtime -and !$destination.StartsWith("$runtime\", [StringComparison]::OrdinalIgnoreCase)) { throw 'PowerShell copy escaped the immutable runtime' }
    Assert-SpikeSealed $destination
    if (!$item.PSIsContainer) {
      $hash = (Get-FileHash -LiteralPath $item.FullName).Hash
      if ((Get-FileHash -LiteralPath $destination).Hash -cne $hash) { throw 'PowerShell runtime copy bytes differ from the provisioned source' }
      @{ path = $relative; sha256 = $hash.ToLowerInvariant() }
    }
  }
  $receipt = @($files | Sort-Object path) | ConvertTo-Json -Compress
  @{ pwsh = (Join-Path $runtime 'pwsh.exe'); node = $nodeCopy; runtimeFiles = @($files).Count; runtimeHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($receipt))).ToLowerInvariant() }
}
function Wait-SpikeFile([string]$Path, [int]$Seconds = 30) {
  $until = (Get-SpikeTick) + $Seconds * [Diagnostics.Stopwatch]::Frequency
  while (!(Test-Path -LiteralPath $Path)) { if ((Get-SpikeTick) -gt $until) { throw "Timed out waiting for $([IO.Path]::GetFileName($Path))" }; Start-Sleep -Milliseconds 50 }
  Read-SpikeJson $Path
}
function Test-SpikeProbeWindow($Manifest, $Arm) { (Get-SpikeTick) -lt $Arm.deadline -and !(Test-Path -LiteralPath "$($Manifest.root)\recovery-fence.json") }
function Wait-SpikeProbeRelease($Manifest, $Arm) {
  while (Test-SpikeProbeWindow $Manifest $Arm) {
    if (Test-Path -LiteralPath "$($Manifest.root)\release.json") { return (Test-SpikeProbeWindow $Manifest $Arm) }
    Start-Sleep -Milliseconds 25
  }
  $false
}
function Start-SpikeMode($Manifest, [string]$ChildMode, [pscredential]$Credential, [string]$ChildStage = 'before') {
  $options = @{ FilePath = $Manifest.pwsh; ArgumentList = @('-NoProfile','-File',"`"$($Manifest.script)`"",'-Mode',$ChildMode,'-State',"`"$($Manifest.root)\manifest.json`"",'-Stage',$ChildStage); WorkingDirectory = $Manifest.root; WindowStyle = 'Hidden'; PassThru = $true }
  $logRoot = $Manifest.root
  $options.RedirectStandardOutput = "$logRoot\$ChildMode-$ChildStage.log"; $options.RedirectStandardError = "$logRoot\$ChildMode-$ChildStage.stderr"
  if ($Credential) {
    $clean = @{}; foreach ($item in Get-ChildItem Env:) { $clean[$item.Name] = $null }
    foreach ($name in @('SystemRoot','WINDIR','ComSpec','SystemDrive')) { $clean[$name] = [Environment]::GetEnvironmentVariable($name) }
    $clean.PATH = "$([IO.Path]::GetDirectoryName($Manifest.node));$([IO.Path]::GetDirectoryName($Manifest.pwsh));$env:SystemRoot\System32"
    $clean.TEMP = $Manifest.childRoot; $clean.TMP = $Manifest.childRoot; $clean.USERPROFILE = $Manifest.childRoot
    $options.Credential = $Credential; $options.LoadUserProfile = $true; $options.Environment = $clean
  }
  Start-Process @options
}
function Invoke-SpikeChild($Manifest, [string]$ChildStage) {
  $keep = @{}; foreach ($name in @('SystemRoot','WINDIR','ComSpec','SystemDrive')) { $keep[$name] = [Environment]::GetEnvironmentVariable($name) }
  foreach ($item in Get-ChildItem Env:) { [Environment]::SetEnvironmentVariable($item.Name, $null) }
  foreach ($name in $keep.Keys) { [Environment]::SetEnvironmentVariable($name, $keep[$name]) }
  $env:PATH = "$([IO.Path]::GetDirectoryName($Manifest.node));$([IO.Path]::GetDirectoryName($Manifest.pwsh));$env:SystemRoot\System32"
  $env:TEMP = $Manifest.childRoot; $env:TMP = $Manifest.childRoot; $env:USERPROFILE = $Manifest.childRoot
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $groups = @($identity.Groups | ForEach-Object Value)
  if ($identity.User.Value -cne $Manifest.sid -or $groups -contains 'S-1-5-32-544' -or $groups -contains 'S-1-5-32-556' -or ([Security.Principal.WindowsPrincipal]$identity).IsInRole('Administrators')) { throw 'Child is not the expected standard token' }
  $privileges = @(& "$env:SystemRoot\System32\whoami.exe" /priv /fo csv /nh)
  if ($LASTEXITCODE -ne 0 -or ($privileges -join '') -match 'Se(Debug|LoadDriver|Tcb|TakeOwnership|Impersonate|Backup|Restore)Privilege') { throw 'Unexpected child token privilege' }
  if ((Get-Content -LiteralPath "$($Manifest.root)\canary" -Raw).Trim() -cne 'immutable-t00') { throw 'Canary could not be read' }
  foreach ($target in @("$($Manifest.root)\canary", "$($Manifest.root)\forbidden")) {
    $denied = $false
    try { [IO.File]::WriteAllText($target, 'forbidden') } catch [UnauthorizedAccessException] { $denied = $true }
    if (!$denied) { throw 'Controller write was permitted' }
  }
  $profileCheck = Join-Path $env:USERPROFILE 'profile-check'; 'writable' | Set-Content -LiteralPath $profileCheck
  if ($ChildStage -eq 'during') {
    Save-SpikeJson @{ sid = $identity.User.Value; pid = $PID } "$($Manifest.childRoot)\ready.json"
    $arm = Wait-SpikeFile "$($Manifest.root)\arm.json" 60
    if (!(Wait-SpikeProbeRelease $Manifest $arm)) { return }
  }
  $start = Get-SpikeTick
  if ($ChildStage -eq 'during' -and !(Test-SpikeProbeWindow $Manifest $arm)) { return }
  $rows = @(& $Manifest.node $Manifest.probe $Manifest.address '443')
  if ($LASTEXITCODE -ne 0 -or $rows.Count -ne 1) { throw 'Finite Node probe failed' }
  $probe = $rows[0] | ConvertFrom-Json -AsHashtable
  Assert-SpikeProbe $probe ($ChildStage -ne 'during')
  Save-SpikeJson @{ sid = $identity.User.Value; groups = $groups; privileges = $privileges; canaryDenied = $true; outputWritable = $true; profileWritable = $true; start = $start; end = (Get-SpikeTick); probe = $probe } "$($Manifest.childRoot)\$ChildStage.json"
}
function Invoke-SpikeWatchdog($Manifest) {
  if ((Get-SpikeSid) -cne 'S-1-5-18') { throw 'Recovery requires SYSTEM' }
  Assert-SpikeManifest $Manifest
  foreach ($path in @($Manifest.root,$script:spikeSource,$State,$Manifest.pwsh,$Manifest.node)) { Assert-SpikeSealed $path $Manifest.controllerSid }
  if ($script:spikeSource -cne $Manifest.script -or (Get-FileHash $script:spikeSource).Hash.ToLowerInvariant() -cne $Manifest.scriptHash) { throw 'Recovery script identity mismatch' }
  $trackingNames = @(Get-ChildItem Env: | Where-Object { $_.Name -match '^(GITHUB_|ACTIONS_|RUNNER_TRACKING_ID$)' -and $_.Name -cne 'ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE' } | Select-Object -ExpandProperty Name); $trackingAbsent = !$trackingNames.Count # The runner action archive cache is not a tracking marker.
  $ancestors = @(); $ancestor = $PID
  while ($ancestor -gt 0) { $row = Get-CimInstance Win32_Process -Filter "ProcessId=$ancestor"; if (!$row) { break }; $ancestors += $ancestor; $ancestor = $row.ParentProcessId; if ($ancestor -in $ancestors) { throw 'Cyclic process ancestry' } }
  $supervisor = Read-SpikeJson "$($Manifest.root)\supervisor.json"
  foreach ($identity in @($supervisor,(Read-SpikeJson "$($Manifest.root)\child.json"))) {
    $process = Get-Process -Id $identity.id -ErrorAction Stop
    if ($process.StartTime.ToUniversalTime().Ticks -ne $identity.start) { throw 'Pre-arm process identity mismatch' }
    $null = $process.Handle
    $script:spikeHandles[[string]$identity.id] = $process
  }
  $adapterObjects = @(Get-NetAdapter -IncludeHidden)
  foreach ($adapter in $Manifest.adapters) {
    $matches = @(Get-SpikeAdapterMatches $adapter $adapterObjects)
    if ($matches.Count -ne 1) { throw 'Pre-arm adapter identity mismatch' }
    $script:spikeAdapterHandles[$adapter.guid] = $matches[0]
  }
  $snapshotAdapters = (Get-SpikeInventory).adapters; $ack = @{ pid = $PID; sid = 'S-1-5-18'; trackingAbsent = $trackingAbsent; independent = ($Manifest.mainPid -notin $ancestors -and $supervisor.id -notin $ancestors); ancestors = $ancestors; snapshot = (Get-SpikeAdapterKey $snapshotAdapters) }
  try { Assert-SpikeAck $ack $Manifest } catch {
    $keyHashes = @((Get-SpikeAdapterKey $Manifest.adapters),$ack.snapshot) | ForEach-Object { [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes([string]$_))).ToLowerInvariant() }
    $script:ackFailure = @{ trackingNames = $trackingNames; mainInAncestors = $Manifest.mainPid -in $ancestors; supervisorInAncestors = $supervisor.id -in $ancestors; expectedAdapterCount = @($Manifest.adapters).Count; actualAdapterCount = @($snapshotAdapters).Count; expectedKeyHash = $keyHashes[0]; actualKeyHash = $keyHashes[1] }; throw }
  Save-SpikeJson $ack "$($Manifest.root)\ack.json"
  $arm = Wait-SpikeFile "$($Manifest.root)\arm.json" 60
  Assert-SpikeArm $arm $Manifest
  Save-SpikeJson @{ deadline = $arm.deadline; tick = (Get-SpikeTick) } "$($Manifest.root)\armed.json"
  $recovery = Invoke-SpikeRecovery $Manifest $arm "$($Manifest.root)\recovery.json"
  if (!$recovery.pass) { throw 'Watchdog recovery failed; the spike is NO-GO' }
}
function Invoke-SpikeMonitor($Manifest) {
  Assert-SpikeHost (Get-SpikePlatform)
  Save-SpikeJson @{ pid = $PID } "$($Manifest.root)\monitor-ready.json"
  $arm = Wait-SpikeFile "$($Manifest.root)\arm.json" 60
  $timeline = @{ samples = @(); error = $null; complete = $false }
  while ((Get-SpikeTick) -lt ($arm.deadline - [Diagnostics.Stopwatch]::Frequency / 4)) {
    try {
      $snapshot = Get-SpikeInventory
      if (Test-Path "$($Manifest.root)\release.json") { Assert-SpikeSnapshot $Manifest $snapshot $true; $snapshot.isolated = $true }
      $timeline.samples += $snapshot
    } catch { $timeline.error = $_.Exception.Message }
    Save-SpikeJson $timeline "$($Manifest.root)\timeline.json"
    Start-Sleep -Milliseconds 250
  }
  $timeline.complete = $true
  Save-SpikeJson $timeline "$($Manifest.root)\timeline.json"
}
function Assert-SpikeDisableWindow($Manifest, $Arm) {
  if ((Test-Path "$($Manifest.root)\recovery-fence.json") -or (Get-SpikeTick) -ge $Arm.deadline) { throw 'Recovery fenced further adapter disable operations' }
}
function Invoke-SpikeSupervisor($Manifest) {
  Assert-SpikeHost (Get-SpikePlatform)
  $ack = Wait-SpikeFile "$($Manifest.root)\ack.json"
  Assert-SpikeAck $ack $Manifest
  if (!(Get-Process -Id $ack.pid -ErrorAction SilentlyContinue)) { throw 'Watchdog exited before arm' }
  $child = Read-SpikeJson "$($Manifest.root)\child.json"
  $tick = Get-SpikeTick
  $arm = @{ tick = $tick; deadline = $tick + 15 * [Diagnostics.Stopwatch]::Frequency; child = $child; supervisor = (Read-SpikeJson "$($Manifest.root)\supervisor.json") }
  Save-SpikeJson $arm "$($Manifest.root)\arm.json"
  $armed = Wait-SpikeFile "$($Manifest.root)\armed.json" 5
  if ($armed.deadline -ne $arm.deadline) { throw 'Watchdog did not arm exact deadline' }
  foreach ($adapter in $Manifest.adapters | Where-Object admin -eq 'Up') { Assert-SpikeDisableWindow $Manifest $arm; Set-SpikeAdapter $adapter $false }
  $disabled = Get-SpikeInventory; Assert-SpikeSnapshot $Manifest $disabled $true $false
  Save-SpikeJson @{ armTick = $arm.tick; deadline = $arm.deadline; supervisor = $arm.supervisor; scriptHash = $Manifest.scriptHash; completedTick = (Get-SpikeTick); inventory = $disabled } "$($Manifest.root)\disabler-complete.json"
  Assert-SpikeSnapshot $Manifest $disabled $true
  if ((Get-SpikeTick) -ge $arm.deadline) { throw 'Isolation consumed the disconnect deadline' }
  Save-SpikeJson $disabled "$($Manifest.root)\release.json"
  if ($Manifest.scenario -eq 'supervisor-death') { Save-SpikeJson @{ pid = $PID; tick = (Get-SpikeTick); reason = 'deliberate-supervisor-death' } "$($Manifest.root)\death.json"; Stop-Process -Id $PID -Force }
}
function Invoke-SpikeRun {
  Assert-SpikeHost (Get-SpikePlatform)
  $Output = [IO.Path]::GetFullPath($Output)
  if (Test-Path -LiteralPath $Output) { throw 'Evidence output must be new' }
  New-Item -ItemType Directory -Path $Output | Out-Null
  $proof = @{ scenario = $Scenario; pass = $false; limitation = '15-second guest NIC feasibility only; VM loss means no proof; T00 remains open.' }
  $root = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) ("T00-" + [guid]::NewGuid().ToString('N'))
  $account = 't00' + [guid]::NewGuid().ToString('N').Substring(0,12); $task = "T00-$account"
  $created = $false; $registered = $false; $manifest = $null; $child = $null; $owned = [Collections.Generic.List[object]]::new()
  try {
    New-Item -ItemType Directory -Path $root | Out-Null; Set-SpikeAcl $root ''
    Assert-SpikeSealed $root
    $tools = Install-SpikeTools $root (Get-Command pwsh.exe).Source (Get-Command node.exe).Source
    $password = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(36)) + 'aA1!'
    Write-Output "::add-mask::$password"
    $secure = ConvertTo-SecureString $password -AsPlainText -Force; $password = $null
    $user = New-LocalUser -Name $account -Password $secure -AccountNeverExpires -PasswordNeverExpires
    $created = $true; $sid = $user.SID.Value
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $user
    foreach ($group in Get-LocalGroup) {
      if (@(Get-LocalGroupMember -SID $group.SID | Where-Object { $_.SID.Value -eq $sid }).Count -and $group.SID.Value -ne 'S-1-5-32-545') { throw 'Standard account has unexpected local group membership' }
    }
    Set-SpikeAcl $root $sid
    $childRoot = Join-Path $root 'child'; New-Item -ItemType Directory -Path $childRoot | Out-Null; Set-SpikeAcl $childRoot $sid 'Modify'
    $scriptPath = Join-Path $root 'controller.ps1'; Copy-Item -LiteralPath $script:spikeSource -Destination $scriptPath
    $probe = Join-Path $root 'probe.mjs'; Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'ci-network-probe.mjs') -Destination $probe
    'immutable-t00' | Set-Content -LiteralPath "$root\canary"
    $inventory = Get-SpikeInventory
    $proof.beforeInventory = $inventory
    $manifest = @{ schema = 1; seconds = 15; mainPid = $PID; controllerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; adapters = $inventory.adapters; scenario = $Scenario; root = $root; childRoot = $childRoot; sid = $sid
      script = $scriptPath; scriptHash = (Get-FileHash $scriptPath).Hash.ToLowerInvariant(); probe = $probe; probeHash = (Get-FileHash $probe).Hash.ToLowerInvariant()
      pwsh = $tools.pwsh; node = $tools.node; address = (@(Resolve-DnsName github.com -Type A | Where-Object IPAddress | Select-Object -ExpandProperty IPAddress))[0] }
    Assert-SpikeManifest $manifest; Save-SpikeJson $manifest "$root\manifest.json"
    foreach ($path in @($root,$scriptPath,"$root\manifest.json",$manifest.pwsh,$manifest.node)) { Assert-SpikeSealed $path }
    $proof.sources = @{ controller = $manifest.scriptHash; probe = $manifest.probeHash; commit = (& git rev-parse HEAD) }
    $proof.tools = @{ runtimeHash = $tools.runtimeHash; runtimeFiles = $tools.runtimeFiles; pwshPath = $manifest.pwsh; nodePath = $manifest.node; pwsh = (Get-FileHash $manifest.pwsh).Hash; node = (Get-FileHash $manifest.node).Hash; powershellVersion = $PSVersionTable.PSVersion.ToString(); nodeVersion = (& $manifest.node --version); image = $env:ImageVersion; frequency = [Diagnostics.Stopwatch]::Frequency }
    $credential = [pscredential]::new("$env:COMPUTERNAME\$account", $secure)
    $baseline = Start-SpikeMode $manifest 'Child' $credential 'before'
    $owned.Add($baseline)
    if (!$baseline.WaitForExit(20000) -or $baseline.ExitCode -ne 0) { throw 'Standard credential/profile/desktop baseline failed' }
    $proof.before = Read-SpikeJson "$childRoot\before.json"
    $child = Start-SpikeMode $manifest 'Child' $credential 'during'
    $owned.Add($child)
    $ready = Wait-SpikeFile "$childRoot\ready.json"
    if ($ready.sid -cne $sid -or $ready.pid -ne $child.Id) { throw 'Child readiness identity mismatch' }
    Save-SpikeJson @{ id = $child.Id; start = $child.StartTime.ToUniversalTime().Ticks } "$root\child.json"
    $monitor = Start-SpikeMode $manifest 'Monitor' $null; $owned.Add($monitor)
    $null = Wait-SpikeFile "$root\monitor-ready.json"
    $supervisor = Start-SpikeMode $manifest 'Supervisor' $null
    $owned.Add($supervisor)
    Save-SpikeJson @{ id = $supervisor.Id; start = $supervisor.StartTime.ToUniversalTime().Ticks } "$root\supervisor.json"
    $action = New-ScheduledTaskAction -Execute $manifest.pwsh -Argument "-NoProfile -File `"$scriptPath`" -Mode Watchdog -State `"$root\manifest.json`"" -WorkingDirectory $root
    $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    if ($settings.RunOnlyIfNetworkAvailable -or $settings.RunOnlyIfIdle) { throw 'Watchdog has a network/idle scheduling condition' }
    Register-ScheduledTask -TaskName $task -Action $action -Settings $settings -User 'SYSTEM' -RunLevel Highest | Out-Null; $registered = $true
    Start-ScheduledTask -TaskName $task
    $recovery = Wait-SpikeFile "$root\recovery.json" 90
    if (!$supervisor.WaitForExit(5000)) { throw 'Supervisor did not exit' }
    if ($Scenario -eq 'normal' -and $supervisor.ExitCode -ne 0) { throw 'Normal supervisor failed' }
    if ($Scenario -eq 'supervisor-death') {
      $proof.death = Read-SpikeJson "$root\death.json"
      if ($supervisor.ExitCode -eq 0 -or $proof.death.pid -ne $supervisor.Id -or $proof.death.reason -cne 'deliberate-supervisor-death') { throw 'Supervisor death injection was not established' }
    }
    $proof.recovery = $recovery; $proof.watchdog = Read-SpikeJson "$root\ack.json"; $proof.arm = Read-SpikeJson "$root\arm.json"
    if (!$monitor.WaitForExit(5000) -or $monitor.ExitCode -ne 0) { throw 'Independent inventory monitor failed or blocked' }
    $proof.timeline = Read-SpikeJson "$root\timeline.json"; $proof.disabled = Read-SpikeJson "$root\release.json"
    $endSamples = @($proof.timeline.samples | Where-Object { $_.isolated -and $_.tick -le $proof.arm.deadline } | Sort-Object tick)
    if (!$proof.timeline.complete -or !$endSamples.Count -or $endSamples[-1].tick -lt ($proof.arm.deadline - [Diagnostics.Stopwatch]::Frequency)) { throw 'Missing timely final disabled inventory sample' }
    $proof.endInventory = $endSamples[-1]
    if (!$child.WaitForExit(1000) -or $child.ExitCode -ne 0) { throw 'Disconnected child failed or was killed at deadline' }
    $proof.during = Read-SpikeJson "$childRoot\during.json"
    if ($proof.during.start -lt $proof.disabled.tick -or $proof.during.end -ge $recovery.restoreStart -or $proof.during.end -gt $proof.arm.deadline) { throw 'Probe fell outside the disconnected interval' }
    Assert-SpikeProbe $proof.before.probe $true; Assert-SpikeProbe $proof.during.probe $false
    if (!$recovery.pass -or !$recovery.childStopped -or $proof.timeline.error) { throw 'Watchdog recovery proof failed' }
    $after = Start-SpikeMode $manifest 'Child' $credential 'after'
    $owned.Add($after)
    if (!$after.WaitForExit(20000) -or $after.ExitCode -ne 0) { throw 'Same-account post-restoration probe failed' }
    $proof.after = Read-SpikeJson "$childRoot\after.json"; Assert-SpikeProbe $proof.after.probe $true
    $proof.sourceStable = ((Get-FileHash $scriptPath).Hash.ToLowerInvariant() -ceq $manifest.scriptHash -and (Get-FileHash $probe).Hash.ToLowerInvariant() -ceq $manifest.probeHash -and (Get-FileHash $script:spikeSource).Hash.ToLowerInvariant() -ceq $manifest.scriptHash)
    if (!$proof.sourceStable -or (Get-FileHash $manifest.node).Hash -cne $proof.tools.node -or (Get-FileHash $manifest.pwsh).Hash -cne $proof.tools.pwsh) { throw 'Controller, probe or tool bytes drifted' }
    $proof.pass = $true
  } catch { $proof.error = $_.Exception.Message; throw }
  finally {
    if ($manifest -and (Test-Path "$root\arm.json") -and !(Test-Path "$root\recovery.json")) {
      try { $null = Wait-SpikeFile "$root\recovery.json" 45 } catch { $proof.recoveryMissing = $true }
    }
    foreach ($process in $owned) {
      if (!$process.HasExited) { try { $null = Stop-SpikeChild @{ id = $process.Id; start = $process.StartTime.ToUniversalTime().Ticks } } catch { $proof.cleanupError = $_.Exception.Message; $proof.pass = $false } }
    }
    try {
      if ($registered -and (!(Test-Path "$root\arm.json") -or (Test-Path "$root\recovery.json"))) { Unregister-ScheduledTask -TaskName $task -Confirm:$false }
      if ($created) { Remove-LocalUser -Name $account }
    } catch { $proof.cleanupError = $_.Exception.Message; $proof.pass = $false }
    try {
      $publicProof = Protect-SpikeEvidence ($proof | ConvertTo-Json -Depth 16) $manifest $root
      Save-SpikeJson ($publicProof | ConvertFrom-Json -AsHashtable) (Join-Path $Output 'proof.json')
      foreach ($name in @('ack.json','arm.json','release.json','disabler-complete.json','recovery-fence.json','recovery.json','timeline.json','death.json','watchdog-error.json')) {
        if (Test-Path "$root\$name") {
          $publicReceipt = Protect-SpikeEvidence (Get-Content -LiteralPath "$root\$name" -Raw) $manifest $root
          Save-SpikeJson ($publicReceipt | ConvertFrom-Json -AsHashtable) (Join-Path $Output $name)
        }
      }
      foreach ($log in Get-ChildItem -LiteralPath $root -File -Filter '*.stderr') {
        Protect-SpikeEvidence (Get-Content -LiteralPath $log.FullName -Raw) $manifest $root | Set-Content -LiteralPath (Join-Path $Output $log.Name)
      }
    } catch {
      if (!$proof.error) { throw }
      Write-Warning "Evidence export failed ($($_.Exception.GetType().Name)); primary failure retained: $($proof.error)"
    }
  }
  if (!$proof.pass) { throw 'Spike proof or cleanup failed' }
}
if ($MyInvocation.InvocationName -eq '.') { return }
if ($Mode -eq 'Run') { Invoke-SpikeRun; return }
if (!$State -or ![IO.Path]::IsPathFullyQualified($State)) { throw 'An absolute manifest path is required' }
$manifest = Read-SpikeJson $State
try {
  switch ($Mode) {
    'Child' { Invoke-SpikeChild $manifest $Stage }
    'Supervisor' { Invoke-SpikeSupervisor $manifest }
    'Watchdog' { Invoke-SpikeWatchdog $manifest }
    'Monitor' { Invoke-SpikeMonitor $manifest }
  }
} catch {
  if ($Mode -eq 'Watchdog' -and (Get-SpikeSid) -ceq 'S-1-5-18') {
    Assert-SpikeSealed $manifest.root $manifest.controllerSid
    $failure = @{ error = $_.Exception.Message; utc = [DateTime]::UtcNow.ToString('o') }; if ($script:ackFailure) { $failure.ackFailure = $script:ackFailure }; Save-SpikeJson $failure "$($manifest.root)\watchdog-error.json"
  }
  throw
}
