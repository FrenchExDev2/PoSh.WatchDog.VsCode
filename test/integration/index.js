'use strict';

const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(action, description, milliseconds = 60000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const result = await action();
    if (result) return result;
    await sleep(1000);
  }
  throw new Error(`Timed out: ${description}`);
}

exports.run = async () => {
  const shared = process.env.WATCHDOG_TEST_SHARED;
  const id = process.env.WATCHDOG_TEST_ID;
  const output = path.join(shared, `${id}.json`);
  const reopening = process.env.WATCHDOG_TEST_REOPEN === '1';
  const report = reopening ? JSON.parse(await fs.readFile(output, 'utf8')) : {
    id, vscode: vscode.version, app: vscode.env.appName, platform: process.platform,
    powershellExtension: null, checks: [], observations: {},
  };
  let ordinary;
  let childPid;
  try {
    const extension = vscode.extensions.getExtension('FrenchExDev.powershell-watchdog');
    assert.ok(extension, 'VSIX must be installed; the product is not an extensionDevelopmentPath.');
    assert.equal(extension.packageJSON.version, require('../../package.json').version);
    const api = await extension.activate();
    if (reopening) {
      await api.sampleNow();
      assert.equal(api.getSnapshot().policy.enabled, false);
      assert.equal(api.getSnapshot().state, 'disabled');
      assert.equal(api.getSnapshot().automaticRestarts, id === 'A' ? 1 : 0);
      report.checks.push('A fresh editor process preserved disabled monitoring and the per-workspace restart quota.');
      report.reopened = true;
      report.success = true;
      return;
    }
    const powershell = vscode.extensions.getExtension('ms-vscode.powershell');
    assert.ok(powershell);
    report.powershellExtension = powershell.packageJSON.version;
    const quotePowerShell = (value) => `'${value.replace(/'/g, "''")}'`;
    ordinary = vscode.window.createTerminal({ name: 'Watchdog sandbox ordinary PowerShell', shellPath: process.env.WATCHDOG_TEST_PWSH,
      shellArgs: ['-NoLogo', '-NoProfile'] });
    const ordinaryPid = await ordinary.processId;
    await until(async () => {
      await api.sampleNow();
      return api.getSnapshot().processes.some((entry) => entry.pid === ordinaryPid && entry.kind === 'terminal');
    }, 'ordinary pwsh measurement before explicitly activating Microsoft PowerShell');
    assert.equal(api.getSnapshot().state, 'normal');
    report.checks.push('An ordinary pwsh terminal is measured without explicitly starting Editor Services.');
    const childPidPath = path.join(shared, `${id}.child.pid`);
    ordinary.sendText(`$global:WatchdogSandboxChild = Start-Process -FilePath ${quotePowerShell(process.env.WATCHDOG_TEST_PWSH)} -ArgumentList '-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 120' -NoNewWindow -PassThru; $global:WatchdogSandboxChild.Id | Set-Content -LiteralPath ${quotePowerShell(childPidPath)}`);
    childPid = await until(async () => {
      try { return Number((await fs.readFile(childPidPath, 'utf8')).trim()) || null; } catch { return null; }
    }, 'owned nested pwsh PID');
    await until(async () => {
      await api.sampleNow();
      return api.getSnapshot().processes.some((entry) => entry.pid === childPid && entry.kind === 'child' && entry.rootPid === ordinaryPid);
    }, 'nested pwsh process attributed to its own terminal');
    ordinary.sendText('if ($global:WatchdogSandboxChild -and !$global:WatchdogSandboxChild.HasExited) { $global:WatchdogSandboxChild.Kill(); $null = $global:WatchdogSandboxChild.WaitForExit(5000) }');
    await until(async () => { await api.sampleNow(); return !api.getSnapshot().processes.some((entry) => entry.pid === childPid); }, 'exited nested pwsh removed');
    childPid = null;
    report.checks.push('Nested pwsh ownership is measured and exited child processes disappear from the inventory.');
    // Only this test driver starts a session. The installed watchdog never activates PowerShell.
    await powershell.activate();
    const document = await vscode.workspace.openTextDocument(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'sample.ps1'));
    await vscode.window.showTextDocument(document);
    const first = await until(async () => {
      await api.sampleNow();
      return api.getSnapshot().sample;
    }, 'first associated memory sample');
    report.checks.push('Installed VSIX activated and measured the local Editor Services session.');
    report.observations.initial = first;
    const terminals = await Promise.all(vscode.window.terminals.map(async (terminal) => ({ terminal, pid: await terminal.processId })));
    const editorTerminal = terminals.find((entry) => entry.pid === first.pid)?.terminal;
    assert.ok(editorTerminal, 'Measured PID belongs to a terminal of this window.');
    const config = vscode.workspace.getConfiguration('frenchexdev.powershellWatchdog');
    await config.update('warningPrivateGiB', (first.privateBytes + 64 * 1024 ** 2) / 1024 ** 3, vscode.ConfigurationTarget.Global);
    await config.update('restartPrivateGiB', (first.privateBytes + 96 * 1024 ** 2) / 1024 ** 3, vscode.ConfigurationTarget.Global);
    assert.notEqual(ordinaryPid, first.pid);
    ordinary.sendText('$global:WatchdogOrdinaryAllocation = [byte[]]::new(32MB)');
    // Bounded pressure, 192 MiB in each of two Editor Services sessions. No host saturation is attempted.
    editorTerminal.sendText('$global:WatchdogSandboxAllocation = [byte[]]::new(192MB); for ($i = 0; $i -lt $global:WatchdogSandboxAllocation.Length; $i += 4096) { $global:WatchdogSandboxAllocation[$i] = 1 }');
    const high = await until(async () => {
      await api.sampleNow();
      const current = api.getSnapshot();
      return current.sample?.privateBytes >= current.policy.restartPrivateGiB * 1024 ** 3 && current.consecutiveSamples >= 3 ? current : null;
    }, 'three real samples above the scaled threshold');
    assert.equal(high.sample.pid, first.pid);
    assert.equal(high.restartOutcome, null);
    report.checks.push('notifyOnly retained the session during three measured high-memory samples.');
    report.observations.high = high.sample;
    report.observations.ordinaryPid = ordinaryPid;
    await fs.writeFile(path.join(shared, `${id}.ready.json`), JSON.stringify({ pid: first.pid, ordinaryPid }));
    const peerId = id === 'A' ? 'B' : 'A';
    const peer = await until(async () => {
      try { return JSON.parse(await fs.readFile(path.join(shared, `${peerId}.ready.json`), 'utf8')); }
      catch { return null; }
    }, 'other isolated window under memory pressure');
    assert.notEqual(first.pid, peer.pid);
    assert.notEqual(high.sample.pid, peer.ordinaryPid);
    assert.equal(api.getSnapshot().processes.some((entry) => entry.pid === peer.pid || entry.pid === peer.ordinaryPid), false);
    assert.ok(api.getSnapshot().processes.some((entry) => entry.pid === ordinaryPid));
    report.checks.push('Each window measures its own Editor Services and ordinary terminal while excluding the other window’s processes.');

    if (id === 'A') {
      const debugScript = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, 'debug.ps1');
      await fs.writeFile(debugScript, 'Start-Sleep -Seconds 30\n');
      const debugStarted = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders[0], {
        type: 'PowerShell', request: 'launch', name: 'Watchdog sandbox debug deferral', script: debugScript,
      });
      assert.equal(debugStarted, true);
      await until(() => vscode.debug.activeDebugSession?.type.toLowerCase() === 'powershell', 'PowerShell debug session');
      await config.update('mode', 'automatic', vscode.ConfigurationTarget.Global);
      await until(async () => {
        await api.sampleNow();
        return api.getSnapshot().state === 'deferred';
      }, 'automatic restart deferred during real PowerShell debugging');
      assert.equal(api.getSnapshot().automaticRestarts, 0);
      await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
      await until(() => !vscode.debug.activeDebugSession, 'PowerShell debug session stopped');
      report.checks.push('A real PowerShell debugger deferred automatic restart until fresh post-debug samples.');
      await until(async () => {
        await api.sampleNow();
        return api.getSnapshot().restartOutcome === 'succeeded';
      }, 'automatic restart and measured replacement', 90000);
      const replaced = api.getSnapshot();
      assert.notEqual(replaced.sample.pid, first.pid);
      assert.equal(replaced.automaticRestarts, 1);
      assert.equal(replaced.state, 'cooldown');
      report.observations.replacement = replaced.sample;
      report.checks.push('Automatic restart replaced only window A session and entered cooldown.');
      await fs.writeFile(path.join(shared, 'A.restarted.json'), JSON.stringify({ newPid: replaced.sample.pid }));
      await until(async () => { try { await fs.access(path.join(shared, 'B.verified')); return true; } catch { return false; } }, 'peer verified isolation');
    } else {
      await until(async () => { try { await fs.access(path.join(shared, 'A.restarted.json')); return true; } catch { return false; } }, 'window A restart', 90000);
      await api.sampleNow();
      assert.equal(api.getSnapshot().sample.pid, first.pid);
      assert.equal(api.getSnapshot().restartOutcome, null);
      report.checks.push('Window B session remained unchanged after window A automatic restart.');
      await fs.writeFile(path.join(shared, 'B.verified'), 'ok');
    }

    ordinary.sendText('$global:WatchdogOrdinaryAllocation = [byte[]]::new(192MB); for ($i = 0; $i -lt $global:WatchdogOrdinaryAllocation.Length; $i += 4096) { $global:WatchdogOrdinaryAllocation[$i] = 1 }');
    const ordinaryHigh = await until(async () => {
      await api.sampleNow();
      return api.getSnapshot().processes.find((entry) => entry.pid === ordinaryPid && entry.state === 'confirmed');
    }, 'ordinary pwsh above threshold without restarting Editor Services');
    assert.equal(api.getSnapshot().automaticRestarts, id === 'A' ? 1 : 0);
    assert.equal(api.getSnapshot().sample.pid, id === 'A' ? report.observations.replacement.pid : first.pid);
    assert.equal(ordinaryHigh.automaticRestart, false);
    report.observations.ordinaryHigh = ordinaryHigh;
    report.checks.push('A high-memory ordinary pwsh produces per-process warnings without restarting the editor session or closing that terminal.');

    await vscode.commands.executeCommand('memoryWatchdog.disable');
    await until(() => api.getSnapshot().policy.enabled === false, 'disable user setting');
    assert.equal(vscode.workspace.getConfiguration('frenchexdev.powershellWatchdog').inspect('enabled').globalValue, false);
    assert.equal(api.getSnapshot().state, 'disabled');
    await vscode.commands.executeCommand('memoryWatchdog.enable');
    await until(() => api.getSnapshot().policy.enabled === true, 'enable user setting');
    // A workspace attempt to escalate authority must be ignored by readPolicy.
    await assert.rejects(config.update('mode', 'automatic', vscode.ConfigurationTarget.Workspace));
    await config.update('mode', 'notifyOnly', vscode.ConfigurationTarget.Global);
    const settingsDirectory = path.join(vscode.workspace.workspaceFolders[0].uri.fsPath, '.vscode');
    await fs.mkdir(settingsDirectory, { recursive: true });
    await fs.writeFile(path.join(settingsDirectory, 'settings.json'), JSON.stringify({ 'frenchexdev.powershellWatchdog.mode': 'automatic' }));
    await sleep(1000);
    await until(() => api.getSnapshot().policy.mode === 'notifyOnly', 'machine-only policy');
    report.checks.push('Enable/disable persist as user settings; workspace mode override is ignored.');
    await vscode.commands.executeCommand('memoryWatchdog.diagnostics');
    assert.equal(vscode.window.activeTextEditor.document.languageId, 'json');
    const diagnostic = JSON.parse(vscode.window.activeTextEditor.document.getText());
    assert.equal(diagnostic.policy.mode, 'notifyOnly');
    assert.ok(diagnostic.history.length <= 200);
    assert.ok(!JSON.stringify(diagnostic).includes('WatchdogSandboxAllocation'));
    report.checks.push('Diagnostic view contains bounded measurements without command lines or script content.');
    await until(async () => {
      await api.sampleNow();
      return api.getSnapshot().processes.some((item) => item.pid === ordinaryPid);
    }, 'fresh inventory after policy configuration before exporting HTML');
    const htmlUri = await vscode.commands.executeCommand('memoryWatchdog.visualDiagnostics');
    assert.equal(htmlUri.scheme, 'file');
    const diagnosticTabs = () => vscode.window.tabGroups.all.flatMap((group) => group.tabs)
      .filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.label === 'Memory Watchdog · Visual diagnostics');
    await until(() => diagnosticTabs().some((tab) => tab.isActive), 'visual diagnostic editor tab');
    assert.equal(diagnosticTabs().length, 1);
    await vscode.commands.executeCommand('memoryWatchdog.visualDiagnostics');
    assert.equal(diagnosticTabs().length, 1);
    const html = await fs.readFile(htmlUri.fsPath, 'utf8');
    assert.ok(html.startsWith('<!doctype html>'));
    const visual = JSON.parse(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
    assert.equal(visual.environment.extension, extension.packageJSON.version);
    assert.ok(visual.quality.filesRead > 0);
    assert.ok(visual.entries.length > 0);
    assert.ok(visual.current.processes.some((item) => item.pid === ordinaryPid));
    assert.ok(!visual.series.some((item) => item.pid === peer.pid || item.pid === peer.ordinaryPid));
    assert.ok(!html.includes('WatchdogSandboxAllocation'));
    report.observations.visualReport = { path: htmlUri.fsPath, bytes: Buffer.byteLength(html),
      retainedEntries: visual.entries.length, filesRead: visual.quality.filesRead };
    report.checks.push('The installed HTML diagnostic command exports this window’s retained journals and process inventory to a standalone local file and displays it in one reusable VS Code webview tab.');
    const start = performance.now();
    const baseline = process.memoryUsage().heapUsed;
    for (let index = 0; index < 10000; index++) api.getSnapshot();
    report.observations.snapshotProbe = { iterations: 10000, elapsedMs: performance.now() - start,
      heapDeltaBytes: process.memoryUsage().heapUsed - baseline,
      limitation: 'Short shared-host heap probe, not a stabilized or attributable watchdog memory benchmark.' };
    await vscode.commands.executeCommand('memoryWatchdog.disable');
    await until(() => api.getSnapshot().policy.enabled === false, 'disabled before editor restart');
    report.success = true;
  } catch (error) {
    report.success = false;
    report.error = error.message;
    report.stack = error.stack;
    throw error;
  } finally {
    if (childPid && ordinary) {
      ordinary.sendText('if ($global:WatchdogSandboxChild -and !$global:WatchdogSandboxChild.HasExited) { $global:WatchdogSandboxChild.Kill(); $null = $global:WatchdogSandboxChild.WaitForExit(5000) }');
      await sleep(1000);
    }
    ordinary?.dispose();
    await fs.writeFile(output, JSON.stringify(report, null, 2));
  }
};
