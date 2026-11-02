# Objectif : Simuler les outils natifs pour vérifier le script de livraison sans modifier VS Code.
param([string]$BuildScript, [string]$FakeCli, [string]$Report, [string]$Scenario)
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$ErrorActionPreference = 'Stop'
$env:WATCHDOG_VSIX_FIXTURE_SCENARIO = $Scenario
$env:WATCHDOG_VSIX_FIXTURE_CALLS = "$Report.calls.jsonl"
$env:WATCHDOG_VSIX_FIXTURE_TEMPLATE = "$Report.template.vsix"
$zip = [IO.Compression.ZipFile]::Open($env:WATCHDOG_VSIX_FIXTURE_TEMPLATE, [IO.Compression.ZipArchiveMode]::Create)
try {
    $entry = $zip.CreateEntry('extension/package.json')
    $writer = [IO.StreamWriter]::new($entry.Open(), $utf8)
    $version = if ($Scenario -eq 'WrongVersion') { '9.9.9' } else { '1.2.3' }
    try { $writer.WriteAsync((@{ name = 'fixture-watchdog'; publisher = 'FrenchExDev'; version = $version } | ConvertTo-Json)).GetAwaiter().GetResult() | Out-Null }
    finally { $writer.Dispose() }
} finally { $zip.Dispose() }
$success = $false
$errorMessage = $null
$result = $null
try {
    $arguments = @{ Channel = 'Stable'; CodeCliPath = $FakeCli; Profile = 'Développement équipe' }
    if ($Scenario -eq 'Preview') { $arguments.WhatIf = $true }
    $result = & $BuildScript @arguments
    $success = $true
} catch { $errorMessage = $_.Exception.Message }
$calls = if (Test-Path -LiteralPath $env:WATCHDOG_VSIX_FIXTURE_CALLS) {
    @(Get-Content -LiteralPath $env:WATCHDOG_VSIX_FIXTURE_CALLS -Encoding utf8 | ForEach-Object { $_ | ConvertFrom-Json })
} else { @() }
[IO.File]::WriteAllTextAsync($Report, (@{ Success = $success; Error = $errorMessage; Result = $result;
    Calls = @($calls); LoadedModules = @(Get-Module | Select-Object -ExpandProperty Name);
    WorkingDirectory = $PWD.Path } | ConvertTo-Json -Depth 8), $utf8).GetAwaiter().GetResult() | Out-Null
