<p align="center">
  <img src="./images/icon.png" alt="FrenchExDev Memory Watchdog logo" width="150px" />
</p>

# FrenchExDev Memory Watchdog

Per-window memory watchdog for VS Code on **Windows, Linux and macOS**. It monitors the processes of each VS Code window (terminals, language servers, tools) described by **config files** grouped into **profiles**, alerts when one uses too much memory, and can restart a target **only through its own VS Code command**.

Out of the box it behaves like 0.5.x: the built-in `default` profile watches the PowerShell Editor Services session (`ms-vscode.powershell`), `pwsh` terminals and nested `pwsh` processes, and only a verified Editor Services session may restart automatically.

Runs locally, with no runtime npm dependencies or telemetry. The extension ID stays `FrenchExDev.powershell-watchdog`.

Independent project, not affiliated with or endorsed by Microsoft. Released under the [MIT License](LICENSE); see [CREDITS.md](CREDITS.md) for links and trademark notices.

## Install

Use **Extensions: Install from VSIX…** to install `dist/powershell-watchdog-0.6.0.vsix`, then reload the window if upgrading. When upgrading from 0.5.x, Watchdog offers once to migrate your settings (see [Migration from 0.5.x](#migration-from-05x)).

Requires **VS Code 1.114+** (Stable or Insiders) on a local Desktop window. On Windows the collector uses PowerShell 7 (`pwsh` from `PATH`) and falls back to the built-in Windows PowerShell 5.1; Linux and macOS need nothing extra. Monitoring needs neither the Microsoft PowerShell extension nor an open `.ps1` file.

Automatic Editor Services restart requires **ms-vscode.powershell 2026.1.2** and a verified association with the current window. The immutable allowlist in `src/session.js` intentionally admits only qualified launch formats: a version change may invalidate process association. Unknown versions or ambiguous associations leave monitoring and alerts available. Remote windows and VS Code for the Web are unsupported.

## Compatibility

| | Windows x64 / arm64 | Linux x64 / arm64 | macOS x64 / arm64 |
| --- | --- | --- | --- |
| Process enumeration, parent PID, start time | CIM `Win32_Process` through `pwsh` (or Windows PowerShell 5.1) | `/proc/<pid>/stat`, `status`, `cmdline`, `exe` | `ps -axww` |
| **Private memory** | Private committed bytes (`PrivatePageCount`) | Anonymous resident memory + swap (`RssAnon` + `VmSwap`); RSS on kernels without `RssAnon` | **Resident set size** (`ps rss`): macOS has no unprivileged private-bytes counter, so shared pages are included |
| Resident memory | Working set | `VmRSS` | `ps rss` |
| CPU, threads, handles | CPU, threads, handles | CPU, threads; handles unknown | CPU only; threads and handles unknown |
| Command line for `match.commandLine` | Yes | Yes (`cmdline`) | Yes (`ps args`) |
| Process names | `.exe` removed, case-insensitive | Case-sensitive | Case-sensitive |
| Editor instance detection | Same executable as the extension host | Same executable as the extension host | Any executable of the same `.app` bundle (main binary and `Helper` apps) |
| Validation | **Tested on Windows x64** (unit, browser and live snapshot tests) | Fixture-based unit tests only | Fixture-based unit tests only |

Not yet verified on a real Linux or macOS machine, nor on arm64. On macOS thresholds compare RSS, which is usually higher than private memory: consider larger values there.

## Use

The status bar shows the measured process count and their total private memory:

`3 proc · 430.08 MiB total · Monitoring`

A warning icon after the text means a config problem or a config waiting for approval (hover for details).

Hover details use an absolute collection timestamp and update when measurements or state change; unchanged text, tooltip and background are not reassigned. Use the live dashboard for a persistent view.

Memory values use binary units (B, KiB, MiB, GiB, TiB or PiB), with at most two decimal places: `512 KiB`, `1.5 GiB`. `≥` marks an incomplete total. Thresholds apply **to each process**, independently of the displayed total. Private and resident memory are reported separately and never added together.

| Built-in default (Editor Services) | Value |
| --- | --- |
| Collection interval | 15 seconds |
| Warning threshold | 4 GiB per process |
| Restart threshold | 8 GiB per process, for 3 consecutive samples |
| Restart countdown | 30 seconds, cancellable |
| Stabilization after restart | 120 seconds |
| Automatic request limit | 3 per rolling hour |

One GiB is 1,073,741,824 bytes.

## Configs

A config is one JSON file named `<name>.watchdog.json` describing **one target**. VS Code validates and completes these files from the bundled JSON schema.

```json
{
  "schemaVersion": 1,
  "name": "node-build",
  "label": "Node build tools",
  "match": { "processNames": ["node"], "ownership": "child", "commandLine": "webpack|vite" },
  "thresholds": { "warningPrivateGiB": 3, "actionPrivateGiB": 6, "consecutiveSamples": 3 },
  "action": { "mode": "notifyOnly" },
  "scaleWithWorkload": true
}
```

- `name` must equal the file name without `.watchdog.json` (lowercase letters, digits, `.`, `_`, `-`).
- `match.processNames`: executable names without a path. `.exe` is optional and case is ignored on Windows; on Linux and macOS names are case-sensitive. `["*"]` matches any name and requires `commandLine` unless `ownership` is `terminal`.
- `match.ownership`: `terminal` (the shell of an integrated terminal), `child` (a descendant of a terminal or of the extension host), `extensionHost` (a direct child of the extension host, for example language servers) or `window` (any of these).
- `match.commandLine`: optional case-insensitive regular expression, evaluated in an isolated context with a 100 ms budget; a slow or invalid pattern disables only that config. Command lines are never stored, logged or shown.
- Only processes owned by **this window** (verified ancestry up to the extension host of this VS Code instance) can match. The first config of the profile that matches a process wins.
- `thresholds.actionPrivateGiB` must be greater than `warningPrivateGiB`. Optional `growthWarningMiB` / `growthWindowSeconds` set growth alerts.
- `action.mode`: `notifyOnly` (default) or `automatic`; `action.restartCommand`: the VS Code command that restarts the target, plus optional `graceSeconds`, `cooldownSeconds`, `maxPerHour`, `timeoutSeconds`, `deferWhileDebugging` (debug session types), `deferWhileRunningCommands` and `requireKnownIdle`. There is no kill action.
- `adapter: "powershellEditorServices"` identifies the Editor Services process by code (launch arguments, log and session paths) instead of `match`; any `match` is then ignored with a warning, and its restart command is always `PowerShell.RestartSession`.

**Built-in configs** (in the extension's `configs/` folder):

| Name | Target | Action |
| --- | --- | --- |
| `pwsh-editor-services` | Verified PowerShell Editor Services session (adapter) | Automatic restart through `PowerShell.RestartSession` |
| `pwsh-terminals` | `pwsh` terminal shells | Alerts |
| `pwsh-children` | Nested `pwsh` processes | Alerts |
| `tsserver` | TypeScript server (`tsserver.js`, child of the extension host) | Alerts; `typescript.restartTsServer` declared but notify-only (usually two processes) |
| `csharp` | C# Roslyn language server (`Microsoft.CodeAnalysis.LanguageServer`) | Alerts; `dotnet.restartServer` declared but notify-only |
| `eslint` | ESLint server (`eslintServer.js` of dbaeumer.vscode-eslint) | Automatic restart through `eslint.restart` |
| `tsgo` | TypeScript native preview language server (`tsgo --lsp`) | Automatic restart through `typescript.native-preview.restart` |
| `node-tools` | `node`, `bun`, `deno` started from a terminal or an extension (builds, tests, dev servers) | Alerts |
| `python` | Pylance language server (`server.bundle.js` of ms-python.vscode-pylance) | Automatic restart through `python.analysis.restartLanguageServer` |
| `python-tools` | `python`, `python3.x`, `pythonw`, `py` (tests, kernels, scripts) | Alerts |
| `rust-analyzer` | `rust-analyzer` | Automatic restart through `rust-analyzer.restartServer` (manual when a rustup proxy makes two processes) |
| `rust-builds` | `cargo`, `rustc` | Alerts |
| `all-terminals` | Every terminal shell, whatever the shell | Alerts |

Built-in automatic restart commands were checked against `contributes.commands` in the owning extension's `package.json` (version noted in each config's `description`). A built-in config with a restart command but several processes per window (`tsserver`) stays notify-only. Automatic restarts also need exactly one matching process in the window.

**Where configs are loaded from**, in order: the built-ins, then `~/.frenchexdev/memory-watchdog/` (created on demand), then each folder of `frenchexdev.memoryWatchdog.configPaths`. When two files share a name the last one wins; the Output log and the dashboard show which file overrides which. `configPaths` accepts only absolute paths after expanding `~`, `${userHome}` and `${env:NAME}`; relative paths and `${workspaceFolder}` are rejected. `~/...` works on every OS.

An invalid file (JSON, schema, size above 64 KiB) is excluded on its own; the others keep working. Errors appear in Output → Memory Watchdog, in the status bar hover and in the `configs` section of the dashboard and JSON diagnostics. Files are reloaded about half a second after a change; **Memory Watchdog: Reload Configs** forces it. Only the configs whose content changed lose their evidence.

Commands: **Copy a Built-in Config to My Folder…** (to start an override), **Open Configs Folder**, **Reload Configs**.

## Profiles and workload

A profile is a list of config names. A process belongs to the **first** config of the active profile that matches it, so specific configs come before catch-all ones such as `all-terminals`.

**Built-in profiles** (a user profile with the same name replaces the built-in one):

| Profile | Configs, in matching order | Automatic restarts |
| --- | --- | --- |
| `default` | `pwsh-editor-services`, `pwsh-terminals`, `pwsh-children` | Editor Services |
| `powershell-full` | `default` + `all-terminals` (alerts for every other shell) | Editor Services |
| `minimal` | `pwsh-editor-services` only | Editor Services |
| `dotnet` | `csharp`, `pwsh-editor-services`, `pwsh-terminals` | Editor Services |
| `web` | `tsserver`, `tsgo`, `eslint`, `node-tools`, `all-terminals` | ESLint server, tsgo |
| `python` | `python`, `python-tools`, `all-terminals` | Pylance |
| `rust` | `rust-analyzer`, `rust-builds`, `all-terminals` | rust-analyzer |
<!-- built-in-profiles -->

```json
{
  "frenchexdev.memoryWatchdog.profiles": {
    "my-web": ["pwsh-editor-services", "pwsh-terminals", "tsserver", "node-build"],
    "my-dotnet": ["pwsh-editor-services", "csharp", "all-terminals"]
  },
  "frenchexdev.memoryWatchdog.activeProfile": "my-web"
}
```

Select the active profile with **Memory Watchdog: Select Active Profile…**. An unknown config name in a profile is skipped with a warning. An unknown active profile falls back to `default` **with every automatic restart disabled** until it is fixed.

The **workload** (`frenchexdev.memoryWatchdog.workload`, **Memory Watchdog: Select Workload…** or the dashboard) multiplies the thresholds of every config with `scaleWithWorkload` (the default): `development` ×1, `tests` ×1.5, `build` ×2. Set `scaleWithWorkload: false` for absolute thresholds. Watchdog never switches the workload automatically.

Global settings (user settings only, machine scope): `enabled`, `mode` (`notifyOnly` is a kill switch for every automatic restart), `sampleIntervalSeconds`, `collectTimeoutSeconds`, `workload`, `historyRetentionDays`, `historyMaxMiB`, `reportRetentionDays`, `reportMaxMiB`, `configPaths`, `profiles`, `activeProfile`.

## Security

- Configs may always **notify**. An **automatic** restart command from a config that is not built-in requires an explicit approval (**Memory Watchdog: Approve a Config Restart Command…**), stored per file path and SHA-256 content hash. Any edit to the file requires a new approval; until then the config is notify-only.
- In Restricted Mode (untrusted workspace), configs located inside a workspace folder never run a restart command automatically, even when approved.
- A generic (non-adapter) automatic restart is allowed only when exactly one process of this window matches the config; otherwise the restart stays manual and each process gets alerts.
- Restart commands are VS Code command IDs only: no shell execution and no kill action. Command-line patterns run with a timeout and command lines never leave the collector.
- Settings are read from user (machine) scope only; workspace values are ignored.

## Migration from 0.5.x

On the first start of 0.6, if any `frenchexdev.powershellWatchdog.*` setting is set, a notification offers **Migrate**, **Not now** or **Don't ask again** (also available as **Memory Watchdog: Migrate 0.5.x Settings to Config Files**). Migration:

- writes `pwsh-editor-services`, `pwsh-terminals` and `pwsh-children` overrides into `~/.frenchexdev/memory-watchdog/` with your thresholds, per-kind `processThresholds` (as absolute values with `scaleWithWorkload: false`), countdown, cooldown, quota, timeout, debugging and activity options. Existing files are never overwritten. The written files are approved automatically;
- copies `enabled`, `mode`, `sampleIntervalSeconds`, `collectTimeoutSeconds`, history and report limits to `frenchexdev.memoryWatchdog.*`, and `profile` to `workload`.

Until you migrate, the old `enabled`, `mode`, interval, timeout, retention and `profile` values are still honored; old thresholds are not (the built-in configs apply). The old settings remain declared but deprecated. Old command IDs (`powershellWatchdog.*`) remain callable; the new IDs are `memoryWatchdog.*`.
## Live dashboard

Open the **Memory Watchdog** activity-bar view or run **Memory Watchdog: Open Live Dashboard** for a larger editor tab. Both receive the same live measurements.

- At the top, **Live monitoring → Refresh interval** configures live collection: **0 (off), 2 s or 5 s**, shared between this window's dashboard views. The current cadence appears below the selector. On Windows each collection launches one short PowerShell process (CIM query); on Linux it reads `/proc`; on macOS it runs `ps` twice. The minimum live delay is two seconds. The delay starts after collection completes; live collection pauses while every dashboard is hidden. Off preserves the normal Watchdog schedule. The selection lasts for the current extension session.
- Private and resident memory curves with process selection, creation-time identities and explicit collection gaps. Blue curves show private memory; purple dashed curves show resident memory. The vertical axis has Gio (GiB) graduations and horizontal grid lines, with readable labels that adapt to the sidebar width.
- **Development, Tests and Build thresholds appear together** on the diagram, using the thresholds of the config that matched the selected process (configs with `scaleWithWorkload: false` show the same values for every workload). The active profile is marked in the legend; dotted lines show warning thresholds and long-dashed lines show high thresholds. Toggle **Show all workload profiles** to hide these comparison lines.
- Processes grouped by terminal/root, sorted by private memory, CPU, PID or process tree; filter by Editor Services, terminal or child. The **Target** column shows the config that matched each process.
- Private memory, resident memory, CPU, threads, handles, growth and observed activity. **Open** focuses the process's current terminal when it is still available.
- Workload, scheduled restart actions, collection health and recent persisted events.

CPU is derived from cumulative processor time between valid observations: **100% means one logical core**, so multithreaded processes can exceed 100%. The first observation and collection gaps have unknown CPU. Optional metric failures leave those values unknown without discarding a valid memory sample. The tree contains the processes matched by the active profile; other parents appear only as parent/root PIDs. A **Configs** section lists every loaded config, its source, whether it is active, automatic, notify-only (and why) or waiting for approval, and every config error.

Growth alerts default to **+500 MiB over five minutes**. They require at least three observations, a complete time window and at least 75% nondecreasing steps. Alerts are emitted once per sustained episode, independently of restart thresholds. A growth alert **does not establish a memory leak**. Process exit, PID reuse, invalid collection, policy change or a collection gap resets trend evidence; at most 1,024 observations are kept per process.

## Restart policy

The global `mode` defaults to `automatic`, but a restart only ever happens for a target whose config has `action.mode: "automatic"` and a restart command (built-in: only `pwsh-editor-services`). Every other target receives alerts only. Watchdog never forcibly terminates a process or closes a terminal: there is no kill action, and a restart always goes through the VS Code command of the target.

**Restarting Editor Services discards its variables, modules and session state, and may interrupt a command.** PowerShell debugging defers automatic restart requests; an inactive debugger does not mean the console is idle. Set the global `mode` to `notifyOnly` (kill switch) for alerts on every process. The debug session types that defer a target are listed in its config (`action.deferWhileDebugging`).

Once high memory is confirmed, `restartGraceSeconds` starts a countdown (default 30; zero disables it). The notification and dashboard offer **Cancel this episode**, **Postpone 5 minutes** and **Restart now**. Cancel blocks further automatic requests for that process until a measured value drops below its high threshold; postponement keeps collecting. Cancellation survives profile changes and reloads; postponement survives reloads. Resume explicitly clears them while preserving quotas. Restart now shortens the countdown and still requires fresh identity, memory, activity and policy checks. The separate manual restart command retains its confirmation dialog.

`deferWhileRunningCommands` defaults to true. Watchdog observes VS Code terminal shell-execution start/end events without reading command text or output. A known busy Editor Services terminal defers automatic restart and invalidates existing evidence. **Unknown activity never means idle.** Editor Services may not provide shell integration events; `requireKnownIdle: true` makes that unknown state block automatic restart as well. Ordinary terminal activity is displayed but does not grant restart authority or imply the editor is busy. Activity changes are checked again immediately before command dispatch, including while a quota save is pending.

Configure `frenchexdev.memoryWatchdog.*` in **user settings**. Workspace and folder overrides are ignored. Invalid policies disable automatic decisions and explain why.

The collection interval begins after each collection completes. Continuity checks allow the collector deadline plus scheduling tolerance; a collection failure or a longer gap resets consecutive samples. A pending quota save does not prevent disabling, suspending or deferring a restart before its command is sent.

Failed or timed-out restart requests, persistent high memory after stabilization, and exhausted quotas suspend automatic actions. **Enable** and **Resume** both enable monitoring, clear persisted suspension and acknowledge the previous improvement check, then immediately request fresh measurements. Cooldown, rolling-hour quota and pending-command protections remain active; an exhausted quota can suspend automatic restarts again. Disabling Watchdog survives a window reload.

## Diagnostics

From the command palette:

- **Output → Memory Watchdog** retains local action and collection errors with their original details. No logs are uploaded.
- **Memory Watchdog: Show Diagnostics** opens JSON with the policy, process inventory, decisions, errors and environment versions.
- **Memory Watchdog: Open Live Dashboard** opens the live process/history/health view.
- **Memory Watchdog: Open Visual Diagnostics (HTML)** saves an offline report and displays it in a VS Code editor tab. It includes memory curves, process selection, observed peaks and recorded events. Running the command again refreshes the same tab.
- **Memory Watchdog: Restart Editor Services Session…** requests a manual editor-session restart.

HTML reports are dated snapshots retained in the extension's storage. Generate a new report to refresh it. Exporting does not trigger collection or restart. Gaps remain visible and recorded peaks are not lifetime maxima.

History now lives under the workspace extension storage's `history` directory, with a separate writer identity per activation. Reloading restores the latest 200 events for the live view; HTML exports read the retained disk history. History is **workspace-scoped across sessions**, including other windows of that same workspace, while the current inventory remains window-scoped. Empty windows use extension global storage. Historic log-session files from versions before 0.4 are not migrated. No historic consecutive-sample or CPU series can authorize a restart.

`historyRetentionDays` / `historyMaxMiB` default to **14 days / 15 MiB**. Owned history segments are pruned during writes and retained-history reads. Entries outside the age limit are excluded even if their segment is newer. The oldest segments are removed first, so the retained duration may be shorter than the age limit. `reportRetentionDays` / `reportMaxMiB` default to **14 days / 20 MiB**; owned HTML exports are pruned before a new export. A single oversized export is rejected with an action error. Unrelated files and directories are preserved. Simultaneous windows can temporarily exceed a shared storage budget until the next pruning operation; cross-process transactional storage is not provided.

The health view and JSON include collection start/end, duration, next scheduled collection, consecutive collection errors, stale measurements, incomplete inventories, editor association, activity source, storage errors and known automatic-restart blockers. A missing blocker is not permission to restart: threshold, continuity, quota and final checks still apply.

Suspend, resume and configuration changes are recorded even without a new memory collection. Repeated paused cycles do not add duplicate state events.

Only processes with a verifiable ownership chain to the current window and the extension host's actual VS Code application instance are included. Matching the executable path alone is insufficient: separate instances of the same executable and nested editor instances are excluded. Terminal roots must belong to that same instance. Missing host identity, cyclic ancestry or reused parent PIDs cannot authorize selection or restart. Detached processes may be excluded. Collection errors never become zero memory, and full command lines are neither returned nor logged.

## Development and details

Development requires Node 22.13+ (ESLint requirement); the extension runtime still supports Node 22+. Install tools with `npm ci --ignore-scripts`, run `npm run lint` and `node --test test/*.test.js` (per-OS parsing is covered by fixtures, so the suite runs on Windows, Linux and macOS), and package with `node node_modules/@vscode/vsce/vsce package --no-dependencies --out dist/`. Agents must follow the repository's QuietCli instructions.

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
- [License (MIT)](LICENSE) and [credits and trademark notices](CREDITS.md).

The production observer uses the in-process collector `src/platform.js` (Windows CIM, Linux `/proc`, macOS `ps`) with ownership selection in `src/selection.js`; the PowerShell collector scripts of 0.5.x were removed. The controller’s legacy injected `resolve`/`collect` adapter exists only for isolated regression fixtures. The old `Measure-Session.ps1` and `src/journal.js` remain historical test/reference sources and are excluded from the VSIX. `collector.js` now provides only the shared deadline helper.

The development-only `minimatch` overrides for `@vscode/vsce`, `eslint` and `@eslint/config-array` select 11.0.1 to address GHSA-g3hv-75wg-m249 until these tools update their declared ranges. Packaging and file-list checks must pass when changing this override.
