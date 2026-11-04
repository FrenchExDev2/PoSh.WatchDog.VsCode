'use strict';

const vscode = require('vscode');
const { readMachinePolicy } = require('./configuration');
const { WatchdogError } = require('./session');
const { WindowProcessObserver } = require('./observer');
const { describeStatus } = require('./presentation');
const path = require('node:path');
const { PersistentJournal } = require('./history');
const { ActivityTracker } = require('./activity');
const { createDashboard } = require('./dashboard');
const { WatchdogController } = require('./controller');
const { exportVisualReport } = require('./diagnostics-report');
const { createReportPanel } = require('./report-panel');

const section = 'frenchexdev.powershellWatchdog';

function readPolicy() {
  const configuration = vscode.workspace.getConfiguration(section);
  // Read only user-machine settings, even if workspace settings are manually injected.
  return readMachinePolicy(configuration);
}

function environmentProblem() {
  if (process.platform !== 'win32' || vscode.env.uiKind !== vscode.UIKind.Desktop || vscode.env.remoteName ||
    vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme !== 'file')) {
    return 'Only local Windows Desktop windows are supported.';
  }
  return null;
}

async function activate(context) {
  const reportPanel = createReportPanel(vscode);
  context.subscriptions.push(reportPanel);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
  status.name = 'PowerShell Memory Watchdog';
  status.command = 'powershellWatchdog.menu';
  status.show();
  const debugSessions = new Set();
  if (vscode.debug.activeDebugSession?.type.toLowerCase() === 'powershell') debugSessions.add(vscode.debug.activeDebugSession.id);
  let controller;
  let dashboard;
  let statusBackground;
  const activity = new ActivityTracker(vscode.window, (terminal) => controller?.activityChanged(terminal));
  const observer = new WindowProcessObserver(vscode, { activity });
  const update = (snapshot) => {
    const display = describeStatus(snapshot);
    if (status.text !== display.text) status.text = display.text;
    if (status.tooltip !== display.tooltip) status.tooltip = display.tooltip;
    const background = ['error', 'suspended', 'ambiguous', 'unsupported'].includes(snapshot.state) ? 'error' :
      ['warning', 'confirmed'].includes(snapshot.state) ? 'warning' : null;
    if (statusBackground !== background) {
      statusBackground = background;
      status.backgroundColor = background ? new vscode.ThemeColor(`statusBarItem.${background}Background`) : undefined;
    }
    dashboard?.update();
  };
  const notice = (level, message) => {
    if (level === 'countdown') {
      const intent = controller.restartIntent;
      void vscode.window.showWarningMessage(message, 'Cancel restart', 'Postpone 5 minutes', 'Restart now').then(async (action) => {
        if (controller.restartIntent !== intent) return;
        if (action === 'Cancel restart') await controller.cancelRestart();
        if (action === 'Postpone 5 minutes') await controller.postponeRestart();
        if (action === 'Restart now') await controller.restartNow();
      }).catch(() => {});
      return;
    }
    void vscode.window.showWarningMessage(message, 'Diagnostics', 'Suspend 15 minutes').then(async (action) => {
      if (action === 'Diagnostics') await vscode.commands.executeCommand('powershellWatchdog.diagnostics');
      if (action === 'Suspend 15 minutes') await controller.suspend(15);
    }).catch(() => {});
  };
  const initialPolicy = readPolicy();
  const journal = new PersistentJournal(path.join(context.storageUri?.fsPath || context.globalStorageUri.fsPath, 'history'), initialPolicy);
  await journal.ready;
  controller = new WatchdogController({
    observe: (milliseconds, signal) => {
      const problem = environmentProblem();
      if (problem) throw new WatchdogError('unsupported', problem);
      return observer.observe(milliseconds, signal);
    },
    commands: () => vscode.commands.getCommands(true),
    restart: () => vscode.commands.executeCommand('PowerShell.RestartSession'),
    debugging: () => debugSessions.size > 0,
    activity: (target) => activity.get(target?.terminal),
    journal,
    store: (value) => context.workspaceState.update('watchdog.policyState', value),
    onChange: update, notice,
  }, initialPolicy, context.workspaceState.get('watchdog.policyState', {}));

  dashboard = createDashboard(vscode, { getSnapshot: () => controller.snapshot(), onAction: async (action, value) => {
    if (action === 'refresh') return controller.tick();
    if (action === 'showTerminal') {
      if (!observer.showTerminal(value)) void vscode.window.showInformationMessage('This terminal is no longer available in this window. Collect again to refresh the process inventory.');
      return;
    }
    if (action === 'profile') return vscode.workspace.getConfiguration(section).update('profile', value, vscode.ConfigurationTarget.Global);
    return vscode.commands.executeCommand(`powershellWatchdog.${action}`);
  } });

  const register = (name, callback) => context.subscriptions.push(vscode.commands.registerCommand(`powershellWatchdog.${name}`, async () => {
    try { return await callback(); }
    catch { void vscode.window.showErrorMessage('PowerShell Watchdog action failed. Open diagnostics and check settings or storage access.'); }
  }));
  const setEnabled = (value) => vscode.workspace.getConfiguration(section).update('enabled', value, vscode.ConfigurationTarget.Global);
  /** Apply the enabled setting and clear persisted suspension before requesting fresh evidence. */
  const resumeMonitoring = async () => {
    await setEnabled(true);
    // Configuration change delivery may lag behind update(), or be absent when already enabled.
    controller.configure(readPolicy());
    await controller.resume();
    return controller.tick();
  };
  register('enable', resumeMonitoring);
  register('disable', () => setEnabled(false));
  register('suspend', async () => {
    const value = await vscode.window.showInputBox({ prompt: 'Suspend monitoring for how many minutes?', value: '15',
      validateInput: (text) => Number.isFinite(Number(text)) && Number(text) > 0 && Number(text) <= 10080 ? null : 'Enter a duration between 0 and 10080 minutes.' });
    if (value !== undefined) await controller.suspend(Number(value));
  });
  register('resume', resumeMonitoring);
  register('dashboard', () => dashboard.open());
  register('cancelRestart', () => controller.cancelRestart());
  register('postponeRestart', () => controller.postponeRestart());
  register('restartNow', () => controller.restartNow());
  register('selectProfile', async () => {
    const profile = await vscode.window.showQuickPick(['development', 'tests', 'build'], { title: 'Workload profile · thresholds ×1 / ×1.5 / ×2; explicit process thresholds take precedence' });
    if (profile) await vscode.workspace.getConfiguration(section).update('profile', profile, vscode.ConfigurationTarget.Global);
  });
  register('changeMode', async () => {
    const value = await vscode.window.showQuickPick(['automatic', 'notifyOnly'], {
      title: 'Automatic restarts discard session state and can interrupt interactive commands.',
    });
    if (value) await vscode.workspace.getConfiguration(section).update('mode', value, vscode.ConfigurationTarget.Global);
  });
  register('restart', async () => {
    if (environmentProblem()) return void vscode.window.showWarningMessage(environmentProblem());
    const answer = await vscode.window.showWarningMessage(
      'Restart this window’s Editor Services session? Ordinary pwsh terminals keep running. Variables, modules and editor session state will be lost; a running editor command may be interrupted.',
      { modal: true }, 'Restart');
    if (answer === 'Restart' && !await controller.manualRestart()) void vscode.window.showWarningMessage('Restart did not complete. Consult Watchdog diagnostics.');
  });
  register('diagnostics', async () => {
    const snapshot = controller.snapshot();
    const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({
      ...snapshot, environment: { vscode: vscode.version, app: vscode.env.appName, platform: process.platform,
        remote: vscode.env.remoteName || null, powershellExtension: vscode.extensions.getExtension('ms-vscode.powershell')?.packageJSON.version || null },
      limitations: ['Activity is known only from observed VS Code shell execution events; unknown never means idle. Editor Services may not expose those events.', 'Ordinary terminal and child pwsh processes generate alerts; automatic restart is limited to verified Editor Services.',
        'Editor Services automatic restart association supports ms-vscode.powershell 2026.1.2; other pwsh measurement does not require it.',
        'Stable and Insiders qualification results are recorded separately in QUALIFICATION.md.'],
    }, null, 2) });
    await vscode.window.showTextDocument(document, { preview: true });
  });
  register('menu', async () => {
    const items = [ ['Live dashboard', 'dashboard'], ['Visual diagnostics (HTML)', 'visualDiagnostics'], ['Diagnostics (JSON)', 'diagnostics'], ['Workload profile…', 'selectProfile'],
      ['Cancel scheduled restart', 'cancelRestart'], ['Postpone restarts 5 minutes', 'postponeRestart'], ['Restart scheduled session now', 'restartNow'], ['Enable', 'enable'], ['Disable', 'disable'],
      ['Suspend…', 'suspend'], ['Resume', 'resume'], ['Change mode…', 'changeMode'], ['Restart session…', 'restart'] ];
    const selection = await vscode.window.showQuickPick(items.map(([label, action]) => ({ label, action })), { title: 'PowerShell Memory Watchdog' });
    if (selection) await vscode.commands.executeCommand(`powershellWatchdog.${selection.action}`);
  });
  register('visualDiagnostics', async () => {
    const result = await exportVisualReport({ journal, getSnapshot: () => controller.snapshot(),
      environment: { extension: context.extension.packageJSON.version, vscode: vscode.version, app: vscode.env.appName,
        platform: process.platform, node: process.versions.node,
        powershellExtension: vscode.extensions.getExtension('ms-vscode.powershell')?.packageJSON.version || null },
      storagePath: context.storageUri?.fsPath, globalStoragePath: context.globalStorageUri.fsPath,
      openReport: (_filePath, html) => reportPanel.open(html),
      onOpenFailure: (filePath) => {
        void vscode.window.showWarningMessage(`HTML report saved at ${filePath}. The VS Code diagnostic tab could not be opened.`, 'Reveal report').then(async (choice) => {
          if (choice === 'Reveal report') await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(filePath));
        }).catch(() => {});
      },
    });
    return vscode.Uri.file(result.filePath);
  });
  context.subscriptions.push(status, controller, activity, dashboard,
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(section)) { const policy = readPolicy(); journal.configure(policy); controller.configure(policy); }
    }),
    vscode.debug.onDidStartDebugSession((session) => { if (session.type.toLowerCase() === 'powershell') { debugSessions.add(session.id); controller.activityChanged(); } }),
    vscode.debug.onDidTerminateDebugSession((session) => { if (debugSessions.delete(session.id)) controller.activityChanged(); }),
  );
  controller.start();
  // Read-only diagnostics and an explicit sample request are useful to integration clients.
  return { getSnapshot: () => controller.snapshot(), sampleNow: () => controller.tick() };
}

module.exports = { activate, readPolicy, environmentProblem };
