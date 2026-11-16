#requires -Version 7.5
[CmdletBinding()]
param([ValidateSet('core', 'browser', 'hardware')][string]$Suite = 'core',
  [string]$Output = "test-results/ci/$Suite")
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false

function Get-ContractExecutable([string[]]$Rows) {
  $artifacts = @($Rows | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object {
    $_.reason -eq 'compiler-artifact' -and $_.target.name -eq 'contract-server' -and $_.target.kind -contains 'test' -and $_.executable
  })
  if ($artifacts.Count -ne 1) { throw 'Expected exactly one contract-server test artifact' }
  $executable = $artifacts[0].executable
  if (![IO.Path]::IsPathFullyQualified($executable) -or !(Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw 'Cargo contract-server executable is missing'
  }
  return $executable
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
  $rows = @(& $Executable @Arguments)
  if ($LASTEXITCODE -ne 0 -or !$rows.Count -or [string]::IsNullOrWhiteSpace(($rows -join ''))) {
    throw "$Executable $($Arguments -join ' ') failed or returned no output"
  }
  $rows
}

function Get-Sources {
  @(Invoke-Checked 'git' @('ls-files', '-c', '--others', '--exclude-standard') | Sort-Object -Unique | ForEach-Object {
    @{path = $_; sha256 = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()}
  })
}

function Invoke-Phase([string]$Name, [string]$Executable, [string[]]$Arguments) {
  $log = Join-Path $Output "$Name.log"
  $start = [DateTime]::UtcNow
  try { & $Executable @Arguments 1> $log 2> "$log.stderr"; $code = $LASTEXITCODE }
  catch { $_ | Out-File $log -Append; $code = 1 }
  $row = @{phase = $Name; command = @($Executable) + $Arguments; exitCode = $code; startedUtc = $start.ToString('o'); seconds = ([DateTime]::UtcNow - $start).TotalSeconds; log = "$Name.log"; sha256 = (Get-FileHash -LiteralPath $log).Hash.ToLowerInvariant()}
  if (Test-Path -LiteralPath "$log.stderr") { $row.stderrSha256 = (Get-FileHash -LiteralPath "$log.stderr").Hash.ToLowerInvariant(); Get-Content -LiteralPath "$log.stderr" | Write-Output }
  $phases.Add($row)
  $row | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Output "$Name-result.json")
  Get-Content -LiteralPath $log | Write-Output
  if ($code -ne 0) { throw "$Name failed with exit code $code" }
}

if ($MyInvocation.InvocationName -eq '.') { return }
Push-Location (Split-Path $PSScriptRoot)
$server = $null
$before = $null
$phases = [Collections.Generic.List[object]]::new()
try {
  $Output = [IO.Path]::GetFullPath($Output)
  if (Test-Path -LiteralPath $Output) { throw 'CI output must be a new directory' }
  New-Item -ItemType Directory -Path $Output | Out-Null
  $env:CI = 'true'
  $env:WRANGLER_SEND_METRICS = 'false'
  $env:PWSH = (Get-Command pwsh.exe).Source
  $env:QA_OUTPUT = Join-Path $Output 'project-qa'
  $env:UI_OUTPUT = Join-Path $Output 'ui'
  $sources = Get-Sources
  $sources | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Output 'source-before.json')
  @{commit = (Invoke-Checked 'git' @('rev-parse', 'HEAD')); node = (Invoke-Checked 'node' @('--version')); npm = (Invoke-Checked 'npm' @('--version')); rust = (Invoke-Checked 'rustc' @('--version')); cargo = (Invoke-Checked 'cargo' @('--version')); powershell = $PSVersionTable.PSVersion.ToString(); os = [Environment]::OSVersion.VersionString} | ConvertTo-Json | Set-Content (Join-Path $Output 'versions.json')
  $before = $sources
  switch ($Suite) {
    'core' {
      Invoke-Phase 'runner-regression' 'pwsh' @('-NoProfile', '-File', 'tests/ci-runner-check.ps1')
      Invoke-Phase 'node-test' 'npm' @('test')
      Invoke-Phase 'cargo-fmt' 'cargo' @('fmt', '--manifest-path', 'bridge/rust/Cargo.toml', '--check')
      Invoke-Phase 'cargo-clippy' 'cargo' @('clippy', '--offline', '--locked', '--manifest-path', 'bridge/rust/Cargo.toml', '--all-targets', '--', '-D', 'warnings')
      Invoke-Phase 'cargo-test' 'cargo' @('test', '--offline', '--locked', '--manifest-path', 'bridge/rust/Cargo.toml')
      Invoke-Phase 'cargo-release' 'cargo' @('build', '--offline', '--locked', '--release', '--manifest-path', 'bridge/rust/Cargo.toml', '--bin', 'razer-companion')
      Invoke-Phase 'contract-build' 'cargo' @('test', '--offline', '--locked', '--manifest-path', 'bridge/rust/Cargo.toml', '--test', 'contract-server', '--no-run', '--message-format=json')
      # Cargo progress is kept in the separate stderr log.
      $rows = @(Get-Content (Join-Path $Output 'contract-build.log'))
      $contract = Get-ContractExecutable $rows
      @{sha256 = (Get-FileHash -LiteralPath $contract).Hash.ToLowerInvariant()} | ConvertTo-Json | Set-Content (Join-Path $Output 'contract-binary.json')
      Invoke-Phase 'differential' 'node' @('scripts/verify-companion-contract.mjs', '--candidate-test-server', $contract)
      Invoke-Phase 'launcher' 'node' @('scripts/verify-companion-launcher.mjs', '--candidate-test-server', $contract)
      Invoke-Phase 'frontend-build' 'npm' @('run', 'build')
      Get-FileHash bridge/rust/target/release/razer-companion.exe | Select-Object Hash | ConvertTo-Json | Set-Content (Join-Path $Output 'production-binary.json')
    }
    'browser' {
      Invoke-Phase 'macro-storage' 'node' @('scripts/verify-macro-storage.mjs')
      Invoke-Phase 'project-qa' 'node' @('scripts/verify-project-qa.mjs')
      $ready = Join-Path $Output 'static-server.json'
      $server = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList @('scripts/ci-static-server.mjs', 'public', "`"$ready`"") -PassThru -WindowStyle Hidden -RedirectStandardOutput (Join-Path $Output 'static-server.log') -RedirectStandardError (Join-Path $Output 'static-server-error.log')
      $deadline = [DateTime]::UtcNow.AddSeconds(10)
      while (!(Test-Path -LiteralPath $ready)) {
        if ($server.HasExited -or [DateTime]::UtcNow -gt $deadline) { throw 'Owned static server failed to start' }
        Start-Sleep -Milliseconds 50
      }
      $binding = Get-Content -LiteralPath $ready -Raw | ConvertFrom-Json
      if ($binding.pid -ne $server.Id -or $binding.url -notmatch '^http://127\.0\.0\.1:\d+$') { throw 'Owned static server binding mismatch' }
      $env:UI_URL = $binding.url
      Invoke-Phase 'ui' 'npm' @('run', 'test:ui')
    }
    'hardware' { Invoke-Phase 'hardware-offline' 'node' @('--test', 'tests/companion-hardware-check.mjs') }
  }
} finally {
  if ($server -and !$server.HasExited) { Stop-Process -Id $server.Id -ErrorAction SilentlyContinue }
  if ($null -ne $before) {
    $after = Get-Sources
    $after | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $Output 'source-after.json')
    $stable = ($before | ConvertTo-Json -Compress) -ceq ($after | ConvertTo-Json -Compress)
    @{suite = $Suite; sourceStable = $stable; phases = $phases.ToArray()} | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Output 'receipt.json')
    if (!$stable) { throw 'Source changed during CI verification' }
  }
  Pop-Location
}
