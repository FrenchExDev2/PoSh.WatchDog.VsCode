# Objective: Select pwsh processes owned by this window without crossing another VS Code host boundary.
function Get-WindowEditorInstance {
    <# .SYNOPSIS
    Resolve the application root through consecutive editor processes, rejecting cycles and reused parent PIDs.
    #>
    param([object]$Process, [hashtable]$ProcessesById, [string]$EditorExecutable)
    $seen = [Collections.Generic.HashSet[int]]::new()
    for ($depth = 0; $Process -and $depth -lt 128; $depth++) {
        if (!$seen.Add([int]$Process.ProcessId) -or !$Process.CreationDate -or
            $Process.Name -inotmatch '^Code( - Insiders)?\.exe$' -or $Process.ExecutablePath -ine $EditorExecutable) { return }
        $parent = $ProcessesById[[int]$Process.ParentProcessId]
        if (!$parent -or $parent.Name -inotmatch '^Code( - Insiders)?\.exe$' -or $parent.ExecutablePath -ine $EditorExecutable) { return $Process }
        if (!$parent.CreationDate -or $parent.CreationDate -gt $Process.CreationDate) { return }
        $Process = $parent
    }
}

function Select-WindowPowerShellProcess {
    <# .SYNOPSIS
    Select only window-owned pwsh descendants of the extension host's actual editor instance.
    #>
    param([object[]]$Processes, [int[]]$RootProcessIds, [string]$EditorExecutable, [int]$ExcludedProcessId,
        [Collections.Generic.List[object]]$OwnershipErrors, [int]$HostProcessId)
    $byId = @{}
    foreach ($entry in $Processes) { $byId[[int]$entry.ProcessId] = $entry }
    $hostInstance = Get-WindowEditorInstance -Process $byId[$HostProcessId] -ProcessesById $byId -EditorExecutable $EditorExecutable
    $roots = [Collections.Generic.HashSet[int]]::new()
    foreach ($rootId in $RootProcessIds) { [void]$roots.Add($rootId) }
    foreach ($entry in $Processes) {
        if ($entry.Name -ine 'pwsh.exe' -or [int]$entry.ProcessId -eq $ExcludedProcessId) { continue }
        $cursor = $entry
        $seen = [Collections.Generic.HashSet[int]]::new()
        $owned = $false
        $wasSelected = $false
        $rootId = 0
        for ($depth = 0; $cursor -and $depth -lt 128; $depth++) {
            if (!$seen.Add([int]$cursor.ProcessId)) { break }
            if ($roots.Contains([int]$cursor.ProcessId)) { $owned = $true; $rootId = [int]$cursor.ProcessId }
            # The first Code process is the ownership boundary. Never walk through a different editor host.
            if ($cursor.Name -iin @('Code.exe', 'Code - Insiders.exe')) {
                $instance = Get-WindowEditorInstance -Process $cursor -ProcessesById $byId -EditorExecutable $EditorExecutable
                if ($owned -and $hostInstance -and $instance -and $instance.ProcessId -eq $hostInstance.ProcessId) {
                    $wasSelected = $true
                    [pscustomobject]@{ Process = $entry; RootProcessId = $rootId }
                }
                break
            }
            $parent = $byId[[int]$cursor.ParentProcessId]
            if (!$parent -or !$cursor.CreationDate -or !$parent.CreationDate -or $parent.CreationDate -gt $cursor.CreationDate) { break }
            $cursor = $parent
        }
        if ($owned -and !$wasSelected -and $null -ne $OwnershipErrors -and $OwnershipErrors.Count -lt 256) {
            $OwnershipErrors.Add([pscustomobject]@{ pid = [int]$entry.ProcessId; code = 'ownershipUnverified' })
        }
    }
}
