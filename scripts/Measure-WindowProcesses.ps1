# Objective: Collect one bounded snapshot of this VS Code window's pwsh processes independently of those processes.
$utf8 = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8
$OutputEncoding = $utf8
$ErrorActionPreference = 'Stop'
try {
    if (!$IsWindows -or $PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7) { throw 'UnsupportedPlatform' }
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
    $rootIds = @($request.rootProcessIds | Where-Object { $_ -is [long] -or $_ -is [int] } | ForEach-Object { [int]$_ } | Where-Object { $_ -gt 0 })
    if (!$rootIds.Count -or $rootIds.Count -gt 256 -or !$request.editorExecutable) { throw 'InvalidRequest' }
    . (Join-Path $PSScriptRoot 'Select-WindowProcesses.ps1')
    $snapshot = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, CreationDate, Name, ExecutablePath)
    $errors = [Collections.Generic.List[object]]::new()
    $selected = @(Select-WindowPowerShellProcess -Processes $snapshot -RootProcessIds $rootIds -EditorExecutable $request.editorExecutable -ExcludedProcessId $PID -OwnershipErrors $errors)
    $availableIds = [Collections.Generic.HashSet[int]]::new()
    foreach ($entry in $snapshot) { [void]$availableIds.Add([int]$entry.ProcessId) }
    foreach ($rootId in $rootIds) {
        if (!$availableIds.Contains($rootId) -and $errors.Count -lt 256) {
            $errors.Add([pscustomobject]@{ pid = $rootId; code = 'rootUnavailable' })
        }
    }
    $samples = [Collections.Generic.List[object]]::new()
    $limited = $selected.Count -gt 256 -or $errors.Count -ge 256
    $editorVerified = $false
    foreach ($selection in $selected | Select-Object -First 256) {
        $native = $selection.Process
        $process = $null
        try {
            $process = Get-Process -Id $native.ProcessId -ErrorAction Stop
            $created = $process.StartTime.ToUniversalTime()
            if ($process.ProcessName -ine 'pwsh' -or ($created - $native.CreationDate.ToUniversalTime()).Duration().TotalMilliseconds -gt 0.001) { throw 'IdentityChanged' }
            $process.Refresh()
            if ($process.HasExited -or $process.StartTime.ToUniversalTime() -ne $created) { throw 'IdentityChanged' }
            $samples.Add([pscustomobject]@{
                pid = [int]$native.ProcessId; createdAt = $created.ToString('O')
                privateBytes = $process.PrivateMemorySize64; workingSetBytes = $process.WorkingSet64
                measuredAt = [DateTime]::UtcNow.ToString('O'); collectorPowerShellVersion = $PSVersionTable.PSVersion.ToString()
                rootPid = $selection.RootProcessId
                parentPid = [int]$native.ParentProcessId
                cpuTimeMs = $null; threadCount = $null; handleCount = $null
            })
            # Supplementary metrics must not turn a valid memory measurement into an unavailable process.
            try { $samples[$samples.Count - 1].cpuTimeMs = $process.TotalProcessorTime.TotalMilliseconds } catch { }
            try { $samples[$samples.Count - 1].threadCount = $process.Threads.Count } catch { }
            try { $samples[$samples.Count - 1].handleCount = $process.HandleCount } catch { }
            if ($request.editor -and [int]$request.editor.pid -eq [int]$native.ProcessId) {
                # Only the explicitly associated Editor Services process can authorize its restart command.
                $editorProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($native.ProcessId)" -Property CommandLine, ExecutablePath, CreationDate
                $commandLine = [string]$editorProcess.CommandLine
                $valid = $editorProcess.ExecutablePath -ieq $request.editor.shellPath -and
                    $commandLine -match 'Start-EditorServices' -and $commandLine -notmatch '-DebugServiceOnly\b'
                foreach ($pair in @(@('LogPath', $request.editor.logPath), @('SessionDetailsPath', $request.editor.sessionPath))) {
                    $escaped = ([string]$pair[1]).Replace("'", "''")
                    $pattern = '(?i)(?:^|\s)-' + $pair[0] + "\s+'" + [regex]::Escape($escaped) + "'(?=\s|`"|$)"
                    $valid = $valid -and [regex]::Matches($commandLine, $pattern).Count -eq 1
                }
                $editorVerified = $valid -and $process.StartTime.ToUniversalTime() -eq $created
            }
        } catch {
            if ($errors.Count -lt 256) {
                $errors.Add([pscustomobject]@{ pid = [int]$native.ProcessId; code = 'processUnavailableOrChanged' })
            } else { $limited = $true }
        } finally { if ($process) { $process.Dispose() } }
    }
    @{ processes = @($samples.ToArray()); errors = @($errors.ToArray()); limited = $limited
        editorVerified = [bool]$editorVerified; powerShellVersion = $PSVersionTable.PSVersion.ToString() } | ConvertTo-Json -Depth 5 -Compress
} catch {
    @{ error = if ($_.Exception.Message -eq 'UnsupportedPlatform') { 'unsupported' } else { 'collectionFailed' } } | ConvertTo-Json -Compress
    exit 1
}
