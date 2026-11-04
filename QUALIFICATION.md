# Qualification — 0.5.2

Date: **4 November 2026**. Process selection now requires the extension host's actual VS Code application ancestry in addition to this window's terminal roots. Separate instances of the same executable, nested editor instances, missing host identity, reused parent PIDs and cyclic editor ancestry are rejected. A terminal removed during collection cannot authorize an Editor Services restart. Stable and Insiders retain restart support for their own verified sessions.

**116 automated tests pass on the Windows host, zero failures, cancelled or skipped tests.** The native PowerShell fixture covers 17 prepared ownership cases, including a mixed Stable/Insiders graph and distinct Insiders instances. Observer regressions cover explicit host identity, retained Stable/Insiders support and terminal removal during collection. These are source-level tests with prepared graphs and controlled VS Code dependencies; installed Desktop collection and real Editor Services restarts have not been requalified for this version.

Evidence: `.sandbox/insiders-ownership-unit.log`, `.sandbox/insiders-ownership-unit.json`, `.sandbox/insiders-ownership-state.json` and `.sandbox/insiders-ownership-summary.txt` retain the final local run. The read-only visible monitor `.sandbox/Monitor-InsidersOwnership.ps1` closes automatically after the runner saves its final result. QuietCli RECORD: `f54d14321af6`. Earlier installed-VSIX and browser results below describe their recorded builds.

---

# Historical qualification — 0.5.1

Date: **2 November 2026**. Enable and Resume now clear persisted suspension and request fresh measurement. Explicit resume acknowledges the previous post-restart improvement failure, while retaining cooldown, rolling-hour quota and pending-command protections.

**114 automated tests pass on the Windows host, zero failures or skipped tests.** Seven local VSIX delivery regressions cover successful installation with Unicode/profile arguments, packaging/installation failures, missing or mismatched packages, unconfirmed installation and preview behavior. Four command-registration regressions exercise both actions with monitoring already enabled or disabled, including delayed configuration events, persisted restart failure and timed suspension. Two policy regressions cover fresh-sample authorization after acknowledgement and preservation of cooldown/quota. Five regressions failed before the runtime fix; the quota/cooldown preservation case already passed. VS Code command registrations use an isolated API fixture with the real controller and policy; this does not requalify real Editor Services restart behavior.

Evidence: `%TEMP%/watchdog-release-0.5.1-82b43103` contains `Unit.log`, `Unit.result.json`, `Dashboard.log`, `Dashboard.result.json`, `state.json` and `summary.txt`. Reopen the saved monitor using `pwsh -NoProfile -File "$env:TEMP/watchdog-release-0.5.1-82b43103/Watch.ps1" -RunRoot "$env:TEMP/watchdog-release-0.5.1-82b43103"`; it exits automatically for completed runs. The dashboard browser validation also passes: readable Gio graduations, shared memory/profile scale, zero/fractional/large values, and 340px sidebar resizing; screenshots and check details are recorded in `verification/dashboard-browser.json`. Historical before-fix evidence remains in `%TEMP%/watchdog-resume-red-c39dbf22`. The first GitHub run (41533073322) exposed a fixture-only short/long Windows temporary-path mismatch (`RUNNER~1` versus `runneradmin`); the fixture now resolves its temporary directory with `fs.realpath` before asserting exact CLI arguments. The post-correction local validation is retained in the same release directory under `canonical-path-check/`.

---

# Historical qualification — 0.5.0

Date: **2 November 2026**. Source validation for configurable live dashboard collection and simultaneous Development/Tests/Build threshold comparisons.

**101 automated tests pass on the Windows host, zero failures or skipped tests.** The four dashboard cases additionally cover all supported delays, shared views, waiting for collection completion, visibility/disposal cleanup, collection errors and absolute profile thresholds.

**Four browser scenario groups pass in an owned headless Edge profile.** The existing dashboard harness verifies all six live interval choices, shared interval display, profile threshold lines and legend, visibility toggle, desktop/340px layout, existing dashboard actions, explicit gaps, hostile-text escaping and offline report thresholds. No page network request, JavaScript exception or CSP error was observed. `verification/dashboard-browser.json` identifies the generated screenshots and synthetic fixture; this run does not requalify an installed VSIX or actual Editor Services restarts.

Evidence: `%TEMP%/watchdog-release-0.5.0-final` (`Unit.log`, `Unit.result.json`, `Browser.log`, `Browser.result.json`, `state.json`, `summary.txt`). Reopen the saved monitor with `pwsh -File "$env:TEMP/watchdog-release-0.5.0-final/Watch.ps1" -RunRoot "$env:TEMP/watchdog-release-0.5.0-final"`; it exits automatically for completed runs.

---

# Qualification — 0.4.0

Date: **2 November 2026**. Source qualification for the live dashboard, restart countdown, growth alerts, process metrics, workload profiles, persistent history, health diagnostics and activity protection.

**97 automated tests pass on the Windows host, zero failures or skipped tests.** Coverage includes the preceding audit fixes and new countdown expiry/cancellation, postponement, restart-now rechecks, PID changes, debugger/activity invalidation, cancellation during final measurement and quota persistence, strict idle mode, collection failure/recovery, independent effective thresholds, overlapping shell executions, sustained growth and bounded trend-window coverage, history reload/retention/budgets, report cleanup, terminal navigation and webview message allowlisting. Restart scenarios use controlled dependencies. The existing ownership selector also runs through PowerShell Core 7.6.9.

Evidence: `%TEMP%/watchdog-release-20261102-19518856` (`tests.tap`, `tests.result.json`). Reopen the retained visible monitor with `pwsh -NoExit -File <that directory>/Watch-Features.ps1 -RunRoot <that directory>`.

**Five source-integration scenarios pass in one isolated VS Code Stable 1.144.0 window on the Windows host.** Real pwsh collection measures private/resident memory, parent PID, CPU deltas, threads, handles and terminal association. The actual editor dashboard opens/reuses its tab, the activity-bar view resolves, profile changes affect fresh process thresholds, persistent history feeds HTML/JSON diagnostics, and shell execution events report busy then idle. Automatic injection was unavailable for the API-created test terminal: the test initializes VS Code's own shell-integration script in that owned shell only. No user profile or host execution policy is changed. No Microsoft PowerShell extension or automatic Editor Services restart is exercised by this new scenario. `verification/features-native.json` records the checks and isolated storage directory; `%TEMP%/watchdog-native-20261102-2d51b31f` retains runner output and the visible `Watch-NativeFeatures.ps1` monitor. This is a development-extension run, not an installed-VSIX requalification or an Insiders run.

**Four browser scenario groups pass in an owned headless Edge profile.** Real DOM checks cover terminal groups, process tree/filter/navigation, private/resident curves with explicit gaps, every restart/report action, per-process report thresholds across missing measurements, workspace history scope, hostile-text escaping, empty current inventory, retained history and collection health. Desktop and 340px sidebar screenshots were inspected. No page network request, JavaScript exception or CSP error was observed. `verification/dashboard-browser.json` identifies the temporary HTML and screenshots. Fixture values are synthetic. The browser harness supplies the VS Code messaging API; actual VS Code view registration is covered separately by the source-integration scenarios.

History defaults to 14 days / 15 MiB in workspace extension storage, with up to 200 live events and 20 retained processes per collection plus the separate Editor Services sample. Trend windows retain at most 1,024 observations, thinning interior points when necessary. HTML exports default to 14 days / 20 MiB, pruned on export. Concurrent writers from windows of the same workspace can temporarily exceed the shared budget until the next prune; storage has no cross-process transaction lock. Old log-session journals are not migrated. Command activity remains unknown without observed shell events; `requireKnownIdle` can block automatic restart in that case. Real leak diagnosis, long-duration stability, unavailable supplementary metrics under real ACL restrictions and automatic restart against a genuinely unresponsive Editor Services process remain unqualified.

Earlier installed-VSIX and report-browser results below refer to their recorded builds. Version 0.4.0 is packaged locally after the source checks; the normal user extension installation is not changed.

---

# Historical qualification — 0.3.0

Date: **29 October 2026**. The visual diagnostic adds an offline HTML export; collection, process ownership and restart authority keep their existing scope.

## Audit fixes — 2 November 2026

**79 automated tests pass on the Windows host, zero failures or skipped tests.** Twelve new regression cases cover cancellation during quota persistence (disable, notify-only, suspend, debugger start and disposal), reservation rollback, synchronous command failure, slow valid collection cadence and its long-gap boundary, retained policy events, initially disabled monitoring and event-write failure. Restart scenarios use controlled dependencies; the existing process-selector fixture also runs through native PowerShell Core.

These source fixes have not been packaged or exercised in installed Desktop integration. Earlier installed-VSIX results below describe their recorded builds. Local test evidence is retained under `%TEMP%/watchdog-fix-20261102-31cd8d39` (`tests.tap`, `tests.result.json`); QuietCli RECORD: `035ffaa4120e`.

## VS Code tab update — 1 November 2026

Visual diagnostics now displays the exported HTML in one reusable VS Code editor webview. Repeating the command refreshes that tab; closing it permits a new tab on the next invocation. The saved HTML and its nonce-based content security policy are preserved. Scripts remain enabled for chart interactions; forms, command URIs and local resource loading are disabled.

**67 unit tests pass, zero failures.** The export tests verify that the displayed HTML exactly matches the fully written file and that a failed tab opening preserves the export. Four additional cases cover webview capabilities, refreshing the existing tab, reopening after closure and extension disposal.

**Six checks pass in VS Code Insiders 1.145.0-insider**, using the development extension in an isolated local profile with monitoring disabled: activation, a complete standalone export, an active editor webview, tab reuse with a distinct export, closing/reopening the tab and the existing JSON diagnostic command. `verification/report-webview.json` records these checks, unit-test counters and the three changed runtime-file hashes. This checks the actual editor tab; it does not requalify the installed VSIX, Stable or chart rendering inside the webview.

The installed-VSIX and browser evidence below describes the original 29 October build, which opened reports externally. Those archives have not been rebuilt or requalified for this source change.

## Original automated checks — 29 October 2026

**63 unit tests pass, zero failures.** The existing policy, ownership, controller and journal tests remain covered. Added cases exercise serialized journal reads during rotation, missing and unreadable journal paths, malformed JSON, byte caps, disk/memory deduplication, legacy Editor Services-only records, PID reuse, partial inventories, invalid measurements, text escaping, recorded events, graph discontinuities, peak-preserving display reduction, unique report files, workspace/global storage and external-open failure.

## Browser qualification

`test/run-report-browser.js` uses a separate owned headless Edge profile, existing browser **156.0.4314.50**, and three prepared journal files containing **15,728,179 bytes / 13,686 entries**. The exported HTML retains every normalized valid entry. The fixture includes reused PIDs, missing measurements, changing thresholds, partial inventory and text containing HTML/script delimiters.

Actual browser checks pass for offline rendering, process selection, threshold visibility, pointer values, event pagination, empty history and desktop/narrow layout. No remote request, JavaScript exception or CSP error is observed. Screenshots are inspected at **1440 × 1100** and **720 × 1100**. `verification/report-browser.json` identifies the fixture HTML and screenshots under `.sandbox/report-*`. Fixture values are synthetic and are not measurements of this workstation.

## Installed-VSIX qualification

Both **VS Code Stable 1.144.0** and **Insiders 1.145.0-insider** pass in two independent sandbox windows with separate profiles and workspaces, using **PowerShell Core 7.6.9** and **ms-vscode.powershell 2026.1.2**.

The actual installed **0.3.0 VSIX** activates, measures ordinary/nested pwsh, excludes peer-window processes and preserves the earlier debugger deferral, measured Editor Services replacement, notify-only policy, machine settings and persisted disable/quota scenarios. The new palette command generates a local standalone HTML file from the window's on-disk journal and current process inventory and requests external opening. Its embedded data contains the expected ordinary process and excludes the peer window's identities. The existing JSON command still opens its diagnostic document.

Reports: `verification/integration-stable.json` and `verification/integration-insiders.json`. They retain tested archive SHA-256, all **15 installed runtime-file hashes**, initial-run evidence and the generated HTML paths. The runner normalizes its configured PowerShell executable to the native Windows path, waits for a fresh inventory after configuration changes, and refuses persistence tests when the first run failed.

Final documentation-only repackaging can change the archive hash; `verification/results.json` records the delivered artifact and checks every runtime file against both independently tested installations. The distributable checksum is next to the VSIX in `dist/`.

## Bounds and remaining limits

- Export reads only this window's current three rotated journal files, **at most 15 MiB**, and merges them with the 200-entry memory history. It does not discover earlier editor log sessions.
- Historical inventories retain at most 20 processes; separate Editor Services samples may provide additional observations. Partial history is explicit; absent measurements remain gaps and observed peaks do not establish lifetime maxima. Older records use inferred cadence for long-gap detection.
- A report is a dated snapshot. The current source opens it in a VS Code editor webview; failure retains the file and offers its location. The original standalone Chromium/Edge rendering checks predate the webview change; chart interactions inside the webview and other browser engines are not separately exercised.
- Export creates no new runtime dependency, network request, memory collection, restart request or policy change. Saved reports are not automatically deleted.
- Long-duration stability, real access-denied ACL behavior, genuinely unresponsive Editor Services, shared-profile multi-window isolation and stabilized attributable memory overhead remain unqualified. Remote/non-Windows execution remains outside the product scope.

---

# Historical qualification — 0.2.0

Date: **29 October 2026**. Results distinguish simulated policy tests, installed-VSIX integration and measurements still outstanding.

## Environment

| Component | Observed version |
| --- | --- |
| Windows | Windows 11 Pro, 10.0.26300, build 26300, x64 |
| PowerShell Core | 7.6.9 |
| Microsoft PowerShell extension | ms-vscode.powershell 2026.1.2 |
| VS Code Stable | 1.144.0, separate downloaded archive |
| VS Code Insiders | 1.145.0-insider, separate downloaded archive |
| Development Node | 26.8.1 |
| VSIX packager | @vscode/vsce 4.1.0 |

The user's installed Insiders was updating and refused Desktop startup. Qualification uses dedicated archive copies and separate user-data/extension directories. The normal user profile and Microsoft extension files are not modified.

## Independent automated tests

**47 tests passed, zero failures.** Run `node --test --test-reporter=tap test/*.test.js` from the project directory. Tests cover the earlier editor restart protections plus independent per-process policies, aggregate-vs-individual thresholds, process exit/PID reuse, ordinary-terminal discovery without Microsoft activation, nested ownership, a non-PowerShell parent shell, peer-window exclusion, another editor boundary, cyclic/reused ancestry, explicit partial ownership, unresolved terminal IDs and human-readable status labels. A prepared PowerShell process graph tests the same selector used by the real Windows collector.

The journal test writes 350 entries, retains exactly the latest 200 in memory, and verifies at most three files within a smaller equivalent 256-byte rotation budget. Production defaults are three files of 5 MiB each.

## Installed-VSIX integration

The sandbox installs the actual `dist/powershell-watchdog-0.2.0.vsix`; only a separate test driver is loaded from source. Every channel uses two independent local Desktop processes, with distinct profiles and workspaces. Each has an ordinary pwsh terminal, a temporary nested pwsh and an Editor Services process. This checks two isolated editor windows; a pair of windows sharing one user-data directory is covered by a shared-parent process-graph fixture rather than a separate real editor run.

Both channels passed ordinary pwsh discovery before explicitly activating Microsoft PowerShell, nested-process ownership, removal after child exit, per-window process inventories, real memory collection and high-memory ordinary-process alerts without editor restart or terminal closure. Existing notify-only behavior, real PowerShell debugger deferral, automatic replacement of A's editor session, preservation of B's session, machine-only settings, disable/enable and diagnostics also passed. **Both passed disable and quota persistence in fresh Desktop processes.** Results are recorded in `verification/integration-stable.json` and `verification/integration-insiders.json`.

Pressure is bounded to **192 MiB per Editor Services session and 192 MiB per ordinary console**. Warning and restart thresholds are set 64 MiB and 96 MiB above the initial editor private-memory sample. Sampling is one second, with three consecutive high samples and a maximum of one automatic editor restart. This exercises actual threshold crossings without exhausting host RAM. An automatic command return is accepted only after a distinct process identity is independently associated and measured. The successful request enters stabilization. Each ordinary process has independent counters and remains alert-only, including when the editor mode is automatic.

The driver then disables monitoring and closes each owned window normally. It reopens the same user-data directory and workspace and checks disabled monitoring and the retained automatic request count (A: one, B: zero).

Persistence uses an ordinary development driver **without `--extensionTestsPath`**. VS Code's extension-test mode deliberately uses in-memory mementos, which cannot establish disk persistence across editor processes. This was verified against the [VS Code storage implementation](https://github.com/microsoft/vscode/blob/main/src/vs/platform/storage/electron-main/storageMainService.ts). The product continues to use the documented `ExtensionContext.workspaceState` API.

Reports include the tested VSIX SHA-256 and hashes of all installed runtime files. Repackaging documentation may change the archive hash; final runtime hashes must still match the independently tested installed copies. `verification/results.json` records final parity and aggregate results.

## Acceptance evidence

| Requirement | Evidence and limits |
| --- | --- |
| AC-01 | Real current-window PID, process creation time, private and resident bytes on both channels. |
| AC-02 | Each window measures its own editor, ordinary console and nested pwsh; peer editor and ordinary-console PIDs are absent from the other inventory. A's restart leaves B unchanged. A shared-parent selector fixture tests window separation; shared-profile real windows are not separately qualified. |
| AC-03 | Independent duplicate-terminal and substituted-artifact tests refuse association. |
| AC-04 | Warning episode unit tests; real threshold state and diagnostic history. |
| AC-05 | Independent spike and counter reset test. |
| AC-06 | Real three-sample automatic editor request on both channels; ordinary high-memory processes only produce alerts. Persistence cannot be accelerated by explicit samples or by summing different process memories. |
| AC-07 | Injected collection failure clears the current value and series, retains a separately labeled last valid sample. Actual Windows access-denied ACL behavior is not separately qualified. |
| AC-08 | Real PowerShell debugging defers automatic action, followed by fresh samples after debugger termination. |
| AC-09 | Real process replacement plus independent same-PID/new-creation-time test. |
| AC-10 | Independent rejected, missing, unchanged-identity and never-returning command tests. No success without a measured replacement. |
| AC-11 | Rolling quota/expiry/persisted-state unit tests and cross-process workspace quota checks. |
| AC-12 | Separate external collection remains active during real PowerShell debugging. A never-returning restart command is simulated and bounded, retaining the pending-command lock. A genuinely unresponsive Editor Services process is not separately reproduced. |
| AC-13 | Real notify-only and disable/enable; persisted disable checked in a fresh Desktop process. |
| AC-14 | Explicit environment guard and unsupported-resolver tests. No real SSH, WSL, container or browser session is qualified. |
| AC-15 | One batch collector per controller iteration, non-overlap unit test, 256-process/255-terminal-root caps with explicit partial results, 200 historical collections and the 20 largest processes per record, rotated-file tests, real short integration sessions. Long-duration stability and attributable memory overhead remain unqualified. |
| AC-16 | Installed VSIX on Stable 1.144.0 and Insiders 1.145.0-insider, activation, user settings, status, diagnostics and verified restart. |

## Remaining limits

- **Ordinary pwsh monitoring works without Microsoft PowerShell activation.** Only automatic Editor Services restart association is restricted to Microsoft release **2026.1.2**; other versions remain measurable with alerts.
- The proposed stabilized **<50 MiB attributable memory overhead** has not been established. A recorded 10,000-snapshot heap probe is short, noisy and runs in a shared host; it is not an overhead benchmark.
- Interactive command activity is unknown. An Editor Services restart may interrupt an editor command even when no debugger is active. Ordinary terminals and nested pwsh are never automatically restarted or terminated.
- Ownership must remain verifiable from current-window terminal or extension-host roots. Detached/orphaned processes with a missing parent chain cannot be safely associated. Unverified owned roots are reported as partial collection, not zero memory.
- Real access-denied behavior, long-duration idle runs, a truly unresponsive Editor Services target and shared-profile multi-window behavior require additional scenarios.
- No global process kill, automatic forced target termination, profile edit, administrative elevation, external publication or real machine-RAM saturation is performed by the product.
