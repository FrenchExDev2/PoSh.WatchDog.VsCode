# Objectif : Construire le VSIX du projet et installer cette version dans VS Code.
#Requires -Version 7.6
#Requires -PSEdition Core
<#
.SYNOPSIS
Construit puis installe le VSIX local dans VS Code Insiders ou Stable.
.DESCRIPTION
Utilise la version de package.json et le vsce local. Vérifie le paquet
construit, écrit son SHA-256 puis confirme la version installée via le CLI VS Code.
Les dépendances de développement doivent être présentes (npm ci --ignore-scripts).
.PARAMETER Channel
Édition cible : Insiders par défaut, ou Stable.
.PARAMETER CodeCliPath
Chemin facultatif du lanceur CLI VS Code, par exemple bin/code-insiders.cmd.
.PARAMETER Profile
Profil VS Code facultatif utilisé pour l'installation et sa vérification.
.EXAMPLE
./scripts/Build-InstallVsix.ps1
.EXAMPLE
./scripts/Build-InstallVsix.ps1 -Channel Stable -Profile 'Développement'
.EXAMPLE
./scripts/Build-InstallVsix.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'Low')]
param(
    [ValidateSet('Insiders', 'Stable')]
    [string]$Channel = 'Insiders',
    [string]$CodeCliPath,
    [string]$Profile
)

$utf8 = [System.Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$ErrorActionPreference = 'Stop'

if (-not $IsWindows) { throw 'Ce script cible VS Code Desktop sous Windows.' }
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$package = [IO.File]::ReadAllTextAsync((Join-Path $project 'package.json'), $utf8).GetAwaiter().GetResult() | ConvertFrom-Json
if ($package.name -notmatch '^[a-z0-9][a-z0-9-]*$' -or
    $package.publisher -notmatch '^[a-zA-Z0-9][a-zA-Z0-9-]*$' -or
    $package.version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$') {
    throw 'Identité ou version invalide dans package.json.'
}
$vsce = Join-Path $project 'node_modules/@vscode/vsce/vsce'
if (-not (Test-Path -LiteralPath $vsce -PathType Leaf)) {
    throw "vsce local absent. Exécutez npm ci --ignore-scripts dans $project."
}
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source

# Objectif : Sélectionner le CLI de l'édition demandée, sans changer d'édition implicitement.
if (-not $CodeCliPath) {
    $directory, $launcher = if ($Channel -eq 'Insiders') {
        'Microsoft VS Code Insiders', 'code-insiders.cmd'
    } else { 'Microsoft VS Code', 'code.cmd' }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA "Programs/$directory/bin/$launcher")
        (Join-Path $env:ProgramFiles "$directory/bin/$launcher")
    )
    $CodeCliPath = $candidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
    if (-not $CodeCliPath) {
        $CodeCliPath = (Get-Command $launcher -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
    }
}
if (-not $CodeCliPath -or -not (Test-Path -LiteralPath $CodeCliPath -PathType Leaf)) {
    throw "CLI VS Code $Channel introuvable. Indiquez -CodeCliPath."
}
$CodeCliPath = (Resolve-Path -LiteralPath $CodeCliPath).ProviderPath
$archive = Join-Path $project "dist/$($package.name)-$($package.version).vsix"
if (-not $PSCmdlet.ShouldProcess("$CodeCliPath ; profil : $(if ($Profile) { $Profile } else { 'par défaut' })",
    "Construire $archive puis installer $($package.publisher).$($package.name)@$($package.version)")) { return }

function Invoke-VsixCommand {
    <#
    .SYNOPSIS
    Exécute directement une commande native et arrête le script si elle échoue.
    .PARAMETER Executable
    Chemin de l'exécutable ou du lanceur CLI.
    .PARAMETER NativeArguments
    Arguments natifs transmis comme éléments distincts.
    .PARAMETER Step
    Nom de l'étape pour les messages d'erreur.
    .PARAMETER CaptureOutput
    Retient la sortie pour vérification sans afficher les données intermédiaires.
    #>
    param([string]$Executable, [string[]]$NativeArguments, [string]$Step, [switch]$CaptureOutput)
    $lines = [Collections.Generic.List[string]]::new()
    $PSNativeCommandUseErrorActionPreference = $false
    Write-Host "[$Step]" -ForegroundColor Cyan
    Push-Location -LiteralPath $project
    try {
        & $Executable @NativeArguments 2>&1 | ForEach-Object {
            $line = $_.ToString()
            $lines.Add($line)
            if (-not $CaptureOutput) { Write-Host $line }
        }
        $exitCode = $LASTEXITCODE
    } finally { Pop-Location }
    if ($exitCode -ne 0) {
        if ($CaptureOutput) { $lines | ForEach-Object { Write-Host $_ } }
        throw "$Step : code de sortie $exitCode. Installation interrompue."
    }
    return [pscustomobject]@{ Lines = $lines.ToArray() }
}

# Objectif : Vérifier Node puis construire un paquet neuf pour la version du manifeste.
$version = Invoke-VsixCommand -Executable $node -NativeArguments @('--version') -Step 'Version Node'
if (($version.Lines -join "`n") -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
    throw 'Node 22 ou plus récent est requis.'
}
$null = New-Item -ItemType Directory -Path (Split-Path $archive) -Force
if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive }
if (Test-Path -LiteralPath "$archive.sha256") { Remove-Item -LiteralPath "$archive.sha256" }
$null = Invoke-VsixCommand -Executable $node -NativeArguments @($vsce, 'package', '--no-dependencies', '--out', $archive) -Step 'Packaging VSIX'

# Objectif : Refuser un paquet absent, illisible ou dont l'identité diffère du manifeste source.
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    $entry = $zip.GetEntry('extension/package.json')
    if (-not $entry) { throw 'package.json absent du VSIX.' }
    $reader = [IO.StreamReader]::new($entry.Open(), $utf8)
    try { $packed = $reader.ReadToEndAsync().GetAwaiter().GetResult() | ConvertFrom-Json }
    finally { $reader.Dispose() }
    if ($packed.name -cne $package.name -or $packed.publisher -cne $package.publisher -or $packed.version -cne $package.version) {
        throw 'Identité du VSIX différente du manifeste source. Installation interrompue.'
    }
} finally { $zip.Dispose() }
$hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllTextAsync("$archive.sha256", "$hash  $([IO.Path]::GetFileName($archive))`n", $utf8).GetAwaiter().GetResult() | Out-Null

# Objectif : Installer exactement le VSIX construit puis confirmer sa version dans le même profil.
$profileArguments = if ($Profile) { @('--profile', $Profile) } else { @() }
$null = Invoke-VsixCommand -Executable $CodeCliPath -NativeArguments (@('--install-extension', $archive, '--force') + $profileArguments) -Step 'Installation VSIX'
$installed = Invoke-VsixCommand -Executable $CodeCliPath -NativeArguments (@('--list-extensions', '--show-versions') + $profileArguments) -Step 'Vérification installation' -CaptureOutput
$expected = "$($package.publisher).$($package.name)@$($package.version)"
if (-not ($installed.Lines | Where-Object { $_.Trim() -ieq $expected })) {
    throw "Version installée non confirmée : $expected."
}
[pscustomobject]@{
    Extension = $expected; Channel = $Channel; CodeCliPath = $CodeCliPath; Profile = $Profile
    VSIX = $archive; SHA256 = $hash
    NextStep = 'Dans VS Code : Developer: Reload Window, puis PowerShell Watchdog: Resume.'
}
