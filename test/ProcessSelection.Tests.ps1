# Objective: Verify independent ownership invariants on a prepared process graph, including PID reuse and editor boundaries.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../scripts/Select-WindowProcesses.ps1')
function New-ProcessFixture([int]$Id, [int]$Parent, [string]$Name, [int]$Age = 10, [string]$Executable = '') {
    [pscustomobject]@{ ProcessId = $Id; ParentProcessId = $Parent; Name = $Name
        CreationDate = ([DateTime]'2026-10-29T00:00:00Z').AddSeconds($Age); ExecutablePath = $Executable }
}
$editorPath = 'C:\Code\Code.exe'
$graph = @(
    (New-ProcessFixture 10 0 'Code.exe' 0 $editorPath),
    (New-ProcessFixture 11 10 'Code.exe' 1 $editorPath),
    (New-ProcessFixture 12 11 'pwsh.exe'),
    (New-ProcessFixture 20 10 'Code.exe' 1 $editorPath),
    (New-ProcessFixture 30 20 'pwsh.exe'),
    (New-ProcessFixture 31 20 'cmd.exe'),
    (New-ProcessFixture 32 31 'pwsh.exe' 11),
    (New-ProcessFixture 33 32 'pwsh.exe' 12),
    (New-ProcessFixture 40 30 'pwsh.exe' 12),
    (New-ProcessFixture 50 20 'pwsh.exe'),
    (New-ProcessFixture 60 30 'Code.exe' 11 $editorPath),
    (New-ProcessFixture 61 60 'pwsh.exe' 12),
    (New-ProcessFixture 70 80 'pwsh.exe' 11),
    (New-ProcessFixture 80 30 'cmd.exe' 20),
    (New-ProcessFixture 90 91 'pwsh.exe'),
    (New-ProcessFixture 91 90 'cmd.exe'),
    (New-ProcessFixture 99 11 'pwsh.exe'),
    (New-ProcessFixture 100 0 'Code.exe' 0 $editorPath),
    (New-ProcessFixture 101 100 'Code.exe' 1 $editorPath),
    (New-ProcessFixture 102 101 'pwsh.exe')
)
$actual = @(Select-WindowPowerShellProcess -Processes $graph -HostProcessId 11 -RootProcessIds @(11, 30, 31) -EditorExecutable $editorPath -ExcludedProcessId 99)
$ids = @($actual | ForEach-Object { $_.Process.ProcessId } | Sort-Object)
if (($ids -join ',') -cne '12,30,32,33,40') { throw "Wrong selection: $($ids -join ',')" }
if (@(Select-WindowPowerShellProcess -Processes $graph -HostProcessId 11 -RootProcessIds @(11, 30, 31) -EditorExecutable 'C:\Other\Code.exe' -ExcludedProcessId 99).Count -ne 0) { throw 'Executable mismatch accepted.' }
if (@(Select-WindowPowerShellProcess -Processes $graph -HostProcessId 11 -RootProcessIds @() -EditorExecutable $editorPath -ExcludedProcessId 99).Count -ne 0) { throw 'Unowned process accepted.' }
$ownershipErrors = [Collections.Generic.List[object]]::new()
$null = Select-WindowPowerShellProcess -Processes $graph -HostProcessId 11 -RootProcessIds @(11, 30, 31) -EditorExecutable 'C:\Other\Code.exe' -ExcludedProcessId 99 -OwnershipErrors $ownershipErrors
if (!$ownershipErrors.Count -or $ownershipErrors[0].code -ne 'ownershipUnverified') { throw 'Unverified ownership was silently reported as an empty complete inventory.' }
$rootedChild = $actual | Where-Object { $_.Process.ProcessId -eq 33 }
if ($rootedChild.RootProcessId -ne 31) { throw 'Wrong terminal ownership root.' }
if (@(Select-WindowPowerShellProcess -Processes $graph -HostProcessId 11 -RootProcessIds @(102) -EditorExecutable $editorPath).Count) { throw 'Another instance of the same executable accepted.' }
if (@(Select-WindowPowerShellProcess -Processes $graph -HostProcessId 11 -RootProcessIds @(61) -EditorExecutable $editorPath).Count) { throw 'Nested editor instance accepted as the hosting instance.' }
if (@(Select-WindowPowerShellProcess -Processes $graph -RootProcessIds @(11,30) -EditorExecutable $editorPath).Count) { throw 'Missing host identity accepted.' }
if (@(Select-WindowPowerShellProcess -Processes $graph -HostProcessId 999 -RootProcessIds @(11,30) -EditorExecutable $editorPath).Count) { throw 'Unavailable host identity accepted.' }
if (@(Select-WindowPowerShellProcess -Processes $graph -HostProcessId 30 -RootProcessIds @(11,30) -EditorExecutable $editorPath).Count) { throw 'Non-editor host accepted.' }

$insidersPath = 'C:\Insiders\Code - Insiders.exe'
$insidersGraph = $graph + @(
    (New-ProcessFixture 200 0 'Code - Insiders.exe' 0 $insidersPath),
    (New-ProcessFixture 211 200 'Code - Insiders.exe' 1 $insidersPath),
    (New-ProcessFixture 212 211 'pwsh.exe'),
    (New-ProcessFixture 220 200 'Code - Insiders.exe' 1 $insidersPath),
    (New-ProcessFixture 230 220 'cmd.exe'),
    (New-ProcessFixture 231 230 'pwsh.exe'),
    (New-ProcessFixture 232 231 'pwsh.exe' 11),
    (New-ProcessFixture 300 0 'Code - Insiders.exe' 0 $insidersPath),
    (New-ProcessFixture 301 300 'pwsh.exe')
)
$insiders = @(Select-WindowPowerShellProcess -Processes $insidersGraph -HostProcessId 211 -RootProcessIds @(211,230,12,102,301) -EditorExecutable $insidersPath)
$insidersIds = @($insiders | ForEach-Object { $_.Process.ProcessId } | Sort-Object)
if (($insidersIds -join ',') -cne '212,231,232') { throw "Insiders instance isolation failed: $($insidersIds -join ',')" }
$reusedHost = @((New-ProcessFixture 400 401 'Code - Insiders.exe' 1 $insidersPath),
    (New-ProcessFixture 401 0 'Code - Insiders.exe' 20 $insidersPath), (New-ProcessFixture 402 400 'pwsh.exe'))
if (@(Select-WindowPowerShellProcess -Processes $reusedHost -HostProcessId 400 -RootProcessIds @(400) -EditorExecutable $insidersPath).Count) { throw 'Reused editor parent PID accepted.' }
$cyclicHost = @((New-ProcessFixture 500 501 'Code - Insiders.exe' 1 $insidersPath),
    (New-ProcessFixture 501 500 'Code - Insiders.exe' 1 $insidersPath), (New-ProcessFixture 502 500 'pwsh.exe'))
if (@(Select-WindowPowerShellProcess -Processes $cyclicHost -HostProcessId 500 -RootProcessIds @(500) -EditorExecutable $insidersPath).Count) { throw 'Cyclic editor ancestry accepted.' }
@{ passed = 17; selected = $ids; insidersSelected = $insidersIds; cases = @('terminal', 'nested pwsh', 'non-pwsh terminal', 'extension host child', 'other window', 'new editor boundary', 'reused parent PID', 'cycle and collector exclusion', 'unverified ownership is explicit', 'same executable separate instance', 'nested editor root', 'missing host', 'unavailable host', 'non-editor host', 'Insiders versus Stable and separate Insiders', 'reused editor PID', 'cyclic editor ancestry') } | ConvertTo-Json -Compress
