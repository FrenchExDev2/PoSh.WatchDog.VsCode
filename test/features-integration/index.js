'use strict';

const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { until } = require('../browser-harness');

/** Exercise one isolated Stable window using actual Windows process metrics and VS Code views. */
exports.run = async () => {
  const report = { success: false, checks: [], vscode: vscode.version, platform: process.platform };
  let terminal;
  try {
    const extension = vscode.extensions.getExtension('FrenchExDev.powershell-watchdog');
    assert.ok(extension); const api = await extension.activate();
    terminal = vscode.window.createTerminal({ name: 'Watchdog 0.4 native fixture', shellPath: process.env.WATCHDOG_TEST_PWSH, shellArgs: ['-NoLogo', '-NoProfile'] });
    const pid = await terminal.processId;
    const sample = await until(async () => { await api.sampleNow(); return api.getSnapshot().processes.find((p) => p.pid === pid); }, 'native terminal process', 30000);
    assert.ok(sample.privateBytes > 0); assert.ok(sample.workingSetBytes > 0);
    assert.ok(sample.parentPid > 0); assert.ok(sample.threadCount > 0); assert.ok(sample.handleCount > 0);
    assert.equal(sample.terminalName, terminal.name);
    await until(async () => { await api.sampleNow(); return Number.isFinite(api.getSnapshot().processes.find((p) => p.pid === pid)?.cpuPercent); }, 'second native CPU observation');
    report.checks.push('Real Windows pwsh memory, parent PID, CPU delta, threads, handles and terminal association are measured.');

    await vscode.commands.executeCommand('powershellWatchdog.dashboard');
    await until(() => vscode.window.tabGroups.all.flatMap((group) => group.tabs).some((tab) => tab.input instanceof vscode.TabInputWebview && tab.label.includes('Watchdog')), 'dashboard tab creation');
    await vscode.commands.executeCommand('powershellWatchdog.dashboard');
    assert.equal(vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.label.includes('Watchdog')).length, 1);
    await vscode.commands.executeCommand('powershellWatchdog.dashboardView.focus');
    report.checks.push('The live editor dashboard opens and reuses one tab; the contributed activity-bar webview resolves.');

    const config = vscode.workspace.getConfiguration('frenchexdev.powershellWatchdog');
    await config.update('profile', 'build', vscode.ConfigurationTarget.Global);
    await until(async () => { await api.sampleNow(); return api.getSnapshot().profile === 'build' && api.getSnapshot().processes.find((p) => p.pid === pid)?.thresholds.restartPrivateGiB === 64; }, 'profile configuration and fresh measurement');
    assert.equal(api.getSnapshot().health.consecutiveErrors, 0); assert.ok(api.getSnapshot().health.lastCompletedAt);
    report.checks.push('A real user-machine profile change reaches the controller, resets evidence and applies effective per-process thresholds.');

    // API-created terminals do not always receive automatic injection. Initialize only this owned test shell.
    if (!terminal.shellIntegration) {
      assert.equal(api.getSnapshot().processes.find((p) => p.pid === pid)?.activity.state, 'unknown');
      const script = path.join(vscode.env.appRoot, 'out/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1');
      await fs.access(script);
      terminal.show();
      terminal.sendText(`Import-Module PSReadLine; . '${script.replace(/'/g, "''")}'`);
    }
    await until(() => terminal.shellIntegration, 'manually initialized terminal shell integration', 20000);
    terminal.sendText('Start-Sleep -Seconds 5');
    await until(async () => { await api.sampleNow(); return api.getSnapshot().processes.find((p) => p.pid === pid)?.activity.state === 'busy'; }, 'observed running shell execution', 15000);
    await until(async () => { await api.sampleNow(); return api.getSnapshot().processes.find((p) => p.pid === pid)?.activity.state === 'idle'; }, 'observed shell execution end', 15000);
    report.checks.push('Unknown activity is preserved without shell integration; actual VS Code execution signals report busy then idle after initializing the owned test shell.');

    const uri = await vscode.commands.executeCommand('powershellWatchdog.visualDiagnostics');
    const html = await fs.readFile(uri.fsPath, 'utf8');
    const data = JSON.parse(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.ok(data.entries.some((entry) => entry.processes.some((p) => p.pid === pid)));
    await vscode.commands.executeCommand('powershellWatchdog.diagnostics');
    await until(() => vscode.workspace.textDocuments.some((doc) => doc.languageId === 'json' && doc.getText().includes('automaticRestartBlockedBy')), 'JSON diagnostic document');
    const snapshot = api.getSnapshot();
    assert.ok(snapshot.history.some((entry) => entry.sessionId)); assert.equal(snapshot.journalError, null);
    assert.ok(!JSON.stringify(snapshot).includes('Start-Sleep -Seconds 5'));
    report.checks.push('Persistent history, HTML export and health JSON work in Desktop without collecting command text.');
    report.success = true;
  } catch (error) { report.error = error.message; report.stack = error.stack; throw error; }
  finally {
    terminal?.dispose();
    await fs.writeFile(path.join(process.env.WATCHDOG_TEST_RESULTS, 'native.json'), JSON.stringify(report, null, 2), 'utf8');
  }
};
