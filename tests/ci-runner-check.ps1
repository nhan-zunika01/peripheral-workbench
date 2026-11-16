#requires -Version 7.5
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/../scripts/ci.ps1"
$candidate = (Get-Command node.exe).Source
$artifact = @{reason='compiler-artifact'; target=@{name='contract-server'; kind=@('test')}; executable=$candidate} | ConvertTo-Json -Compress
if ((Get-ContractExecutable @($artifact)) -cne $candidate) { throw 'Wrong test executable' }
foreach ($rows in @(@('invalid-json'), @('{}'), @($artifact, $artifact), @(($artifact.Replace($candidate.Replace('\', '\\'), 'Z:/missing-contract.exe'))))) {
  $rejected = $false
  try { Get-ContractExecutable $rows | Out-Null } catch { $rejected = $true }
  if (!$rejected) { throw 'Invalid Cargo artifact was accepted' }
}
$temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory $temp | Out-Null
try {
  $script:Output = $temp
  $script:phases = [Collections.Generic.List[object]]::new()
  $rejected = $false
  try { Invoke-Phase 'failing-fixture' 'node' @('-e', 'process.exit(17)') } catch { $rejected = $true }
  if (!$rejected -or $script:phases[0].exitCode -ne 17) { throw 'Failed command did not fail the gate' }

  Push-Location "$PSScriptRoot/.."
  try {
    $sources = @(Get-Sources)
    $paths = @(git ls-files -c --others --exclude-standard | Sort-Object -Unique)
    if ($LASTEXITCODE -ne 0 -or !$paths.Count -or ($sources.path -join "`n") -cne ($paths -join "`n")) {
      throw 'Source manifest is missing paths or is not in deterministic order'
    }
    foreach ($source in $sources) {
      if ($source.sha256 -cne (Get-FileHash -LiteralPath $source.path -Algorithm SHA256).Hash.ToLowerInvariant()) {
        throw "Source manifest has an incorrect hash for $($source.path)"
      }
    }

    $failures = [Collections.Generic.List[string]]::new()
    $oldGitDir = $env:GIT_DIR
    try {
      $env:GIT_DIR = Join-Path $temp 'missing-git-directory'
      $rejected = $false
      try { Get-Sources 2>$null | Out-Null } catch { $rejected = $true }
      if (!$rejected) { $failures.Add('invalid GIT_DIR was accepted') }
    } finally { $env:GIT_DIR = $oldGitDir }

    $global:ciRunnerGit = (Get-Command git.exe).Source
    $global:ciRunnerGitMode = 'real'
    $global:ciRunnerVersionTool = ''
    $global:ciRunnerVersionMode = ''
    $global:ciRunnerMissingSource = "ci-runner-missing-$([guid]::NewGuid()).txt"
    function git {
      if ($args[0] -eq 'ls-files') {
        switch ($global:ciRunnerGitMode) {
          'fail' { $global:LASTEXITCODE = 17; return }
          'partial' { $global:LASTEXITCODE = 17; 'README.md'; return }
          'empty' { $global:LASTEXITCODE = 0; return }
          'missing' { $global:LASTEXITCODE = 0; 'README.md'; $global:ciRunnerMissingSource; return }
          'fixture' { $global:LASTEXITCODE = 0; 'README.md'; return }
        }
      }
      if ($args[0] -eq 'rev-parse' -and $global:ciRunnerVersionTool -eq 'git') {
        if ($global:ciRunnerVersionMode -eq 'exit') { $global:LASTEXITCODE = 17; 'partial' }
        else { $global:LASTEXITCODE = 0 }
        return
      }
      & $global:ciRunnerGit @args
    }
    foreach ($mode in @('fail', 'partial', 'empty', 'missing')) {
      $global:ciRunnerGitMode = $mode
      $rejected = $false
      try { Get-Sources | Out-Null } catch { $rejected = $true }
      if (!$rejected) { $failures.Add("Git $mode enumeration was accepted") }
    }

    function Write-FakeVersion([string]$tool, [object[]]$arguments) {
      if ($arguments[0] -eq '--version' -and $global:ciRunnerVersionTool -eq $tool) {
        if ($global:ciRunnerVersionMode -eq 'exit') { $global:LASTEXITCODE = 17; 'partial' }
        else { $global:LASTEXITCODE = 0 }
      } else { $global:LASTEXITCODE = 0; 'fixture-version' }
    }
    function node { Write-FakeVersion 'node' $args }
    function npm { Write-FakeVersion 'npm' $args }
    function rustc { Write-FakeVersion 'rustc' $args }
    function cargo { Write-FakeVersion 'cargo' $args }
    $global:ciRunnerGitMode = 'fixture'
    foreach ($tool in @('git', 'node', 'npm', 'rustc', 'cargo')) {
      foreach ($mode in @('exit', 'empty')) {
        $global:ciRunnerVersionTool = $tool
        $global:ciRunnerVersionMode = $mode
        $output = Join-Path $temp "version-$tool-$mode"
        $failure = ''
        try { & "$PSScriptRoot/../scripts/ci.ps1" -Suite hardware -Output $output | Out-Null } catch { $failure = $_.Exception.Message }
        if ($failure -notlike "$tool *" -or !(Test-Path -LiteralPath (Join-Path $output 'source-before.json')) -or (Test-Path -LiteralPath (Join-Path $output 'receipt.json'))) {
          $failures.Add("$tool $mode version metadata was accepted or produced a receipt")
        }
      }
    }
    if ($failures.Count) { throw ($failures -join '; ') }
  } finally { Pop-Location }
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
Write-Output 'PASS Cargo artifact, command, source evidence, and version metadata gates'
& "$PSScriptRoot/ci-network-check.ps1"
