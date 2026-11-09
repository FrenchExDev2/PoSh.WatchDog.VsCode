# Legacy single-session collector retained as a source reference only; excluded from the VSIX.
# Objective: Measure one independently associated Editor Services process without executing code in that session.
param(
    [Parameter(Mandatory)][int]$ProcessId,
    [Parameter(Mandatory)][string]$ExpectedExecutable,
    [Parameter(Mandatory)][string]$ExpectedLogPath,
    [Parameter(Mandatory)][string]$ExpectedSessionPath
)
$ErrorActionPreference = 'Stop'
try {
    if ($PSVersionTable.PSEdition -ne 'Core' -or $PSVersionTable.PSVersion.Major -lt 7 -or !$IsWindows) { throw 'UnsupportedPlatform' }
    $process = Get-Process -Id $ProcessId -ErrorAction Stop
    $createdAt = $process.StartTime.ToUniversalTime().ToString('O')
    $native = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop
    if (!$native -or $process.ProcessName -ne 'pwsh' -or $native.ExecutablePath -ine $ExpectedExecutable) { throw 'IdentityMismatch' }
    # Never emit or persist the command line. Match only the two independently selected launch artifacts.
    $commandLine = [string]$native.CommandLine
    foreach ($pair in @(@('LogPath', $ExpectedLogPath), @('SessionDetailsPath', $ExpectedSessionPath))) {
        $escapedValue = ([string]$pair[1]).Replace("'", "''")
        $pattern = '(?i)(?:^|\s)-' + [regex]::Escape($pair[0]) + "\s+'" + [regex]::Escape($escapedValue) + "'(?=\s|`"|$)"
        if ([regex]::Matches($commandLine, $pattern).Count -ne 1) { throw 'IdentityMismatch' }
    }
    if ($commandLine -notmatch 'Start-EditorServices' -or $commandLine -match '-DebugServiceOnly\b') { throw 'IdentityMismatch' }
    $process.Refresh()
    if ($process.HasExited -or $process.StartTime.ToUniversalTime().ToString('O') -cne $createdAt) { throw 'IdentityMismatch' }
    @{
        pid = $ProcessId
        createdAt = $createdAt
        privateBytes = $process.PrivateMemorySize64
        workingSetBytes = $process.WorkingSet64
        measuredAt = [DateTime]::UtcNow.ToString('O')
        powerShellVersion = $PSVersionTable.PSVersion.ToString()
    } | ConvertTo-Json -Compress
} catch {
    # Exception text can contain paths or command arguments; expose only a stable diagnostic code.
    $code = if ($_.Exception.Message -eq 'IdentityMismatch') { 'identityMismatch' } elseif ($_.Exception.Message -eq 'UnsupportedPlatform') { 'unsupported' } else { 'processUnavailable' }
    @{ error = $code } | ConvertTo-Json -Compress
    exit 1
}
