'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');
const root = path.resolve(__dirname, '..');

async function main() {
  if (process.platform !== 'win32') throw new Error('Native Windows qualification only.');
  const executable = process.env.WATCHDOG_TEST_VSCODE;
  if (!executable) throw new Error('Set WATCHDOG_TEST_VSCODE to an existing local Stable Code.exe. No automatic download.');
  await fs.access(executable);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-features-native-'));
  const userData = path.join(directory, 'user-data'); const extensions = path.join(directory, 'extensions');
  const workspace = path.join(directory, 'workspace');
  const configs = path.join(directory, 'configs');
  await fs.mkdir(path.join(userData, 'User'), { recursive: true }); await fs.mkdir(extensions); await fs.mkdir(workspace);
  await fs.mkdir(configs);
  await fs.writeFile(path.join(configs, 'pwsh-terminals.watchdog.json'), JSON.stringify({
    schemaVersion: 1, name: 'pwsh-terminals', label: 'Native test terminals',
    match: { processNames: ['pwsh'], ownership: 'terminal' },
    thresholds: { warningPrivateGiB: 16, actionPrivateGiB: 32 }, action: { mode: 'notifyOnly' },
  }, null, 2), 'utf8');
  await fs.writeFile(path.join(userData, 'User', 'settings.json'), JSON.stringify({
    'security.workspace.trust.enabled': false, 'telemetry.telemetryLevel': 'off', 'update.mode': 'none',
    'extensions.autoUpdate': false, 'extensions.autoCheckUpdates': false, 'workbench.startupEditor': 'none',
    'terminal.integrated.shellIntegration.enabled': true,
    'frenchexdev.memoryWatchdog.mode': 'notifyOnly',
    'frenchexdev.memoryWatchdog.configPaths': [configs],
    'frenchexdev.memoryWatchdog.sampleIntervalSeconds': 1,
  }, null, 2), 'utf8');
  delete process.env.ELECTRON_RUN_AS_NODE;
  try {
    await runTests({ vscodeExecutablePath: executable, extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'features-integration/index.js'),
      extensionTestsEnv: { WATCHDOG_TEST_RESULTS: directory, WATCHDOG_TEST_PWSH: process.env.WATCHDOG_TEST_PWSH || 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' },
      launchArgs: [workspace, '--user-data-dir', userData, '--extensions-dir', extensions, '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-updates'],
    });
  } finally {
    const result = JSON.parse(await fs.readFile(path.join(directory, 'native.json'), 'utf8').catch(() => JSON.stringify({ success: false, error: 'Desktop test did not produce a result.' })));
    result.directory = directory;
    await fs.mkdir(path.join(root, 'verification'), { recursive: true });
    await fs.writeFile(path.join(root, 'verification/features-native.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result));
  }
}

main().catch((error) => { console.log(JSON.stringify({ success: false, error: error.message })); process.exitCode = 1; });
