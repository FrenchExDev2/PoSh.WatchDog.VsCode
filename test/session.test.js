'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveSession, candidateFromOptions } = require('../src/session');

const descriptor = { extensionPath: 'C:\\extensions\\powershell', logPath: 'C:\\logs\\window1\\powershell', storagePath: 'C:\\storage\\powershell' };
function options(window = 1, suffix = '') {
  return { shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', shellArgs: ['-NoProfile', '-Command',
    `Import-Module 'C:\\extensions\\powershell\\modules\\PowerShellEditorServices\\PowerShellEditorServices.psd1'; Start-EditorServices -LogPath 'C:\\logs\\window${window}\\powershell' -SessionDetailsPath 'C:\\storage\\powershell\\sessions\\PSES-VSCode-123-456.json' ${suffix}`] };
}
function host(terminals, active = true, version = '2026.1.2') {
  const extension = { id: 'ms-vscode.powershell', isActive: active, extensionPath: descriptor.extensionPath,
    packageJSON: { version }, exports: { getLogUri: () => ({ scheme: 'file', fsPath: descriptor.logPath }),
      getStorageUri: () => ({ scheme: 'file', fsPath: descriptor.storagePath }) } };
  return { extensions: { getExtension: (id) => id === extension.id ? extension : undefined }, window: { terminals } };
}
const terminal = (window = 1, pid = 123) => ({ creationOptions: options(window), processId: Promise.resolve(pid) });

test('AC-01/02: current-window launch artifacts select one terminal and exclude the other window', async () => {
  const target = await resolveSession(host([terminal(2), terminal(1)]));
  assert.equal(target.pid, 123);
  assert.equal(target.logPath, descriptor.logPath);
  assert.equal(candidateFromOptions(options(2), descriptor), null);
});

test('AC-03: duplicate matching terminals fail closed', async () => {
  await assert.rejects(resolveSession(host([terminal(), terminal()])), { code: 'ambiguous' });
});

test('ordinary PowerShell, debug-only and substituted module paths are excluded', () => {
  assert.equal(candidateFromOptions({ shellPath: 'pwsh.exe', shellArgs: [] }, descriptor), null);
  assert.equal(candidateFromOptions(options(1, '-DebugServiceOnly'), descriptor), null);
  const replaced = options();
  replaced.shellArgs[2] = replaced.shellArgs[2].replace('C:\\extensions\\powershell', 'C:\\repo\\fake');
  assert.equal(candidateFromOptions(replaced, descriptor), null);
  assert.equal(candidateFromOptions(options(1, "-LogPath 'duplicate'"), descriptor), null);
});

test('waiting does not activate PowerShell or start a session', async () => {
  assert.equal((await resolveSession(host([], false))).state, 'waiting');
  assert.equal((await resolveSession(host([]))).state, 'waiting');
});

test('unknown extension versions and unavailable PIDs are explicit failures', async () => {
  await assert.rejects(resolveSession(host([terminal()], true, '2027.1.0')), (error) => {
    assert.equal(error.code, 'unsupported');
    assert.match(error.message, /ms-vscode.powershell 2027.1.0/);
    assert.match(error.message, /Qualified: ms-vscode.powershell 2026.1.2/);
    assert.match(error.message, /monitoring and alerts remain available/);
    return true;
  });
  await assert.rejects(resolveSession(host([{ creationOptions: options(), processId: Promise.resolve(undefined) }])), { code: 'unknown' });
});
