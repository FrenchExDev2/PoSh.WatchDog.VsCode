# Changelog

## 0.5.5 — 2026-11-05

- Correct the repository URL and align the installation example with the packaged version.
- Keep Editor Services restart fail-closed using an immutable qualified-version allowlist. Explain detected and qualified versions, retained monitoring and the qualification requirement; retain the association error detail in JSON diagnostics.
- Restrict live dashboard collection to off, two seconds or five seconds, including validation of webview messages. Each delay starts after completion and hidden dashboards remain paused.
- Remove the unused JavaScript single-session collector. Mark the controller's injected legacy adapter as test-only; exclude the historical session script and journal from the VSIX.
- Add a local PowerShell Watchdog output log for command, observation and notification failures, retaining error details. Correct the suspension range message and parenthesize mixed boolean expressions.
- Add maintained ESLint tooling and a CI lint step. Update development-only Azure dependencies and override the affected vsce and ESLint minimatch dependencies to 11.0.1 to resolve the audited advisories without downgrading OIDC publishing support. Development lint requires Node 22.13+; runtime requirements are unchanged.
- Validate 123 unit tests, 17 process-selection assertions and both offline Edge browser harnesses on Windows. Lint passes. No installed-extension or real restart qualification is claimed.

## 0.5.4 — 2026-11-04

- Require a matching changelog update before every agent-created Git commit, using a concrete release version instead of an Unreleased heading.
- Document the changelog and version-alignment checks in the release procedure.
- Retain the experimental upstream VS Code hover-patch browser harness in source control. It requires external upstream source fixtures and an existing TypeScript compiler; it is separate from the standard unit suite and does not modify the installed editor.
- Exclude `patches/**` from the VSIX package.

## 0.5.3 — 2026-11-04

- Display status-bar and hover memory values in automatically selected binary units (B, KiB, MiB, GiB, TiB or PiB), instead of always using GiB. Keep at most two decimal places and omit trailing zeros: `512 KiB`, `512.54 KiB`, `96 MiB`, `1.5 GiB`.
- Add regression coverage for binary unit boundaries, fractional values, and independently formatted aggregate, private and resident memory. The current Windows source suite passes all 121 tests.
- Rename the local project to FrenchExDev.PoSh.WatchDog.VsCode.
- Reduce native hover replacements by removing the one-second age timer, displaying an absolute collection timestamp and skipping unchanged tooltip, text and background assignments. Measurement updates and collection errors still propagate immediately.

## 0.5.2

- Restrict automatic and manual Editor Services restart targets to verified pwsh descendants of the hosting VS Code instance and a still-live terminal of its window.
- Verify the extension host's process identity and editor ancestry instead of trusting executable paths alone, excluding separate and nested editor instances even when a terminal PID is supplied as a root.

## 0.5.1

- Add readable Gio graduations and horizontal grid lines to the live memory chart, with a shared scale for measurements and profile thresholds and labels that adapt to sidebar resizing.
- Add a verified local VSIX build/install script with channel and profile selection, SHA-256 output and failure-path regression tests.
- Make Enable and Resume clear persisted suspension, enable monitoring and immediately request a fresh collection, including when the enabled setting was already true.
- Clear the acknowledged post-restart improvement blocker on explicit resume while preserving cooldown, rolling-hour quota and pending-command protections.

## 0.5.0

- Add shared live dashboard collection delays: off, 250 ms, 500 ms, 1 s, 2 s and 5 s, pausing when all dashboards are hidden and waiting for each collection to complete.
- Compare Development/Tests/Build thresholds simultaneously on the selected process memory chart, with a legend, profile visibility toggle and absolute per-kind overrides.
- Place the refresh interval in a dedicated Live monitoring section at the top, show its current state, and identify the dashboard version.

## 0.4.0

- Add a live activity-bar dashboard and reusable editor view with memory curves, terminal groups, process tree, filters, sorting and terminal navigation.
- Add a cancellable automatic-restart countdown, persisted episode cancellation/postponement and restart-now action with final safety checks.
- Add sustained memory-growth alerts and optional CPU, parent PID, thread and handle measurements.
- Add development/tests/build workload profiles and absolute thresholds for Editor Services, terminals and child pwsh processes.
- Persist bounded workspace history across sessions and automatically prune owned history segments and HTML exports by age and total size.
- Explain collection timing, staleness, errors, activity source and automatic-restart blockers in the dashboard and JSON diagnostics.
- Observe shell-execution lifecycle events without capturing command text; defer for known busy editor terminals and optionally require known idle.

- Recheck user choices and debugger activity after saving a restart reservation; cancelled requests release their quota and pending marker before any command is sent.
- Include the collector deadline when checking consecutive samples, so valid slow collections work with short sampling intervals.
- Retain suspend, resume and configuration events in diagnostic history, including periods with no memory collection.
- Display visual diagnostics in a reusable VS Code editor tab, refreshing it on each command and preserving the standalone HTML export.
- Keep interactive charts and the report's restrictive content security policy; retain the saved location if the tab cannot open.

## 0.3.0

- Add **Open Visual Diagnostics (HTML)** to export this window's retained journals and open an offline graphical report externally.
- Show process memory curves, historical thresholds, observed peak rankings, recorded events, current inventory and environment information.
- Preserve PID/creation-time identities, measurement gaps and explicit partial history; merge bounded disk and memory evidence without duplicate collections.
- Keep dated exports in extension storage and expose the saved location if external opening fails. No runtime npm dependency or report network request is required.

## 0.2.0

- Monitor ordinary pwsh terminals and their children per VS Code window, independently of Microsoft PowerShell activation.
- Display process count, total private memory, readable states and explicit partial measurements.
- Evaluate thresholds and warning episodes independently for each process; keep ordinary processes alert-only.
- Preserve verified Editor Services restart, debugger deferral, cooldown and quota protections.
- Qualify nested process ownership, process exit/removal and peer-window exclusion in installed-VSIX scenarios.

## 0.1.0

- Initial Windows Desktop memory watchdog with window-specific session association.
- External bounded collection, configurable restart policy, machine settings and diagnostics.
- Independent policy tests and installed-VSIX sandbox integration harness.
