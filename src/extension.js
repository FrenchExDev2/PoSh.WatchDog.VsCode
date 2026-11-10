'use strict';

const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs/promises');
const { SECTION, LEGACY_SECTION, readMachinePolicy, readGlobals, readLegacyValues, globalPolicy } = require('./configuration');
const { WatchdogError, qualifiedPowerShellVersions } = require('./session');
const { WindowProcessObserver } = require('./observer');
const { describeStatus } = require('./presentation');
const { createLoadingSpinner } = require('./loading-spinner');
const { PersistentJournal } = require('./history');
const { ActivityTracker } = require('./activity');
const { createDashboard } = require('./dashboard');
const { WatchdogController } = require('./controller');
const { exportVisualReport } = require('./diagnostics-report');
const { createReportPanel } = require('./report-panel');
const targets = require('./targets');
const { buildMigration, writeMigration, MIGRATION_KEY } = require('./migration');

const section = SECTION;
const COMMAND_PREFIX = 'memoryWatchdog';
const LEGACY_PREFIX = 'powershellWatchdog';
// 0.5.x command ids stay callable (keybindings, scripts) and map to their 0.6 equivalents.
const LEGACY_COMMANDS = Object.freeze({ enable: 'enable', disable: 'disable', suspend: 'suspend', resume: 'resume', changeMode: 'changeMode', restart: 'restart',
  diagnostics: 'diagnostics', visualDiagnostics: 'visualDiagnostics', menu: 'menu', dashboard: 'dashboard', cancelRestart: 'cancelRestart',
  postponeRestart: 'postponeRestart', restartNow: 'restartNow', selectProfile: 'selectWorkload' });
const RELOAD_DEBOUNCE_MS = 500;

/** 0.5.x single-target policy reader, kept for compatibility with integration clients. */
function readPolicy() {
  return readMachinePolicy(vscode.workspace.getConfiguration(LEGACY_SECTION));
}

function readCurrentGlobals() {
  return readGlobals(vscode.workspace.getConfiguration(section), vscode.workspace.getConfiguration(LEGACY_SECTION));
}

function environmentProblem() {
  if (!['win32', 'linux', 'darwin'].includes(process.platform) || vscode.env.uiKind !== vscode.UIKind.Desktop || vscode.env.remoteName ||
    vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme !== 'file')) {
    return 'Only local Desktop windows on Windows, Linux or macOS are supported.';
  }
  return null;
}

async function activate(context) {
  const output = vscode.window.createOutputChannel('Memory Watchdog', { log: true });
  context.subscriptions.push(output);
  /** Keep action failures in the local VS Code log with their original stack. */
  const logError = (action, error) => output.error(`${action}: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  const log = (level, message) => (output[level] || output.error).call(output, message);
  const reportPanel = createReportPanel(vscode);
  context.subscriptions.push(reportPanel);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.name = 'FrenchExDev Memory Watchdog';
  status.command = `${COMMAND_PREFIX}.menu`;
  status.show();
  const globalState = context.globalState || { get: (_key, fallback) => fallback, update: async () => {} };
  const debugSessions = new Map();
  const trackDebug = (session) => { if (session) debugSessions.set(session.id, String(session.type || '').toLowerCase()); };
  trackDebug(vscode.debug.activeDebugSession);
  /** Without types: the 0.5.x PowerShell check. With types: any active session of one of the config's debug types. */
  const debugging = (types) => {
    const wanted = Array.isArray(types) ? types.map((type) => type.toLowerCase()) : ['powershell'];
    return [...debugSessions.values()].some((type) => wanted.includes(type));
  };
  let controller;
  let dashboard;
  let statusBackground;
  let statusSnapshot;
  const spinner = createLoadingSpinner(() => {
    if (!statusSnapshot) return;
    const { text } = describeStatus(statusSnapshot, spinner.frame);
    if (status.text !== text) status.text = text;
  }, { setInterval, clearInterval });
  context.subscriptions.push(spinner);
  let configState = { status: null, loaded: null, profile: null, directories: [] };
  const activity = new ActivityTracker(vscode.window, (terminal) => controller?.activityChanged(terminal));
  const observer = new WindowProcessObserver(vscode, { activity });
  const update = (snapshot) => {
    statusSnapshot = snapshot;
    spinner.setCollecting(snapshot.health?.collecting === true);
    const display = describeStatus(snapshot, spinner.frame);
    if (status.text !== display.text) status.text = display.text;
    if (status.tooltip !== display.tooltip) status.tooltip = display.tooltip;
    const configProblem = snapshot.configs?.errors > 0 || snapshot.configs?.pendingApprovals > 0;
    const background = ['error', 'suspended', 'ambiguous', 'unsupported'].includes(snapshot.state) ? 'error' :
      ['warning', 'confirmed'].includes(snapshot.state) || configProblem ? 'warning' : null;
    if (statusBackground !== background) {
      statusBackground = background;
      status.backgroundColor = background ? new vscode.ThemeColor(`statusBarItem.${background}Background`) : undefined;
    }
    dashboard?.update();
  };
  const notice = (level, message, slotName) => {
    if (level === 'countdown') {
      const slot = controller.slot(slotName);
      const intent = slot?.restartIntent;
      void vscode.window.showWarningMessage(message, 'Cancel restart', 'Postpone 5 minutes', 'Restart now').then(async (action) => {
        if (!slot || slot.restartIntent !== intent) return;
        if (action === 'Cancel restart') await controller.cancelRestart(slot.name);
        if (action === 'Postpone 5 minutes') await controller.postponeRestart(5, slot.name);
        if (action === 'Restart now') await controller.restartNow(slot.name);
      }).catch((error) => logError('Restart notification', error));
      return;
    }
    void vscode.window.showWarningMessage(message, 'Diagnostics', 'Suspend 15 minutes').then(async (action) => {
      if (action === 'Diagnostics') await vscode.commands.executeCommand(`${COMMAND_PREFIX}.diagnostics`);
      if (action === 'Suspend 15 minutes') await controller.suspend(15);
    }).catch((error) => logError('Warning notification', error));
  };
  const initialGlobals = readCurrentGlobals();
  const initialPolicy = globalPolicy(initialGlobals);
  const journal = new PersistentJournal(path.join(context.storageUri?.fsPath || context.globalStorageUri.fsPath, 'history'), initialPolicy);
  await journal.ready;
  controller = new WatchdogController({
    observe: async (milliseconds, signal) => {
      const problem = environmentProblem();
      if (problem) throw new WatchdogError('unsupported', problem);
      try { return await observer.observe(milliseconds, signal); }
      catch (error) { logError('Process observation', error); throw error; }
    },
    commands: () => vscode.commands.getCommands(true),
    // The command comes from a validated config whose automatic use was built-in or explicitly approved.
    restart: (command = 'PowerShell.RestartSession') => vscode.commands.executeCommand(command),
    debugging,
    activity: (target) => activity.get(target?.terminal),
    journal,
    store: (value) => context.workspaceState.update('watchdog.policyState', value),
    onChange: update, notice,
  }, initialPolicy, context.workspaceState.get('watchdog.policyState', {}));

  const defaultDirectory = () => targets.defaultConfigDirectory();
  const builtinDirectory = path.join(context.extensionPath || path.join(__dirname, '..'), 'configs');
  const notifiedApprovals = new Set();

  /** Load configs, resolve the active profile and apply it; one invalid file never disables the others. */
  async function reloadTargets(reason = 'reload') {
    const globals = readCurrentGlobals();
    const directories = [{ path: defaultDirectory(), optional: true, source: 'default' }];
    const pathIssues = [];
    const configured = Array.isArray(globals.configPaths) ? globals.configPaths : [];
    if (!Array.isArray(globals.configPaths)) pathIssues.push({ severity: 'error', file: 'configPaths', message: 'configPaths must be a list of folders.' });
    for (const raw of configured) {
      const expanded = targets.expandConfigPath(raw);
      if (expanded.error) pathIssues.push({ severity: 'error', file: String(raw), message: expanded.error });
      else directories.push({ path: expanded.path, optional: false, source: 'configPaths' });
    }
    const workspaceFolders = (vscode.workspace.workspaceFolders || []).filter((folder) => folder.uri.scheme === 'file').map((folder) => folder.uri.fsPath);
    const loaded = await targets.loadConfigs({ builtinDirectory, directories, workspaceFolders });
    const profile = targets.resolveProfile(globals.profiles, globals.activeProfile, loaded.configs);
    const approvals = globalState.get(targets.APPROVALS_KEY, {});
    const trusted = vscode.workspace.isTrusted !== false;
    const base = globalPolicy(globals);
    const specs = [];
    const active = new Set();
    for (const entry of profile.targets) {
      const resolved = targets.targetPolicy(entry, base, { approvals, trusted, forceNotify: profile.fallback });
      active.add(entry.name);
      specs.push({ name: entry.name, label: entry.config.label, adapter: entry.config.adapter, policy: resolved.policy, automatic: resolved.automatic,
        reasons: resolved.reasons, command: resolved.command, debugTypes: resolved.debugTypes, entry });
    }
    const issues = [...pathIssues, ...loaded.issues];
    const configs = [...loaded.configs.values()].map((entry) => {
      const spec = specs.find((item) => item.name === entry.name);
      return { name: entry.name, label: entry.config.label, file: entry.file, builtin: entry.builtin, overrides: entry.overrides, active: active.has(entry.name),
        adapter: entry.config.adapter, mode: entry.config.action.mode, restartCommand: entry.config.action.restartCommand, hash: entry.hash.slice(0, 12),
        warningPrivateGiB: entry.config.thresholds.warningPrivateGiB, actionPrivateGiB: entry.config.thresholds.actionPrivateGiB, scaleWithWorkload: entry.config.scaleWithWorkload,
        automatic: spec?.automatic ?? false, blockedBy: spec?.reasons ?? [], needsApproval: targets.needsApproval(entry, approvals), inWorkspace: entry.inWorkspace };
    });
    const pendingApprovals = configs.filter((item) => item.active && item.needsApproval).length;
    const statusModel = { profile: profile.name, fallback: profile.fallback, profiles: profile.available, directories: directories.map((item) => ({ path: item.path, source: item.source })),
      configs, issues, warnings: profile.warnings, infos: loaded.infos, errors: issues.filter((issue) => issue.severity === 'error').length + (profile.fallback ? 1 : 0),
      pendingApprovals, trusted, loadedAt: new Date().toISOString() };
    for (const info of loaded.infos) log('info', `Config ${info}`);
    for (const issue of issues) log(issue.severity === 'error' ? 'error' : issue.severity === 'info' ? 'info' : 'warn', `Config ${issue.file}: ${issue.message}`);
    for (const warning of profile.warnings) log('warn', warning);
    const primary = specs.find((spec) => spec.adapter);
    const primaryPolicy = primary ? primary.policy : { ...base, mode: 'notifyOnly' };
    observer.setTargets(specs.map((spec) => ({ ...targets.collectorTarget(spec.entry), label: spec.label, command: spec.adapter ? undefined : spec.command || undefined })));
    journal.configure(primaryPolicy);
    configState = { status: statusModel, loaded, profile, directories };
    controller.configureTargets(primaryPolicy, specs.map(({ entry: _entry, ...spec }) => spec), statusModel);
    log('info', `Profile ${profile.name}${profile.fallback ? ' (fallback)' : ''}: ${specs.map((spec) => `${spec.name}${spec.automatic ? ' [automatic]' : ''}`).join(', ') || 'no targets'} (${reason}).`);
    for (const item of configs.filter((config) => config.active && config.needsApproval)) {
      const key = `${item.file}:${item.hash}`;
      if (notifiedApprovals.has(key)) continue;
      notifiedApprovals.add(key);
      void vscode.window.showWarningMessage(`Memory Watchdog config "${item.label}" wants to run ${item.restartCommand} automatically. It stays notify-only until you approve this exact content.`, 'Review…')
        .then((choice) => choice && vscode.commands.executeCommand(`${COMMAND_PREFIX}.approveConfig`)).catch((error) => logError('Approval notification', error));
    }
    rewatch(directories);
    return statusModel;
  }

  let reloadTimer = null;
  let reloading = Promise.resolve();
  const scheduleReload = (reason) => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { reloading = reloading.then(() => reloadTargets(reason)).catch((error) => logError('Config reload', error)); }, RELOAD_DEBOUNCE_MS);
  };
  let watchers = [];
  let watchedKey = '';
  function rewatch(directories) {
    if (typeof vscode.workspace.createFileSystemWatcher !== 'function' || !vscode.RelativePattern || !vscode.Uri) return;
    const key = directories.map((item) => item.path).join('\n');
    if (key === watchedKey) return;
    watchedKey = key;
    for (const watcher of watchers) watcher.dispose();
    watchers = directories.map((item) => {
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(item.path), `*${targets.SUFFIX}`));
      for (const event of ['onDidCreate', 'onDidChange', 'onDidDelete']) watcher[event]?.(() => scheduleReload('file change'));
      return watcher;
    });
  }
  context.subscriptions.push({ dispose: () => { clearTimeout(reloadTimer); for (const watcher of watchers) watcher.dispose(); } });

  try { await reloadTargets('activation'); } catch (error) { logError('Config load', error); }

  dashboard = createDashboard(vscode, { getSnapshot: () => controller.snapshot(), onError: logError, onAction: async (action, value) => {
    if (action === 'refresh') return controller.tick();
    if (action === 'showTerminal') {
      if (!observer.showTerminal(value)) void vscode.window.showInformationMessage('This terminal is no longer available in this window. Collect again to refresh the process inventory.');
      return;
    }
    if (action === 'profile') return vscode.workspace.getConfiguration(section).update('workload', value, vscode.ConfigurationTarget.Global);
    return vscode.commands.executeCommand(`${COMMAND_PREFIX}.${action}`);
  } });

  const handlers = new Map();
  const register = (name, callback) => {
    const run = async (...args) => {
      try { return await callback(...args); }
      catch (error) {
        logError(`Command ${name}`, error);
        void vscode.window.showErrorMessage('Memory Watchdog action failed. See Output → Memory Watchdog for details.');
      }
    };
    handlers.set(name, run);
    context.subscriptions.push(vscode.commands.registerCommand(`${COMMAND_PREFIX}.${name}`, run));
  };
  const updateSetting = (key, value) => vscode.workspace.getConfiguration(section).update(key, value, vscode.ConfigurationTarget.Global);
  const setEnabled = (value) => updateSetting('enabled', value);
  /** Apply the enabled setting and clear persisted suspension before requesting fresh evidence. */
  const resumeMonitoring = async () => {
    await setEnabled(true);
    // Configuration change delivery may lag behind update(), or be absent when already enabled.
    await reloadTargets('resume');
    await controller.resume();
    return controller.tick();
  };
  register('enable', resumeMonitoring);
  register('disable', () => setEnabled(false));
  register('suspend', async () => {
    const value = await vscode.window.showInputBox({ prompt: 'Suspend monitoring for how many minutes?', value: '15',
      validateInput: (text) => Number.isFinite(Number(text)) && Number(text) > 0 && Number(text) <= 10080 ? null : 'Enter a duration greater than 0 and at most 10080 minutes.' });
    if (value !== undefined) await controller.suspend(Number(value));
  });
  register('resume', resumeMonitoring);
  register('dashboard', () => dashboard.open());
  register('cancelRestart', () => controller.cancelRestart());
  register('postponeRestart', () => controller.postponeRestart());
  register('restartNow', () => controller.restartNow());
  register('selectWorkload', async () => {
    const workload = await vscode.window.showQuickPick(['development', 'tests', 'build'], { title: 'Workload · thresholds ×1 / ×1.5 / ×2 for configs with scaleWithWorkload' });
    if (workload) await updateSetting('workload', workload);
  });
  register('selectProfile', async () => {
    const status = configState.status;
    const userProfiles = readCurrentGlobals().profiles || {};
    const items = (status?.profiles || ['default']).map((name) => ({ label: name, description: name === status?.profile ? 'active' : '',
      detail: (Object.hasOwn(userProfiles, name) ? userProfiles[name] : targets.BUILTIN_PROFILES[name] || []).join(', ') }));
    const choice = await vscode.window.showQuickPick(items, { title: 'Active Memory Watchdog profile (define profiles in settings: frenchexdev.memoryWatchdog.profiles)' });
    if (choice) await updateSetting('activeProfile', choice.label);
  });
  register('changeMode', async () => {
    const value = await vscode.window.showQuickPick(['automatic', 'notifyOnly'], {
      title: 'notifyOnly disables every automatic restart. Automatic restarts discard session state and can interrupt interactive commands.',
    });
    if (value) await updateSetting('mode', value);
  });
  register('restart', async () => {
    if (environmentProblem()) return void vscode.window.showWarningMessage(environmentProblem());
    const answer = await vscode.window.showWarningMessage(
      'Restart this window’s Editor Services session? Ordinary pwsh terminals keep running. Variables, modules and editor session state will be lost; a running editor command may be interrupted.',
      { modal: true }, 'Restart');
    if (answer === 'Restart' && !await controller.manualRestart()) void vscode.window.showWarningMessage('Restart did not complete. Consult Watchdog diagnostics.');
  });
  register('approveConfig', async () => {
    const pending = (configState.status?.configs || []).filter((item) => item.needsApproval);
    if (!pending.length) return void vscode.window.showInformationMessage('No Memory Watchdog config is waiting for approval.');
    const choice = await vscode.window.showQuickPick(pending.map((item) => ({ label: item.label, description: item.restartCommand, detail: item.file, item })),
      { title: 'Approve an automatic restart command' });
    if (!choice) return;
    const entry = configState.loaded?.configs.get(choice.item.name);
    if (!entry || entry.file !== choice.item.file) return void vscode.window.showWarningMessage('This config changed; review it again.');
    const answer = await vscode.window.showWarningMessage(`Allow "${entry.config.label}" to run the VS Code command ${entry.config.action.restartCommand} automatically when its memory threshold is confirmed?\n\n${entry.file}\nContent hash ${entry.hash.slice(0, 12)}. Any edit to this file requires a new approval.`,
      { modal: true }, 'Approve');
    if (answer !== 'Approve') return;
    await globalState.update(targets.APPROVALS_KEY, targets.approve(globalState.get(targets.APPROVALS_KEY, {}), entry));
    await reloadTargets('approval');
  });
  register('copyBuiltinConfig', async () => {
    const builtins = [...(configState.loaded?.configs.values() || [])].filter((entry) => entry.builtin);
    const names = (await fs.readdir(builtinDirectory)).filter((name) => name.endsWith(targets.SUFFIX)).sort();
    const choice = await vscode.window.showQuickPick(names.map((name) => ({ label: name.slice(0, -targets.SUFFIX.length),
      description: builtins.find((entry) => `${entry.name}${targets.SUFFIX}` === name)?.config.label || '' })), { title: 'Copy a built-in config to your config folder (same name overrides it)' });
    if (!choice) return;
    const raw = JSON.parse(await fs.readFile(path.join(builtinDirectory, `${choice.label}${targets.SUFFIX}`), 'utf8'));
    delete raw.$schema;
    const directory = defaultDirectory();
    await fs.mkdir(directory, { recursive: true });
    const file = path.join(directory, `${choice.label}${targets.SUFFIX}`);
    try { await fs.writeFile(file, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' }); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      void vscode.window.showInformationMessage(`${file} already exists; opening it unchanged.`);
    }
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(file)));
    scheduleReload('copy');
  });
  register('openConfigFolder', async () => {
    const directory = defaultDirectory();
    await fs.mkdir(directory, { recursive: true });
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(directory));
  });
  register('reloadConfigs', () => reloadTargets('command'));
  const migrate = async (interactive) => {
    const legacy = readLegacyValues(vscode.workspace.getConfiguration(LEGACY_SECTION));
    const plan = buildMigration(legacy);
    if (!plan.needed) {
      await globalState.update(MIGRATION_KEY, 'done');
      if (interactive) void vscode.window.showInformationMessage('No 0.5.x Memory Watchdog setting to migrate.');
      return;
    }
    for (const error of plan.errors) log('error', `Migration: ${error}`);
    const directory = defaultDirectory();
    const { written, skipped } = await writeMigration(directory, plan.files);
    let approvals = globalState.get(targets.APPROVALS_KEY, {});
    // Files written by the migration reproduce settings the user already authorized in 0.5.x.
    for (const file of written) approvals = targets.approve(approvals, { file: file.file, hash: file.hash });
    await globalState.update(targets.APPROVALS_KEY, approvals);
    for (const [key, value] of Object.entries(plan.settings)) {
      if (vscode.workspace.getConfiguration(section).inspect(key)?.globalValue === undefined) await updateSetting(key, value);
    }
    await globalState.update(MIGRATION_KEY, 'done');
    await reloadTargets('migration');
    const message = `Memory Watchdog settings migrated: ${written.length} config(s) written to ${directory}${skipped.length ? `, ${skipped.length} existing file(s) kept` : ''}${plan.errors.length ? `, ${plan.errors.length} value(s) invalid (see Output)` : ''}. The old settings are deprecated and can be removed.`;
    void vscode.window.showInformationMessage(message, 'Open folder').then((choice) => choice && handlers.get('openConfigFolder')()).catch(() => {});
  };
  register('migrateSettings', () => migrate(true));
  register('diagnostics', async () => {
    const snapshot = controller.snapshot();
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({
      ...snapshot, environment: { vscode: vscode.version, app: vscode.env.appName, platform: process.platform, arch: process.arch,
        remote: vscode.env.remoteName || null, powershellExtension: vscode.extensions?.getExtension('ms-vscode.powershell')?.packageJSON.version || null },
      limitations: ['Activity is known only from observed VS Code shell execution events; unknown never means idle. Editor Services may not expose those events.',
        'Automatic restart applies to verified Editor Services, and to a generic target only when exactly one process of this window matches it.',
        `Editor Services restart association supports ms-vscode.powershell ${qualifiedPowerShellVersions.join(', ')}; other measurement does not require it.`,
        'On Linux, private memory is anonymous resident memory plus swap; on macOS it is the resident set size (see README compatibility table).'],
    }, null, 2) });
    await vscode.window.showTextDocument(document, { preview: true });
  });
  register('menu', async () => {
    const items = [ ['Live dashboard', 'dashboard'], ['Visual diagnostics (HTML)', 'visualDiagnostics'], ['Diagnostics (JSON)', 'diagnostics'],
      ['Active profile…', 'selectProfile'], ['Workload…', 'selectWorkload'], ['Approve a config…', 'approveConfig'], ['Copy a built-in config…', 'copyBuiltinConfig'],
      ['Open configs folder', 'openConfigFolder'], ['Reload configs', 'reloadConfigs'],
      ['Cancel scheduled restart', 'cancelRestart'], ['Postpone restarts 5 minutes', 'postponeRestart'], ['Restart scheduled target now', 'restartNow'], ['Enable', 'enable'], ['Disable', 'disable'],
      ['Suspend…', 'suspend'], ['Resume', 'resume'], ['Change mode…', 'changeMode'], ['Restart Editor Services session…', 'restart'] ];
    const selection = await vscode.window.showQuickPick(items.map(([label, action]) => ({ label, action })), { title: 'FrenchExDev Memory Watchdog' });
    if (selection) await vscode.commands.executeCommand(`${COMMAND_PREFIX}.${selection.action}`);
  });
  register('visualDiagnostics', async () => {
    const result = await exportVisualReport({ journal, getSnapshot: () => controller.snapshot(),
      environment: { extension: context.extension?.packageJSON.version, vscode: vscode.version, app: vscode.env.appName,
        platform: process.platform, node: process.versions.node,
        powershellExtension: vscode.extensions?.getExtension('ms-vscode.powershell')?.packageJSON.version || null },
      storagePath: context.storageUri?.fsPath, globalStoragePath: context.globalStorageUri.fsPath,
      openReport: (_filePath, html) => reportPanel.open(html),
      onOpenFailure: (filePath) => {
        void vscode.window.showWarningMessage(`HTML report saved at ${filePath}. The VS Code diagnostic tab could not be opened.`, 'Reveal report').then(async (choice) => {
          if (choice === 'Reveal report') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
        }).catch((error) => logError('Reveal report', error));
      },
    });
    return vscode.Uri.file(result.filePath);
  });
  for (const [legacy, current] of Object.entries(LEGACY_COMMANDS)) {
    context.subscriptions.push(vscode.commands.registerCommand(`${LEGACY_PREFIX}.${legacy}`, (...args) => handlers.get(current)(...args)));
  }
  const optional = (event, listener) => (typeof event === 'function' ? event(listener) : { dispose() {} });
  context.subscriptions.push(status, controller, activity, dashboard,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(section) || event.affectsConfiguration(LEGACY_SECTION)) scheduleReload('settings');
    }),
    optional(vscode.workspace.onDidGrantWorkspaceTrust, () => scheduleReload('workspace trust')),
    optional(vscode.workspace.onDidChangeWorkspaceFolders, () => scheduleReload('workspace folders')),
    vscode.debug.onDidStartDebugSession((session) => { trackDebug(session); controller.activityChanged(); }),
    vscode.debug.onDidTerminateDebugSession((session) => { if (debugSessions.delete(session.id)) controller.activityChanged(); }),
  );
  controller.start();
  if (!globalState.get(MIGRATION_KEY)) {
    const plan = buildMigration(readLegacyValues(vscode.workspace.getConfiguration(LEGACY_SECTION)));
    if (!plan.needed) void Promise.resolve(globalState.update(MIGRATION_KEY, 'done')).catch(() => {});
    else void vscode.window.showInformationMessage('Memory Watchdog 0.6 uses config files and profiles. Migrate your 0.5.x settings to config files now?', 'Migrate', 'Not now', 'Don’t ask again')
      .then(async (choice) => {
        if (choice === 'Migrate') await migrate(false);
        if (choice === 'Don’t ask again') await globalState.update(MIGRATION_KEY, 'dismissed');
      }).catch((error) => logError('Migration', error));
  }
  // Read-only diagnostics and an explicit sample request are useful to integration clients.
  return { getSnapshot: () => controller.snapshot(), sampleNow: () => controller.tick(), reloadConfigs: () => reloadTargets('api') };
}

module.exports = { activate, readPolicy, environmentProblem };
