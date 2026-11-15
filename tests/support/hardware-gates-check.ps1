param([string]$Scenario='all', [string]$TestEndpoint='')
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../../scripts/verify-companion-hardware.ps1"
function Assert($Condition, $Message) { if (!$Condition) { throw "Assertion: $Message" } }
function Reject([scriptblock]$Action, [string]$Message) {
  $caught = $null
  try { & $Action } catch { $caught = $_.Exception.Message }
  Assert ($caught -like "*$Message*") "expected '$Message', got '$caught'"
}
function Json($Value) { ConvertTo-Json -InputObject $Value -Depth 60 -Compress }
$temp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temp | Out-Null
$script:HardwareJournalRoot=Join-Path $temp 'journal'
try {
  $binary = Join-Path $temp 'fake.exe'; Set-Content -LiteralPath $binary 'OFFLINE ONLY'
  $source = Join-Path $temp 'fake.rs'; Set-Content -LiteralPath $source 'OFFLINE SOURCE'
  $device = @{id=('b' * 24);name='Razer Viper V3 Pro SE';supported=$true}
  $pin = @{format=1;kind='companion-source';backend='rust';binary=@{path=$binary;sha256=(Get-FileHash $binary).Hash.ToLowerInvariant()};files=@(@{path=$source;sha256=(Get-FileHash $source).Hash.ToLowerInvariant()});device=@{id=$device.id;firmware='1.0';identity=$device}}
  $build=@{format=1;kind='companion-build';backend='rust';binary=$pin.binary.Clone();files=@($pin.files | ForEach-Object {$_.Clone()})}
  $buildPath=Join-Path $temp 'reviewed-build.json'; Json $build | Set-Content $buildPath
  $pin.buildReceipt=@{path=$buildPath;sha256=(Get-FileHash $buildPath).Hash.ToLowerInvariant()}
  $script:listenerImage=$binary.Replace('/','\'); $script:listenerCommand='"'+$binary+'" --origin http://127.0.0.1:8787'
  function Get-NetTCPConnection { return @{OwningProcess=100} }
  function Get-CimInstance { return @{ProcessId=100;ExecutablePath=$script:listenerImage;CommandLine=$script:listenerCommand;CreationDate=[DateTime]::UtcNow} }
  $pathPin=$pin.Clone(); $pathPin.binary=$pin.binary.Clone(); $pathPin.binary.path=$binary.Replace('\','/')
  $listener=Get-ListenerBinding $pathPin @{CompanionPid=100;Origin='http://127.0.0.1:8787'}
  Assert ($listener.pid -eq 100) 'Windows path separators do not break executable binding'
  $pinPath=Join-Path $temp 'source.json'; Json $pin | Set-Content $pinPath
  $options=@{ReadOnly=$true;SourceReceipt=$pinPath;Output=(Join-Path $temp 'out.json');CompanionPid=100;Origin='http://127.0.0.1:8787'}
  $script:calls=0
  $transport={ param($Method,$Path,$Body) $script:calls++; throw 'Unexpected network' }
  $bind={ @{pid=100;started='OFFLINE';image=$binary} }
  Set-Content -LiteralPath $source 'TAMPER'
  Reject { Invoke-HardwareVerification $options $transport $bind } 'Source hash mismatch'
  Assert ($script:calls -eq 0) 'invalid source must cause zero requests'
  Set-Content -LiteralPath $source 'OFFLINE SOURCE'
  $options.Origin='http://127.0.0.1:8787/path'
  Reject { Invoke-HardwareVerification $options $transport $bind } 'exact HTTP origin'
  Assert ($script:calls -eq 0) 'invalid origin must cause zero requests'
  $options.Origin='http://127.0.0.1:8787'
  $originalPin=[IO.File]::ReadAllBytes($pinPath)
  $subset=Read-Receipt $pinPath; $subset.files=@(); Json $subset | Set-Content $pinPath
  Reject { Invoke-HardwareVerification $options $transport $bind } 'Source files are required'
  [IO.File]::WriteAllBytes($pinPath,$originalPin)
  $wrongBuild=Read-Receipt $pinPath; $wrongBuild.buildReceipt.sha256=('0'*64); Json $wrongBuild | Set-Content $pinPath
  Reject { Invoke-HardwareVerification $options $transport $bind } 'Reviewed build receipt hash mismatch'
  Assert ($script:calls -eq 0) 'unreviewed build zero requests'
  [IO.File]::WriteAllBytes($pinPath,$originalPin)
  $options.Origin='http://127.0.0.1:8787'
  $state=@{selectedDeviceId=$device.id;connected=$true;devices=@($device);settings=@(@{id='firmware';type='string';writable=$false;value='1.0'},@{id='dpi';type='object';properties=@{x=@{type='number';min=100;max=35000;integer=$true};y=@{type='number';min=100;max=35000;integer=$true}};writable=$false;value=@{x=800;y=800}});unavailable=@();message='OFFLINE'}
  $state.settings+=@{id='customCurve';type='array';minItems=250;maxItems=250;items=@{type='number';min=0.1;max=3.4028234663852886e38};writable=$false;value=@(1..250 | ForEach-Object { 1.0 })}
  if($Scenario -eq 'date') { $state.devices+=@{id=('c'*24);name='2026-11-13T12:00:00Z';supported=$false} }
  $script:state=$state; $script:backend='rust'; $script:writes='0'
  $transport={ param($Method,$Path,$Body) $script:calls++; if($Path -eq '/api/pair') { return @{body=@{token=('a'*64)};backend=$script:backend;writes=$script:writes} }; return @{body=$script:state} }
  if($Scenario -eq 'date') {
    $transport={param($Method,$Path,$Body)
      $script:calls++
      $result=Invoke-CompanionRequest $Method $Path $Body 'http://127.0.0.1:8787' ('a'*64) $TestEndpoint
      if($Path -ne '/api/pair') { Assert ($result.body.devices[1].name -is [string] -and $result.body.devices[1].name -ceq '2026-11-13T12:00:00Z') 'HTTP preserves date-shaped JSON string' }
      return $result
    }
  }
  Invoke-HardwareVerification $options $transport $bind | Out-Null
  $read=Read-Receipt $options.Output
  Assert ($read.outcome -eq 'read-only') 'read receipt outcome'
  Assert ($read.baseline.settings[1].value.x -eq 800) 'complete baseline retained'
  $legacy=Read-Receipt $options.Output; $legacy.backend='legacy'; $legacy.baseline.settings[1].writable=$true
  $legacyBuild=Read-Receipt $buildPath; $legacyBuild.backend='legacy'; $legacyBuildPath=Join-Path $temp 'legacy-build.json'; Json $legacyBuild | Set-Content $legacyBuildPath
  $legacyPin=Read-Receipt $pinPath; $legacyPin.backend='legacy'; $legacyPin.buildReceipt=@{path=$legacyBuildPath;sha256=(Get-FileHash $legacyBuildPath).Hash.ToLowerInvariant()}
  $legacyPinPath=Join-Path $temp 'legacy-source.json'; Json $legacyPin | Set-Content $legacyPinPath
  $legacy.sourceReceipt=$legacyPinPath; $legacy.sourceReceiptSha256=(Get-FileHash $legacyPinPath).Hash.ToLowerInvariant()
  $legacyPath=Join-Path $temp 'legacy.json'; Json $legacy | Set-Content $legacyPath
  $options.CompareReceipt=$legacyPath; $options.Output=Join-Path $temp 'comparison.json'
  Invoke-HardwareVerification $options $transport $bind | Out-Null
  $comparison=Read-Receipt $options.Output
  Assert ($comparison.permissionDelta.Count -eq 3) 'each setting permission delta retained'
  Assert ($comparison.comparison.path -ceq $legacyPath -and $comparison.comparison.sha256 -ceq (Get-FileHash $legacyPath).Hash.ToLowerInvariant()) 'comparison provenance retained'
  Assert ($comparison.baseline.settings[2].value.Count -eq 250) 'all curve samples retained'
  if($Scenario -eq 'date') {
    Assert (Test-Baseline $script:state $comparison.baseline) 'baseline clone preserves date-shaped JSON strings'
    $transport={ param($Method,$Path,$Body) $script:calls++; if($Path -eq '/api/pair') { return @{body=@{token=('a'*64)};backend=$script:backend;writes=$script:writes} }; return @{body=$script:state} }
  }
  $script:state.settings[2].value[249]=1.25; $options.Output=Join-Path $temp 'curve-mismatch.json'
  Reject { Invoke-HardwareVerification $options $transport $bind } 'Read-only parity mismatch'
  $script:state.settings[2].value[249]=1.0
  $script:state.settings[1].properties.x.max=34900
  $options.Output=Join-Path $temp 'mismatch.json'
  Reject { Invoke-HardwareVerification $options $transport $bind } 'Read-only parity mismatch'
  $script:state.settings[1].properties.x.max=35000
  $script:state.settings[1].writable=$true
  $options.Remove('CompareReceipt'); $options.Output=Join-Path $temp 'writable.json'
  Reject { Invoke-HardwareVerification $options $transport $bind } 'Rust read-only schema is writable'
  $script:state.settings[1].writable=$false
  $options.Output=Join-Path $temp 'string-permission.json'; $script:state.settings[1].writable='False'
  Reject { Invoke-HardwareVerification $options $transport $bind } 'Rust read-only schema is writable'
  $script:state.settings[1].writable=$false
  $pinBytes=[IO.File]::ReadAllBytes($pinPath); $script:goodRead=$transport
  $substitute={param($Method,$Path,$Body) $result=& $script:goodRead $Method $Path $Body; if($Path -eq '/api/pair') { Add-Content -LiteralPath $pinPath ' ' }; return $result}
  $options.Output=Join-Path $temp 'substituted-source.json'; $before=$script:calls
  Reject { Invoke-HardwareVerification $options $substitute $bind } 'Source receipt fingerprint changed'
  Assert ($script:calls -eq $before+1) 'source receipt replacement blocks state read'
  [IO.File]::WriteAllBytes($pinPath,$pinBytes)
  $options.Remove('ReadOnly'); $options.Setting='dpi'; $options.RequestedValue='{"x":900,"y":900}'
  $options.BaselineReceipt=Join-Path $temp 'out.json'; $options.Output=Join-Path $temp 'apply.json'
  $script:state.settings[1].writable=$true; $script:writes='1'; $script:posts=@()
  $transport={ param($Method,$Path,$Body)
    $script:calls++
    if($Path -eq '/api/pair') { return @{body=@{token=('a'*64)};backend='rust';writes=$script:writes} }
    if($Method -eq 'POST') {
      Assert (Test-Path -LiteralPath "$($options.Output).intent.json") 'durable intent before dispatch'
      $pendingPath=Join-Path $script:HardwareJournalRoot "$($device.id).pending.json"
      if($options['Restore']) { $pendingPath+='.restore.json' }
      $prepared=Read-Receipt $pendingPath
      Assert ($prepared.intentSha256 -ceq (Get-FileHash "$($options.Output).intent.json").Hash.ToLowerInvariant() -and $prepared.result -ceq $options.Output -and $prepared.attemptId -and $prepared.preparedUtc) 'journal binds exact intent and attempt before dispatch'
      $script:posts+=,$Body; $script:state.settings[1].value=$Body.value
      return @{body=@{verified=$true;verification='hardware-readback';state=$script:state}}
    }
    return @{body=((Json $script:state) | ConvertFrom-Json -AsHashtable -Depth 64 -DateKind String)}
  }
  Invoke-HardwareVerification $options $transport $bind | Out-Null
  $applied=Read-Receipt $options.Output
  Assert ($applied.outcome -eq 'applied') 'apply receipt success'
  Assert ($applied.baseline.settings[1].value.x -eq 800) 'pre-dispatch baseline retained'
  Assert ($script:posts.Count -eq 1) 'one setter dispatch'
  Assert ($script:posts[0].expectedValue.x -eq 800) 'POST baseline expectedValue'
  Assert ($applied.observed.settings[1].value.x -eq 900) 'independent getter recorded'
  Assert ($script:state.settings[1].value.x -eq 900) 'apply does not auto restore'
  $options.RequestedValue='{"x":1100,"y":1100}'; $options.Output=Join-Path $temp 'large-step.json'
  $before=$script:calls
  Reject { Invoke-HardwareVerification $options $transport $bind } 'DPI must change both axes by exactly 100'
  Assert ($before -eq $script:calls) 'invalid step zero requests'
  $applyPath=Join-Path $temp 'apply.json'; $applyBytes=[IO.File]::ReadAllBytes($applyPath)
  $tampered=Read-Receipt $applyPath; $tampered.baseline.settings[1].value=@{x=1000;y=1000}; Json $tampered | Set-Content $applyPath
  $options.Remove('RequestedValue'); $options.Restore=$true; $options.BaselineReceipt=$applyPath; $options.Output=Join-Path $temp 'tampered-restore.json'; $before=$script:calls
  Reject { Invoke-HardwareVerification $options $transport $bind } 'Apply receipt fingerprint changed'
  Assert ($before -eq $script:calls) 'tampered apply receipt zero requests'
  [IO.File]::WriteAllBytes($applyPath,$applyBytes)
  $options.Remove('RequestedValue'); $options.Restore=$true; $options.BaselineReceipt=Join-Path $temp 'apply.json'; $options.Output=Join-Path $temp 'restore.json'
  Invoke-HardwareVerification $options $transport $bind | Out-Null
  $restored=Read-Receipt $options.Output
  Assert ($restored.outcome -eq 'restored') 'explicit restore success'
  Assert ($script:posts.Count -eq 2) 'restore dispatch once'
  Assert ($script:posts[1].expectedValue.x -eq 900 -and $script:posts[1].value.x -eq 800) 'restore pins fresh current and original baseline'
  Assert ($script:state.settings[1].value.x -eq 800) 'baseline restored'
  $options.Remove('Restore'); $options.RequestedValue='{"x":900,"y":900}'; $options.BaselineReceipt=Join-Path $temp 'out.json'; $options.Output=Join-Path $temp 'unknown.json'
  $script:goodTransport=$transport
  $failing={param($Method,$Path,$Body) if($Method -eq 'POST') {$script:posts+=,$Body; throw 'Simulated timeout after dispatch'}; & $script:goodTransport $Method $Path $Body}
  if ($Scenario -eq 'lease') {
    $script:interleavedRead=@{ReadOnly=$true;SourceReceipt=$pinPath;Output=(Join-Path $temp 'interleaved-read.json');CompanionPid=100;Origin='http://127.0.0.1:8787'}
    $failing={param($Method,$Path,$Body)
      if($Method -eq 'POST') {
        $beforeRead=$script:calls
        Reject { Invoke-HardwareVerification $script:interleavedRead $script:goodTransport $bind } 'another verifier'
        Assert ($beforeRead -eq $script:calls) 'exclusive verifier lease blocks interleaved observation before GET'
        $script:posts+=,$Body; throw 'Simulated timeout after dispatch'
      }
      & $script:goodTransport $Method $Path $Body
    }
  }
  Reject { Invoke-HardwareVerification $options $failing $bind } 'Simulated timeout after dispatch'
  $unknown=Read-Receipt $options.Output
  Assert ($unknown.outcome -eq 'unknown') 'ambiguous dispatch is durable unknown'
  Assert ($script:posts.Count -eq 3) 'no retry or automatic restore'
  $unknownHash=(Get-FileHash $options.Output).Hash
  $options.Output=Join-Path $temp 'retry.json'; $before=$script:calls
  Reject { Invoke-HardwareVerification $options $transport $bind } 'Unresolved hardware attempt'
  Assert ($before -eq $script:calls -and $script:posts.Count -eq 3) 'unknown blocks next invocation before requests'
  Assert ((Get-FileHash (Join-Path $temp 'unknown.json')).Hash -eq $unknownHash) 'unknown never overwritten'
  $alias=Join-Path $temp 'source-alias.json'; Copy-Item -LiteralPath $pinPath -Destination $alias
  $options.SourceReceipt=$alias; $options.Output=Join-Path $temp 'alias-retry.json'
  Reject { Invoke-HardwareVerification $options $transport $bind } 'Unresolved hardware attempt'
  Assert ($before -eq $script:calls) 'source receipt alias cannot bypass pending attempt'
  $copiedBinary=Join-Path $temp 'renamed.exe'; Copy-Item -LiteralPath $binary -Destination $copiedBinary
  $copyPin=Read-Receipt $pinPath; $copyPin.binary.path=$copiedBinary
  $copyBuild=Read-Receipt $buildPath; $copyBuild.binary.path=$copiedBinary
  $copyBuildPath=Join-Path $temp 'copy-build.json'; Json $copyBuild | Set-Content $copyBuildPath
  $copyPin.buildReceipt=@{path=$copyBuildPath;sha256=(Get-FileHash $copyBuildPath).Hash.ToLowerInvariant()}
  $copyPinPath=Join-Path $temp 'binary-copy-source.json'; Json $copyPin | Set-Content $copyPinPath
  $options.SourceReceipt=$copyPinPath; $options.Output=Join-Path $temp 'binary-copy-retry.json'
  $newBaseline=Read-Receipt $options.BaselineReceipt; $newBaseline.sourceReceiptSha256=(Get-FileHash $copyPinPath).Hash.ToLowerInvariant()
  $newBaselinePath=Join-Path $temp 'copied-baseline.json'; Json $newBaseline | Set-Content $newBaselinePath; $options.BaselineReceipt=$newBaselinePath
  Reject { Invoke-HardwareVerification $options $transport $bind } 'Unresolved hardware attempt'
  Assert ($before -eq $script:calls) 'binary rename cannot bypass pending attempt'
  if ($Scenario -eq 'stale') {
    $staleOptions=@{Setting='dpi';Restore=$true;SourceReceipt=$pinPath;BaselineReceipt=(Join-Path $temp 'unknown.json');ObservedReceipt=(Join-Path $temp 'out.json');Output=(Join-Path $temp 'stale-restore.json');CompanionPid=100;Origin='http://127.0.0.1:8787'}
    $beforeStale=$script:calls
    Reject { Invoke-HardwareVerification $staleOptions $transport $bind } 'Observation does not match pending attempt'
    Assert ($beforeStale -eq $script:calls) 'pre-apply observation rejected before requests'
  }
  $options=@{ReadOnly=$true;SourceReceipt=$pinPath;Output=(Join-Path $temp 'fresh-read.json');CompanionPid=100;Origin='http://127.0.0.1:8787'}
  $script:state.settings[1].writable=$false; $script:writes='0'
  Invoke-HardwareVerification $options $transport $bind | Out-Null
  $script:state.settings[1].writable=$true; $script:writes='1'
  $options.Remove('ReadOnly'); $options.Setting='dpi'; $options.Restore=$true; $options.BaselineReceipt=Join-Path $temp 'unknown.json'; $options.ObservedReceipt=Join-Path $temp 'fresh-read.json'; $options.Output=Join-Path $temp 'reconciled.json'
  Invoke-HardwareVerification $options $transport $bind | Out-Null
  $reconciled=Read-Receipt $options.Output
  Assert ($reconciled.outcome -eq 'restored') 'separately requested unknown restore supported'
  Assert ($script:posts.Count -eq 4 -and $script:posts[3].value.x -eq 800) 'explicit reconciliation sends original baseline once'
  Assert ((Get-FileHash (Join-Path $temp 'unknown.json')).Hash -eq $unknownHash) 'original unknown remains immutable after restoration'
  if ($Scenario -eq 'crash') {
    $crashResult=Join-Path $temp 'crash-empty.json'; [IO.File]::WriteAllBytes($crashResult,[byte[]]@())
    $crashIntent=Join-Path $temp 'crash.intent.json'
    $intent=@{format=1;kind='companion-hardware-intent';backend='rust';operation='apply';device=$pin.device;baseline=((Json $script:state)|ConvertFrom-Json -AsHashtable -Depth 64 -DateKind String);request=@{deviceId=$device.id;id='dpi';value=@{x=900;y=900};expectedValue=@{x=800;y=800}};sourceReceiptSha256=(Get-FileHash $pinPath).Hash.ToLowerInvariant();utc=[DateTime]::UtcNow.ToString('o')}
    Json $intent | Set-Content $crashIntent
    $crashIntentHash=(Get-FileHash $crashIntent).Hash
    $journal=Join-Path $script:HardwareJournalRoot "$($device.id).pending.json"
    Json @{result=$crashResult;intent=$crashIntent;intentSha256=$crashIntentHash.ToLowerInvariant();attemptId=[Guid]::NewGuid().ToString();preparedUtc=[DateTime]::UtcNow.ToString('o');sourceReceiptSha256=(Get-FileHash $pinPath).Hash.ToLowerInvariant();status='dispatch-prepared'} | Set-Content $journal
    $options=@{ReadOnly=$true;SourceReceipt=$pinPath;Output=(Join-Path $temp 'crash-observed.json');CompanionPid=100;Origin='http://127.0.0.1:8787'}
    $script:state.settings[1].writable=$false; $script:writes='0'
    Invoke-HardwareVerification $options $transport $bind | Out-Null
    $script:state.settings[1].writable=$true; $script:writes='1'
    $options.Remove('ReadOnly'); $options.Setting='dpi'; $options.Restore=$true; $options.BaselineReceipt=$crashIntent; $options.ObservedReceipt=Join-Path $temp 'crash-observed.json'; $options.Output=Join-Path $temp 'crash-restored.json'
    Invoke-HardwareVerification $options $transport $bind | Out-Null
    Assert ((Read-Receipt $options.Output).outcome -eq 'restored') 'explicit restore from durable crash intent'
    Assert ((Get-Item $crashResult).Length -eq 0 -and (Get-FileHash $crashIntent).Hash -eq $crashIntentHash) 'crash result and intent preserved'
  }
  Write-Output 'offline hardware gates passed'
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
