<p align="center">
  <img src="./images/icon.png" alt="PowerShell Memory Watchdog logo" width="150px" />
</p>

# PowerShell Memory Watchdog

Monitor the memory used by PowerShell processes in each VS Code window. Get alerts for terminals and nested `pwsh` processes, and optionally restart a verified PowerShell Editor Services session when its memory stays too high.

Windows Desktop only. Runs locally, with no runtime npm dependencies or telemetry.

## Install

Use **Extensions: Install from VSIX…** to install `dist/powershell-watchdog-0.5.2.vsix`, then reload the window if upgrading.

Requires **VS Code 1.114+** (Stable or Insiders), **Windows** and **PowerShell 7 Core** for the independent collector. Monitoring ordinary processes needs neither the Microsoft PowerShell extension nor an open `.ps1` file.

Automatic Editor Services restart requires **ms-vscode.powershell 2026.1.2** and a verified association with the current window. Unknown versions or ambiguous associations leave monitoring and alerts available. Remote windows, browsers, Linux and macOS are unsupported.

## Use

The status bar shows the process count and total private committed memory:

`pwsh 3 · 0.42 GiB total · Monitoring`

Hover for per-process measurements; click for actions. `≥` marks an incomplete total. Discovery, collection errors and a completed inventory with no processes have distinct status messages.

Thresholds apply **to each process**, independently of the displayed total. Private and resident memory are reported separately and never added together.

| Default | Value |
| --- | --- |
| Collection interval | 15 seconds |
| Warning threshold | 4 GiB per process |
| Restart threshold | 8 GiB per process, for 3 consecutive samples |
| Restart countdown | 30 seconds, cancellable |
| Stabilization after restart | 120 seconds |
| Automatic request limit | 3 per rolling hour |

One GiB is 1,073,741,824 bytes.

## Live dashboard

Open the **PowerShell Watchdog** activity-bar view or run **PowerShell Watchdog: Open Live Dashboard** for a larger editor tab. Both receive the same live measurements.

- At the top, **Live monitoring → Refresh interval** configures live collection: **0 (off), 250 ms, 500 ms, 1 s, 2 s or 5 s**, shared between this window's dashboard views. The current cadence appears below the selector. The delay starts after collection completes; live collection pauses while every dashboard is hidden. Off preserves the normal Watchdog schedule. The selection lasts for the current extension session.
- Private and resident memory curves with process selection, creation-time identities and explicit collection gaps. Blue curves show private memory; purple dashed curves show resident memory. The vertical axis has Gio (GiB) graduations and horizontal grid lines, with readable labels that adapt to the sidebar width.
- **Development, Tests and Build thresholds appear together** on the diagram, using current user settings and absolute overrides for the selected process kind. The active profile is marked in the legend; dotted lines show warning thresholds and long-dashed lines show high thresholds. Toggle **Show all workload profiles** to hide these comparison lines.
- Processes grouped by terminal/root, sorted by private memory, CPU, PID or process tree; filter by Editor Services, terminal or child.
- Private memory, resident memory, CPU, threads, handles, growth and observed activity. **Open** focuses the process's current terminal when it is still available.
- Workload profile, scheduled restart actions, collection health and recent persisted events.

CPU is derived from cumulative processor time between valid observations: **100% means one logical core**, so multithreaded processes can exceed 100%. The first observation and collection gaps have unknown CPU. Optional metric failures leave those values unknown without discarding a valid memory sample. The tree contains owned **pwsh** processes; non-PowerShell parents appear only as parent/root PIDs.

Growth alerts default to **+500 MiB over five minutes**. They require at least three observations, a complete time window and at least 75% nondecreasing steps. Alerts are emitted once per sustained episode, independently of restart thresholds. A growth alert **does not establish a memory leak**. Process exit, PID reuse, invalid collection, policy change or a collection gap resets trend evidence; at most 1,024 observations are kept per process.

## Workload profiles and thresholds

A workload profile sets how much private committed memory Watchdog tolerates **per process** before warning or reaching the high threshold. Higher thresholds allow more memory for demanding workloads such as test suites and builds.

With the default global thresholds (`warningPrivateGiB: 4`, `restartPrivateGiB: 8`) and no per-process overrides:

| Profile | Intended workload | Multiplier | Warning | High threshold |
| --- | --- | ---: | ---: | ---: |
| `development` (default) | Everyday editing and development | ×1 | 4 GiB | 8 GiB |
| `tests` | Test suites that need more memory | ×1.5 | 6 GiB | 12 GiB |
| `build` | Memory-intensive builds | ×2 | 8 GiB | 16 GiB |

Choose a profile manually through **PowerShell Watchdog: Select Workload Profile…** or the dashboard. Watchdog saves the choice in VS Code user settings; it does not automatically switch profiles when tests or builds start, or revert when they finish. Selecting a profile only changes these memory thresholds; it does not launch a workload or change PowerShell's execution settings.

The multiplier applies to your configured global thresholds, so changing those base values also changes the table's effective values. An explicit `processThresholds` value is an **absolute GiB threshold**: it takes precedence for that process kind and is never multiplied. Warning and high overrides are independent; an omitted value still uses the corresponding global threshold multiplied by the profile factor.

For example, this configuration selects `tests` but explicitly sets both thresholds for all three process kinds, so those values stay the same whichever profile is selected:

```json
{
  "frenchexdev.powershellWatchdog.profile": "tests",
  "frenchexdev.powershellWatchdog.processThresholds": {
    "editorServices": { "warningPrivateGiB": 4, "restartPrivateGiB": 8 },
    "terminal": { "warningPrivateGiB": 6, "restartPrivateGiB": 12 },
    "child": { "warningPrivateGiB": 2, "restartPrivateGiB": 4 }
  }
}
```

The high threshold can trigger an automatic restart only for verified **Editor Services**, subject to the restart policy and its protections. Terminal/child high thresholds remain alert-only. Profile and threshold changes require fresh measurements and cancel any existing countdown. All settings remain user-machine scoped.

## Restart policy

The default mode is `automatic` **for verified Editor Services only**. Ordinary terminals and child processes always receive alerts only. Watchdog never forcibly terminates a process or closes a terminal.

**Restarting Editor Services discards its variables, modules and session state, and may interrupt a command.** PowerShell debugging defers automatic restart requests; an inactive debugger does not mean the console is idle. Choose `notifyOnly` for alerts on every process.

Once high memory is confirmed, `restartGraceSeconds` starts a countdown (default 30; zero disables it). The notification and dashboard offer **Cancel this episode**, **Postpone 5 minutes** and **Restart now**. Cancel blocks further automatic requests for that process until a measured value drops below its high threshold; postponement keeps collecting. Cancellation survives profile changes and reloads; postponement survives reloads. Resume explicitly clears them while preserving quotas. Restart now shortens the countdown and still requires fresh identity, memory, activity and policy checks. The separate manual restart command retains its confirmation dialog.

`deferWhileRunningCommands` defaults to true. Watchdog observes VS Code terminal shell-execution start/end events without reading command text or output. A known busy Editor Services terminal defers automatic restart and invalidates existing evidence. **Unknown activity never means idle.** Editor Services may not provide shell integration events; `requireKnownIdle: true` makes that unknown state block automatic restart as well. Ordinary terminal activity is displayed but does not grant restart authority or imply the editor is busy. Activity changes are checked again immediately before command dispatch, including while a quota save is pending.

Configure `frenchexdev.powershellWatchdog.*` in **user settings**. Workspace and folder overrides are ignored. Invalid policies disable automatic decisions and explain why.

The collection interval begins after each collection completes. Continuity checks allow the collector deadline plus scheduling tolerance; a collection failure or a longer gap resets consecutive samples. A pending quota save does not prevent disabling, suspending or deferring a restart before its command is sent.

Failed or timed-out restart requests, persistent high memory after stabilization, and exhausted quotas suspend automatic actions. **Enable** and **Resume** both enable monitoring, clear persisted suspension and acknowledge the previous improvement check, then immediately request fresh measurements. Cooldown, rolling-hour quota and pending-command protections remain active; an exhausted quota can suspend automatic restarts again. Disabling Watchdog survives a window reload.

## Diagnostics

From the command palette:

- **PowerShell Watchdog: Show Diagnostics** opens JSON with the policy, process inventory, decisions, errors and environment versions.
- **PowerShell Watchdog: Open Live Dashboard** opens the live process/history/health view.
- **PowerShell Watchdog: Open Visual Diagnostics (HTML)** saves an offline report and displays it in a VS Code editor tab. It includes memory curves, process selection, observed peaks and recorded events. Running the command again refreshes the same tab.
- **PowerShell Watchdog: Restart Editor Services Session…** requests a manual editor-session restart.

HTML reports are dated snapshots retained in the extension's storage. Generate a new report to refresh it. Exporting does not trigger collection or restart. Gaps remain visible and recorded peaks are not lifetime maxima.

History now lives under the workspace extension storage's `history` directory, with a separate writer identity per activation. Reloading restores the latest 200 events for the live view; HTML exports read the retained disk history. History is **workspace-scoped across sessions**, including other windows of that same workspace, while the current inventory remains window-scoped. Empty windows use extension global storage. Historic log-session files from versions before 0.4 are not migrated. No historic consecutive-sample or CPU series can authorize a restart.

`historyRetentionDays` / `historyMaxMiB` default to **14 days / 15 MiB**. Owned history segments are pruned during writes and retained-history reads. Entries outside the age limit are excluded even if their segment is newer. The oldest segments are removed first, so the retained duration may be shorter than the age limit. `reportRetentionDays` / `reportMaxMiB` default to **14 days / 20 MiB**; owned HTML exports are pruned before a new export. A single oversized export is rejected with an action error. Unrelated files and directories are preserved. Simultaneous windows can temporarily exceed a shared storage budget until the next pruning operation; cross-process transactional storage is not provided.

The health view and JSON include collection start/end, duration, next scheduled collection, consecutive collection errors, stale measurements, incomplete inventories, editor association, activity source, storage errors and known automatic-restart blockers. A missing blocker is not permission to restart: threshold, continuity, quota and final checks still apply.

Suspend, resume and configuration changes are recorded even without a new memory collection. Repeated paused cycles do not add duplicate state events.

Only processes with a verifiable ownership chain to the current window and the extension host's actual VS Code application instance are included. Matching the executable path alone is insufficient: separate instances of the same executable and nested editor instances are excluded. Terminal roots must belong to that same instance. Missing host identity, cyclic ancestry or reused parent PIDs cannot authorize selection or restart. Detached processes may be excluded. Collection errors never become zero memory, and full command lines are neither returned nor logged.

## Development and details

Development requires Node 22+. Install tools with `npm ci --ignore-scripts`, run `node --test test/*.test.js`, and package with `node node_modules/@vscode/vsce/vsce package --no-dependencies --out dist/`. Agents must follow the repository's QuietCli instructions.

To build and install the current version automatically, run in PowerShell Core 7.6+:

```powershell
./scripts/Build-InstallVsix.ps1                      # VS Code Insiders (default)
./scripts/Build-InstallVsix.ps1 -Channel Stable      # VS Code Stable
./scripts/Build-InstallVsix.ps1 -Profile 'Development'
./scripts/Build-InstallVsix.ps1 -WhatIf              # Preview without building or installing
```

The script locates the project independently of the current directory, uses local `vsce`, verifies the packaged identity, writes a SHA-256 file in `dist/`, installs the VSIX and confirms its installed version. It calls Node and the VS Code CLI directly, with readable terminal output. It requires Node 22+ and the development dependencies above; no PowerShell module is required. Use `-CodeCliPath` for a custom VS Code CLI location. Reload the target VS Code window after installation to load the new code.

- [Qualification](QUALIFICATION.md): tested environments, browser and integration evidence, and remaining limits.
- [Release guide](RELEASING.md): automated Marketplace publication from a version tag.
- [Changelog](CHANGELOG.md).
