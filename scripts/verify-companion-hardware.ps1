#requires -Version 7.5
[CmdletBinding(PositionalBinding=$false)]
param([switch]$ReadOnly, [string]$Setting, [string]$RequestedValue, [switch]$Restore,
  [string]$SourceReceipt, [string]$BaselineReceipt, [string]$CompareReceipt, [string]$ObservedReceipt,
  [string]$Output, [int]$CompanionPid, [string]$Origin = 'http://127.0.0.1:8787')

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:HardwareJournalRoot=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'RazerDeviceControl/hardware-verification'

function Read-Receipt([string]$Path) {
  if (![IO.Path]::IsPathFullyQualified($Path)) { throw 'Receipt paths must be absolute' }
  Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable -Depth 64 -DateKind String
}

function Assert-Source($Pin) {
  if ($Pin.format -ne 1 -or $Pin.kind -cne 'companion-source' -or $Pin.backend -cnotin @('rust','legacy')) { throw 'Invalid source receipt' }
  if ($Pin.files.Count -eq 0) { throw 'Source files are required' }
  if (!$Pin.Contains('buildReceipt') -or (Get-FileHash -LiteralPath $Pin.buildReceipt.path).Hash.ToLowerInvariant() -cne $Pin.buildReceipt.sha256) { throw 'Reviewed build receipt hash mismatch' }
  $build=Read-Receipt $Pin.buildReceipt.path
  if ($build.format -ne 1 -or $build.kind -cne 'companion-build' -or $build.backend -cne $Pin.backend -or !(Test-JsonEqual $build.binary $Pin.binary) -or $build.files.Count -ne $Pin.files.Count) { throw 'Source pin differs from reviewed build' }
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  foreach ($file in $Pin.files) {
    $path=[IO.Path]::GetFullPath($file.path)
    if (!$seen.Add($path)) { throw 'Duplicate source path' }
    $match=@($build.files | Where-Object { [IO.Path]::GetFullPath($_.path) -ieq $path -and $_.sha256 -ceq $file.sha256 })
    if ($match.Count -ne 1) { throw 'Source pin differs from reviewed build' }
  }
  foreach ($file in @($Pin.binary) + @($Pin.files)) {
    if (![IO.Path]::IsPathFullyQualified($file.path) -or $file.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid source fingerprint' }
    if ((Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) { throw "Source hash mismatch: $($file.path)" }
  }
  if ($Pin.device.id -cnotmatch '^[a-f0-9]{24}$' -or $Pin.device.identity.id -cne $Pin.device.id -or $Pin.device.identity.supported -isnot [bool] -or !$Pin.device.identity.supported -or $Pin.device.identity.name -notmatch 'Viper' -or !$Pin.device.Contains('firmware')) { throw 'Pinned Viper identity and firmware are required' }
}

function Test-JsonEqual($Left, $Right) {
  if ($null -eq $Left -or $null -eq $Right) { return $null -eq $Left -and $null -eq $Right }
  if ($Left -is [Collections.IDictionary]) {
    if ($Right -isnot [Collections.IDictionary] -or $Left.Count -ne $Right.Count) { return $false }
    foreach ($key in $Left.Keys) {
      if (@($Right.Keys) -cnotcontains $key -or !(Test-JsonEqual $Left[$key] $Right[$key])) { return $false }
    }
    return $true
  }
  if ($Left -is [array]) {
    if ($Right -isnot [array] -or $Left.Count -ne $Right.Count) { return $false }
    for ($i=0; $i -lt $Left.Count; $i++) { if (!(Test-JsonEqual $Left[$i] $Right[$i])) { return $false } }
    return $true
  }
  if ($Left -is [string] -or $Left -is [bool]) { return $Left.GetType() -eq $Right.GetType() -and $Left -ceq $Right }
  if ($Right -is [string] -or $Right -is [bool] -or $Right -is [array] -or $Right -is [Collections.IDictionary]) { return $false }
  return [double]$Left -eq [double]$Right
}

function Write-Receipt($Stream, $Value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $Value -Depth 64 -Compress))
  $Stream.Write($bytes, 0, $bytes.Length); $Stream.Flush($true)
}

function Get-ListenerBinding($Pin, $Options) {
  $listeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 17321 -State Listen -ErrorAction Stop)
  if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $Options.CompanionPid) { throw 'Pinned process does not own companion listener' }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Options.CompanionPid)" -ErrorAction Stop
  if (!$process -or ![string]::Equals([IO.Path]::GetFullPath($process.ExecutablePath), [IO.Path]::GetFullPath($Pin.binary.path), [StringComparison]::OrdinalIgnoreCase)) { throw 'Companion image differs from source receipt' }
  $image = '(?:' + [regex]::Escape($Pin.binary.path) + '|' + [regex]::Escape($process.ExecutablePath) + ')'
  $originArgument = [regex]::Escape($Options.Origin)
  $entry = ''
  if ($Pin.backend -eq 'legacy') {
    if (!$Pin.Contains('entrypoint') -or @($Pin.files.path) -cnotcontains $Pin.entrypoint) { throw 'Legacy entrypoint must be source-pinned' }
    $entry = '(?:"' + [regex]::Escape($Pin.entrypoint) + '"|' + [regex]::Escape($Pin.entrypoint) + ')\s+'
  }
  $pattern = '^(?:"' + $image + '"|' + $image + ')\s+' + $entry + '--origin\s+(?:"' + $originArgument + '"|' + $originArgument + ')' + $(if($Pin.backend -eq 'rust') {'(?:\s+--allow-writes)?'} else {''}) + '$'
  if ($process.CommandLine -notmatch $pattern) { throw 'Companion launch arguments do not match pinned direct command' }
  return @{pid=$process.ProcessId;started=$process.CreationDate.ToUniversalTime().ToString('o');image=$process.ExecutablePath;commandLine=$process.CommandLine}
}

function Invoke-CompanionRequest($Method, $Path, $Body, $OriginValue, $Token, $TestEndpoint = 'http://127.0.0.1:17321') {
  $handler = [Net.Http.HttpClientHandler]::new(); $handler.UseProxy=$false; $handler.AllowAutoRedirect=$false
  $client = [Net.Http.HttpClient]::new($handler); $client.Timeout=[TimeSpan]::FromSeconds(80)
  $request = [Net.Http.HttpRequestMessage]::new([Net.Http.HttpMethod]::new($Method), "$TestEndpoint$Path")
  try {
    [void]$request.Headers.TryAddWithoutValidation('Origin',$OriginValue)
    if ($Token) { $request.Headers.Authorization=[Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$Token) }
    if ($null -ne $Body) { $request.Content=[Net.Http.StringContent]::new((ConvertTo-Json -InputObject $Body -Depth 64 -Compress),[Text.Encoding]::UTF8,'application/json') }
    $response=$client.SendAsync($request).GetAwaiter().GetResult()
    try {
      $text=$response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
      if (!$response.IsSuccessStatusCode) { throw "Companion HTTP $([int]$response.StatusCode): $text" }
      if ($text.Length -gt 1048576) { throw 'Companion response too large' }
      $backendMarker=''; $writeMarker=''
      if ($response.Headers.Contains('X-Razer-Companion-Backend')) { $backendMarker=($response.Headers.GetValues('X-Razer-Companion-Backend') -join ',') }
      if ($response.Headers.Contains('X-Razer-Companion-Writes')) { $writeMarker=($response.Headers.GetValues('X-Razer-Companion-Writes') -join ',') }
      return @{body=($text | ConvertFrom-Json -AsHashtable -Depth 64 -DateKind String);backend=$backendMarker;writes=$writeMarker}
    } finally { $response.Dispose() }
  } finally { $request.Dispose(); $client.Dispose() }
}

function Assert-Snapshot($State, $Pin) {
  if ($State.connected -isnot [bool] -or !$State.connected -or $State.selectedDeviceId -cne $Pin.device.id) { throw 'Selected device is disconnected or changed' }
  $devices=@($State.devices | Where-Object { $_.id -ceq $Pin.device.id })
  if ($devices.Count -ne 1 -or !(Test-JsonEqual $devices[0] $Pin.device.identity)) { throw 'Physical device identity changed' }
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($schema in $State.settings) { if (!$schema.id -or !$seen.Add($schema.id)) { throw 'Missing or duplicate setting identity' } }
  $firmware=@($State.settings | Where-Object { $_.id -ceq 'firmware' })
  if ($firmware.Count -ne 1 -or !(Test-JsonEqual $firmware[0].value $Pin.device.firmware)) { throw 'Firmware changed' }
}

function Get-Dpi($State) { return @($State.settings | Where-Object { $_.id -ceq 'dpi' })[0] }

function Assert-Dpi($Value, $Schema) {
  if ($Value -isnot [Collections.IDictionary] -or $Value.Count -ne 2 -or @($Value.Keys) -cnotcontains 'x' -or @($Value.Keys) -cnotcontains 'y') { throw 'DPI requires numeric x and y' }
  foreach ($axis in @('x','y')) {
    $n=$Value[$axis]; $bounds=$Schema.properties[$axis]
    if ($n -is [string] -or $n -is [bool] -or $null -eq $n -or $n -is [Collections.IDictionary] -or $n -is [array]) { throw 'DPI requires numeric x and y' }
    if (![double]::IsFinite($n) -or $n -ne [Math]::Truncate($n) -or $n -lt $bounds.min -or $n -gt $bounds.max) { throw 'DPI outside supported range' }
  }
}

function Test-Baseline($Current, $Expected) {
  $copy=ConvertTo-Json -InputObject $Current -Depth 64 | ConvertFrom-Json -AsHashtable -Depth 64 -DateKind String
  foreach ($schema in $copy.settings) {
    $old=@($Expected.settings | Where-Object { $_.id -ceq $schema.id })
    if ($old.Count -ne 1) { return $false }
    $schema.writable=$old[0].writable
  }
  return Test-JsonEqual $copy $Expected
}

function Get-PendingObservation([string]$Journal) {
  if (!(Test-Path -LiteralPath $Journal)) { return $null }
  $pending=Read-Receipt $Journal
  if (!$pending.attemptId -or !$pending.preparedUtc -or (Get-FileHash -LiteralPath $pending.intent).Hash.ToLowerInvariant() -cne $pending.intentSha256) { throw 'Pending attempt metadata is incomplete or changed' }
  $resultHash=$null
  if (Test-Path -LiteralPath "$Journal.applied.json") {
    $resultHash=(Get-FileHash -LiteralPath $pending.result).Hash.ToLowerInvariant()
    if ((Read-Receipt "$Journal.applied.json").sha256 -cne $resultHash) { throw 'Pending result fingerprint changed' }
  } elseif ((Test-Path -LiteralPath $pending.result) -and (Get-Item -LiteralPath $pending.result).Length -ne 0) { throw 'Pending result is incomplete; inspect before reconciliation' }
  return @{attemptId=$pending.attemptId;intent=$pending.intent;intentSha256=$pending.intentSha256;preparedUtc=$pending.preparedUtc;result=$pending.result;resultSha256=$resultHash}
}

function Invoke-HardwareVerification([hashtable]$Options, [scriptblock]$Transport, [scriptblock]$Bind) {
  if (!$Options['ReadOnly'] -and !$Options['Setting']) { throw 'Usage: verify-companion-hardware.ps1 -ReadOnly or -Setting dpi -RequestedValue <json> -BaselineReceipt <path>; provide -SourceReceipt, -Output and -CompanionPid.' }
  if ($Options['ReadOnly'] -and ($Options['Setting'] -or $Options['Restore'] -or $Options['RequestedValue'] -or $Options['BaselineReceipt'] -or $Options['ObservedReceipt'])) { throw 'Choose one explicit operation' }
  if (!$Options.Contains('Origin')) { $Options.Origin='http://127.0.0.1:8787' }
  $url = $null
  if (![Uri]::TryCreate($Options.Origin, [UriKind]::Absolute, [ref]$url) -or $url.Scheme -notin @('http','https') -or $url.GetLeftPart([UriPartial]::Authority) -cne $Options.Origin) { throw 'Provide an exact HTTP origin' }
  $pin = Read-Receipt $Options.SourceReceipt
  $sourceFingerprint=(Get-FileHash -LiteralPath $Options.SourceReceipt).Hash.ToLowerInvariant()
  Assert-Source $pin
  if ($Options.CompanionPid -le 0 -or ![IO.Path]::IsPathFullyQualified($Options.Output)) { throw 'Provide output absolute path and companion PID' }
  $journal=Join-Path $script:HardwareJournalRoot "$($pin.device.id).pending.json"
  $baseline=$null; $requested=$null; $fresh=$null; $reconcile=$false; $crashIntent=$false
  if ($Options['Setting']) {
    if ($Options.Setting -cne 'dpi' -or $Options['CompareReceipt'] -or $pin.backend -cne 'rust') { throw 'Only explicit Rust DPI operations are supported' }
    $baseline=Read-Receipt $Options.BaselineReceipt
    $crashIntent=$Options['Restore'] -and $baseline.kind -ceq 'companion-hardware-intent'
    if ($crashIntent) {
      if ($baseline.operation -cne 'apply' -or $baseline.request.id -cne 'dpi') { throw 'Crash restoration requires the original apply intent' }
      $baseline=@{format=$baseline.format;kind='companion-hardware';backend=$baseline.backend;outcome='unknown';sourceReceiptSha256=$baseline.sourceReceiptSha256;baseline=$baseline.baseline;intent=$baseline}
    }
    $reconcile=$Options['Restore'] -and $baseline.outcome -ceq 'unknown'
    $requiredOutcome=if($reconcile) {'unknown'} elseif($Options['Restore']) {'applied'} else {'read-only'}
    if ($baseline.format -ne 1 -or $baseline.kind -cne 'companion-hardware' -or $baseline.backend -cne 'rust' -or $baseline.outcome -cne $requiredOutcome -or $baseline.sourceReceiptSha256 -cne (Get-FileHash $Options.SourceReceipt).Hash.ToLowerInvariant()) { throw "Baseline must be a matching Rust $requiredOutcome receipt" }
    Assert-Snapshot $baseline.baseline $pin
    $dpi=Get-Dpi $baseline.baseline
    if ($Options['Restore']) {
      if ($Options['RequestedValue']) { throw 'Restore uses the recorded baseline; omit RequestedValue' }
      if ($reconcile) {
        $fresh=Read-Receipt $Options.ObservedReceipt
        if ($fresh.outcome -cne 'read-only' -or $fresh.backend -cne 'rust' -or $fresh.sourceReceiptSha256 -cne $sourceFingerprint -or !(Test-JsonEqual $baseline.intent.baseline $baseline.baseline)) { throw 'Unknown restore requires a matching fresh read-only receipt and original intent' }
        Assert-Snapshot $fresh.baseline $pin
      } else {
        if ($Options['ObservedReceipt']) { throw 'ObservedReceipt is only for explicit unknown restoration' }
        Assert-Snapshot $baseline.observed $pin
      }
      $requested=$dpi.value
    } else {
      if ($Options['ObservedReceipt']) { throw 'ObservedReceipt requires explicit unknown restoration' }
      $requested=$Options.RequestedValue | ConvertFrom-Json -AsHashtable -Depth 6 -DateKind String
      Assert-Dpi $requested $dpi
      $dx=$requested.x-$dpi.value.x; $dy=$requested.y-$dpi.value.y
      if ([Math]::Abs($dx) -ne 100 -or $dx -ne $dy) { throw 'DPI must change both axes by exactly 100' }
    }
    if (Test-Path -LiteralPath "$($Options.Output).intent.json") { throw 'Intent receipt already exists' }
  }
  [void][IO.Directory]::CreateDirectory($script:HardwareJournalRoot)
  try { $lease=[IO.File]::Open((Join-Path $script:HardwareJournalRoot "$($pin.device.id).lease"),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) }
  catch { throw 'Device verification is held by another verifier; wait for it to exit before taking an observation' }
  try {
  if ($Options['Setting']) {
    if (Test-Path -LiteralPath "$journal.restore.json") { throw 'Unresolved hardware attempt; inspect evidence before any further setter' }
    if (Test-Path -LiteralPath $journal) {
      $pending=Read-Receipt $journal
      $originalPath=if($crashIntent) {$pending.intent} else {$pending.result}
      if (!$Options['Restore'] -or $originalPath -cne $Options.BaselineReceipt -or $pending.sourceReceiptSha256 -cne $sourceFingerprint) { throw 'Unresolved hardware attempt; inspect evidence before any further setter' }
      if ($crashIntent) {
        if ((Test-Path -LiteralPath "$journal.applied.json") -or (Test-Path -LiteralPath $pending.result) -and (Get-Item -LiteralPath $pending.result).Length -ne 0 -or $pending.intentSha256 -cne (Get-FileHash -LiteralPath $Options.BaselineReceipt).Hash.ToLowerInvariant()) { throw 'Crash intent fingerprint changed or a finalized result exists' }
      } elseif (!(Test-Path -LiteralPath "$journal.applied.json") -or (Read-Receipt "$journal.applied.json").sha256 -cne (Get-FileHash -LiteralPath $Options.BaselineReceipt).Hash.ToLowerInvariant()) { throw 'Apply receipt fingerprint changed or incomplete' }
      if ($reconcile) {
        $attempt=Get-PendingObservation $journal
        if (!$fresh.Contains('pendingAttempt') -or !(Test-JsonEqual $fresh.pendingAttempt $attempt) -or [DateTimeOffset]::Parse($fresh.utc) -lt [DateTimeOffset]::Parse($attempt.preparedUtc)) { throw 'Observation does not match pending attempt; capture a separate read-only receipt after the verifier exits' }
      }
    } elseif ($Options['Restore']) { throw 'Restore has no matching hardware attempt' }
  }
  $comparison=$null; $comparisonProof=$null
  if ($Options['CompareReceipt']) {
    $comparison=Read-Receipt $Options.CompareReceipt
    if ($pin.backend -ne 'rust' -or $comparison.backend -ne 'legacy' -or $comparison.outcome -ne 'read-only') { throw 'CompareReceipt must be a legacy read-only receipt' }
    Assert-Snapshot $comparison.baseline $pin
    $legacyPin=Read-Receipt $comparison.sourceReceipt
    Assert-Source $legacyPin
    if ($legacyPin.backend -cne 'legacy' -or $comparison.sourceReceiptSha256 -cne (Get-FileHash -LiteralPath $comparison.sourceReceipt).Hash.ToLowerInvariant()) { throw 'Legacy comparison source fingerprint changed' }
    $comparisonProof=@{path=$Options.CompareReceipt;sha256=(Get-FileHash -LiteralPath $Options.CompareReceipt).Hash.ToLowerInvariant();sourceReceipt=$comparison.sourceReceipt;sourceReceiptSha256=$comparison.sourceReceiptSha256}
  }
  if (!$Bind) { $Bind={param($p,$o) Get-ListenerBinding $p $o} }
  $binding=& $Bind $pin $Options
  $stream=[IO.File]::Open($Options.Output,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
  $token=''
  $dispatched=$false; $intent=$null
  $request={ param($method,$path,$body)
    if ((Get-FileHash -LiteralPath $Options.SourceReceipt).Hash.ToLowerInvariant() -cne $sourceFingerprint) { throw 'Source receipt fingerprint changed' }
    Assert-Source $pin
    if (!(Test-JsonEqual $binding (& $Bind $pin $Options))) { throw 'Companion process generation changed' }
    if ($Transport) { return & $Transport $method $path $body }
    Invoke-CompanionRequest $method $path $body $Options.Origin $token
  }
  try {
    $pair=& $request GET '/api/pair' $null
    if ($pair.backend -cne $pin.backend -or $pair.body.token -cnotmatch '^[a-f0-9]{64}$') { throw 'Companion backend or pairing token mismatch' }
    $writeMode=if($Options['Setting']) {'1'} else {'0'}
    if ($pin.backend -eq 'rust' -and $pair.writes -cne $writeMode) { throw "Rust writes marker must be $writeMode" }
    $token=$pair.body.token
    $state=(& $request GET "/api/state?deviceId=$($pin.device.id)" $null).body
    Assert-Snapshot $state $pin
    if ($Options['Setting']) {
      $expectedCurrent=if($reconcile) {$fresh.baseline} elseif($Options['Restore']) {$baseline.observed} else {$baseline.baseline}
      if (!(Test-Baseline $state $expectedCurrent)) { throw 'Current baseline changed; take a fresh read-only receipt' }
      $dpi=Get-Dpi $state
      if ($dpi.writable -isnot [bool] -or !$dpi.writable) { throw 'DPI is not writable' }
      Assert-Dpi $requested $dpi
      $change=@{deviceId=$pin.device.id;id='dpi';value=$requested;expectedValue=$dpi.value}
      $operation=if($Options['Restore']) {'restore'} else {'apply'}
      $intent=@{format=1;kind='companion-hardware-intent';backend=$pin.backend;operation=$operation;device=$pin.device;baseline=$state;request=$change;sourceReceiptSha256=(Get-FileHash $Options.SourceReceipt).Hash.ToLowerInvariant();utc=[DateTime]::UtcNow.ToString('o')}
      $intentStream=[IO.File]::Open("$($Options.Output).intent.json",[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try { Write-Receipt $intentStream $intent } finally { $intentStream.Dispose() }
      $pendingPath=if($Options['Restore']) {"$journal.restore.json"} else {$journal}
      [void][IO.Directory]::CreateDirectory($script:HardwareJournalRoot)
      $pendingStream=[IO.File]::Open($pendingPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
      try { Write-Receipt $pendingStream @{result=$Options.Output;intent="$($Options.Output).intent.json";intentSha256=(Get-FileHash -LiteralPath "$($Options.Output).intent.json").Hash.ToLowerInvariant();attemptId=[Guid]::NewGuid().ToString();preparedUtc=[DateTime]::UtcNow.ToString('o');sourceReceiptSha256=$sourceFingerprint;status='dispatch-prepared'} } finally { $pendingStream.Dispose() }
      $dispatched=$true
      $applied=(& $request POST '/api/settings' $change).body
      if ($applied.verified -isnot [bool] -or !$applied.verified -or $applied.verification -cne 'hardware-readback') { throw 'Setter verification is unknown' }
      $observed=(& $request GET "/api/state?deviceId=$($pin.device.id)" $null).body
      Assert-Snapshot $observed $pin
      if (!(Test-JsonEqual (Get-Dpi $observed).value $requested)) { throw 'Independent getter mismatch' }
      $expected=ConvertTo-Json -InputObject $state -Depth 64 | ConvertFrom-Json -AsHashtable -Depth 64 -DateKind String
      (Get-Dpi $expected).value=$requested
      if (!(Test-JsonEqual $observed $expected)) { throw 'Unexpected DPI side effects' }
      $outcome=if($Options['Restore']) {'restored'} else {'applied'}
      if ($Options['Restore'] -and !(Test-Baseline $observed $baseline.baseline)) { throw 'Restore side effects differ from original baseline' }
      $receipt=@{format=1;kind='companion-hardware';backend=$pin.backend;sourceReceipt=$Options.SourceReceipt;sourceReceiptSha256=$sourceFingerprint;device=$pin.device;baseline=$state;request=$change;observed=$observed;outcome=$outcome;binding=$binding;utc=[DateTime]::UtcNow.ToString('o');physicalParity=$false;previousReceipt=@{path=$Options.BaselineReceipt;sha256=(Get-FileHash $Options.BaselineReceipt).Hash.ToLowerInvariant()};observedReceipt=$(if($reconcile){@{path=$Options.ObservedReceipt;sha256=(Get-FileHash $Options.ObservedReceipt).Hash.ToLowerInvariant()}}else{$null})}
      Write-Receipt $stream $receipt
      if ($Options['Restore']) {
        Remove-Item -LiteralPath "$journal.restore.json"; if(Test-Path -LiteralPath "$journal.applied.json") { Remove-Item -LiteralPath "$journal.applied.json" }; Remove-Item -LiteralPath $journal
      } else {
        $proofStream=[IO.File]::Open("$journal.applied.json",[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $stream.Position=0; Write-Receipt $proofStream @{sha256=(Get-FileHash -InputStream $stream).Hash.ToLowerInvariant()} } finally { $proofStream.Dispose() }
      }
      return $receipt
    }
    $delta=@()
    if ($pin.backend -eq 'rust') {
      foreach ($schema in $state.settings) { if ($schema.writable -isnot [bool] -or $schema.writable) { throw 'Rust read-only schema is writable' } }
      if ($comparison) {
        $normalized=ConvertTo-Json -InputObject $state -Depth 64 | ConvertFrom-Json -AsHashtable -Depth 64 -DateKind String
        foreach ($schema in $normalized.settings) {
          $legacy=@($comparison.baseline.settings | Where-Object { $_.id -ceq $schema.id })
          if ($legacy.Count -ne 1) { throw 'Read-only parity mismatch: setting IDs' }
          $delta+=@{id=$schema.id;legacy=$legacy[0].writable;rust=$schema.writable}
          $schema.writable=$legacy[0].writable
        }
        if (!(Test-JsonEqual $normalized $comparison.baseline)) { throw 'Read-only parity mismatch' }
      }
    }
    $receipt=@{format=1;kind='companion-hardware';backend=$pin.backend;sourceReceipt=$Options.SourceReceipt;sourceReceiptSha256=$sourceFingerprint;device=$pin.device;baseline=$state;outcome='read-only';permissionDelta=$delta;comparison=$comparisonProof;binding=$binding;pendingAttempt=(Get-PendingObservation $journal);utc=[DateTime]::UtcNow.ToString('o');physicalParity=$false}
    Write-Receipt $stream $receipt
    return $receipt
  } catch {
    if ($stream.Position -eq 0) {
      Write-Receipt $stream @{format=1;kind='companion-hardware';backend=$pin.backend;sourceReceipt=$Options.SourceReceipt;sourceReceiptSha256=$sourceFingerprint;device=$pin.device;baseline=$(if($intent){$intent.baseline}else{$null});outcome=$(if($dispatched){'unknown'}else{'rejected'});error=$_.Exception.Message;intent=$intent;automaticRetry=$false;automaticRestore=$false;utc=[DateTime]::UtcNow.ToString('o')}
      if ($dispatched -and !$Options['Restore']) {
        $proofStream=[IO.File]::Open("$journal.applied.json",[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $stream.Position=0; Write-Receipt $proofStream @{sha256=(Get-FileHash -InputStream $stream).Hash.ToLowerInvariant()} } finally { $proofStream.Dispose() }
      }
    }
    throw
  } finally { $stream.Dispose() }
  } finally { $lease.Dispose() }
}

if ($MyInvocation.InvocationName -ne '.') {
  Invoke-HardwareVerification $PSBoundParameters
}
