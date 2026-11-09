'use strict';

// Objective: ownership invariants (window, ancestry, PID reuse, editor boundaries) hold on every OS, and target
// matching assigns processes without leaking command lines or letting a user pattern stall the extension host.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const selection = require('../src/selection');

const base = Date.parse('2026-10-29T00:00:00Z');
const fixture = (pid, ppid, name, age = 10, exe = null, commandLine = null) => ({ pid, ppid, name, exe, commandLine,
  createdAt: new Date(base + age * 1000).toISOString(), privateBytes: 1024, workingSetBytes: 2048 });
const pwsh = (proc) => proc.name === 'pwsh';
const ids = (result) => result.selected.map((entry) => entry.proc.pid).sort((a, b) => a - b);

const editorPath = 'C:\\Code\\Code.exe';
const code = (pid, ppid, age) => fixture(pid, ppid, 'code', age, editorPath);
const graph = [code(10, 0, 0), code(11, 10, 1), fixture(12, 11, 'pwsh'), code(20, 10, 1), fixture(30, 20, 'pwsh'), fixture(31, 20, 'cmd'),
  fixture(32, 31, 'pwsh', 11), fixture(33, 32, 'pwsh', 12), fixture(40, 30, 'pwsh', 12), fixture(50, 20, 'pwsh'), code(60, 30, 11),
  fixture(61, 60, 'pwsh', 12), fixture(70, 80, 'pwsh', 11), fixture(80, 30, 'cmd', 20), fixture(90, 91, 'pwsh'), fixture(91, 90, 'cmd'),
  fixture(99, 11, 'pwsh'), code(100, 0, 0), code(101, 100, 1), fixture(102, 101, 'pwsh')];
const select = (processes, options) => selection.selectWindowProcesses(processes, { platform: 'win32', candidate: pwsh, ...options });
const main = { hostProcessId: 11, rootProcessIds: [11, 30, 31], editorExecutable: editorPath, excludedProcessIds: [99] };

test('terminal, nested, non-pwsh terminal and extension-host children are selected; other windows and reuse are not', () => {
  const result = select(graph, main);
  assert.deepEqual(ids(result), [12, 30, 32, 33, 40]);
  assert.equal(result.selected.find((entry) => entry.proc.pid === 33).rootPid, 31);
  assert.equal(result.hostVerified, true);
});

test('executable mismatch selects nothing and reports unverified ownership explicitly', () => {
  const result = select(graph, { ...main, editorExecutable: 'C:\\Other\\Code.exe' });
  assert.equal(result.selected.length, 0);
  assert.equal(result.errors[0].code, 'ownershipUnverified');
  assert.equal(select(graph, { ...main, rootProcessIds: [] }).selected.length, 0);
});

test('separate instances, nested editors and missing, unavailable or non-editor hosts are rejected', () => {
  assert.equal(select(graph, { ...main, rootProcessIds: [102] }).selected.length, 0);
  assert.equal(select(graph, { ...main, rootProcessIds: [61] }).selected.length, 0);
  assert.equal(select(graph, { ...main, hostProcessId: undefined }).selected.length, 0);
  assert.equal(select(graph, { ...main, hostProcessId: 999 }).selected.length, 0);
  assert.equal(select(graph, { ...main, hostProcessId: 30 }).selected.length, 0);
});

test('Insiders and Stable stay isolated and reused or cyclic editor ancestry is refused', () => {
  const insidersPath = 'C:\\Insiders\\Code - Insiders.exe';
  const ins = (pid, ppid, age) => fixture(pid, ppid, 'code - insiders', age, insidersPath);
  const insidersGraph = [...graph, ins(200, 0, 0), ins(211, 200, 1), fixture(212, 211, 'pwsh'), ins(220, 200, 1), fixture(230, 220, 'cmd'),
    fixture(231, 230, 'pwsh'), fixture(232, 231, 'pwsh', 11), ins(300, 0, 0), fixture(301, 300, 'pwsh')];
  assert.deepEqual(ids(select(insidersGraph, { hostProcessId: 211, rootProcessIds: [211, 230, 12, 102, 301], editorExecutable: insidersPath })), [212, 231, 232]);
  const reused = [ins(400, 401, 1), ins(401, 0, 20), fixture(402, 400, 'pwsh')];
  assert.equal(select(reused, { hostProcessId: 400, rootProcessIds: [400], editorExecutable: insidersPath }).selected.length, 0);
  const cyclic = [ins(500, 501, 1), ins(501, 500, 1), fixture(502, 500, 'pwsh')];
  assert.equal(select(cyclic, { hostProcessId: 500, rootProcessIds: [500], editorExecutable: insidersPath }).selected.length, 0);
});

test('collector children are excluded together with the collector itself', () => {
  const processes = [...graph, fixture(700, 11, 'pwsh'), fixture(701, 700, 'pwsh', 11)];
  assert.deepEqual(ids(select(processes, { ...main, excludedProcessIds: [99, 700] })), [12, 30, 32, 33, 40]);
});

test('Linux: an Electron-as-Node child of the extension host is a candidate while other editor hosts stay boundaries', () => {
  const exe = '/usr/share/code/code';
  const processes = [fixture(1, 0, 'code', 0, exe), fixture(2, 1, 'code', 1, exe), fixture(3, 2, 'code', 2, exe, '/usr/share/code/code .../tsserver.js --serverMode partialSemantic'),
    fixture(4, 2, 'pwsh', 2, '/opt/microsoft/powershell/7/pwsh'), fixture(5, 1, 'code', 1, exe), fixture(6, 5, 'pwsh', 2)];
  const result = selection.selectWindowProcesses(processes, { hostProcessId: 2, rootProcessIds: [2], editorExecutable: exe, platform: 'linux' });
  assert.deepEqual(ids(result), [3, 4]);
});

test('macOS: helper processes of the same bundle are editor processes, a different bundle is not', () => {
  const app = '/Applications/Visual Studio Code.app';
  const mainExe = `${app}/Contents/MacOS/Electron`;
  const helper = `${app}/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin)`;
  const isEditor = selection.editorMatcher(mainExe, 'darwin');
  assert.equal(isEditor({ exe: helper }), true);
  assert.equal(isEditor({ exe: '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron' }), false);
  assert.equal(isEditor({ exe: `${app}/Contents/Resources/app/bin/code` }), false);
  const processes = [fixture(1, 0, 'Electron', 0, mainExe), fixture(2, 1, 'Code Helper (Plugin)', 1, helper), fixture(3, 2, 'pwsh', 2, '/usr/local/bin/pwsh'),
    fixture(9, 0, 'Electron', 0, '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron'), fixture(10, 9, 'pwsh', 1)];
  assert.deepEqual(ids(selection.selectWindowProcesses(processes, { hostProcessId: 2, rootProcessIds: [2, 10], editorExecutable: mainExe, platform: 'darwin' })), [3]);
});

test('targets match in profile order by name, ownership and bounded command-line pattern', () => {
  const entries = [{ proc: fixture(5, 2, 'pwsh'), rootPid: 5 }, { proc: fixture(6, 5, 'pwsh'), rootPid: 5 },
    { proc: fixture(7, 2, 'code', 1, null, 'code tsserver.js'), rootPid: 2 }, { proc: fixture(8, 5, 'bash'), rootPid: 5 }];
  const targets = [{ name: 'terminals', processNames: ['pwsh'], ownership: 'terminal' }, { name: 'children', processNames: ['PWSH.exe'], ownership: 'child' },
    { name: 'ts', processNames: ['*'], ownership: 'extensionHost', commandLine: 'TSSERVER\\.js' }, { name: 'adapter', adapter: 'powershellEditorServices' },
    { name: 'rest', processNames: ['*'], ownership: 'window' }];
  const { assigned, errors } = selection.matchTargets(entries, targets, { hostProcessId: 2, terminalProcessIds: new Set([5]), platform: 'win32' });
  assert.deepEqual([...assigned], [[5, 'terminals'], [6, 'children'], [7, 'ts'], [8, 'rest']]);
  assert.deepEqual(errors, []);
});

test('catastrophic and invalid user patterns are contained per target', () => {
  const started = Date.now();
  const timeout = selection.testPattern('^(a+)+$', ['a'.repeat(40) + 'b'], 50);
  assert.equal(timeout.error, 'patternTimeout');
  assert.ok(Date.now() - started < 2000);
  assert.equal(selection.testPattern('(', ['x']).error, 'invalidPattern');
  assert.deepEqual(selection.testPattern('b', ['abc', null]).matches, [true, false]);
  const entries = [{ proc: fixture(5, 2, 'node', 1, null, 'a'.repeat(40) + 'b'), rootPid: 2 }];
  const { assigned, errors } = selection.matchTargets(entries, [{ name: 'evil', processNames: ['*'], ownership: 'window', commandLine: '^(a+)+$' },
    { name: 'fallback', processNames: ['node'], ownership: 'window' }], { hostProcessId: 2, timeout: 50 });
  assert.deepEqual([...assigned], [[5, 'fallback']]);
  assert.deepEqual(errors, [{ pid: 0, code: 'patternTimeout', target: 'evil' }]);
});

const editor = { pid: 30, shellPath: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', logPath: "C:\\logs\\it's", sessionPath: 'C:\\s\\PSES-VSCode-1-2.json' };
const pses = (extra = '') => `"${editor.shellPath}" -NoProfile -Command "Import-Module 'x'; Start-EditorServices -LogPath 'C:\\logs\\it''s' -SessionDetailsPath 'C:\\s\\PSES-VSCode-1-2.json'${extra}"`;

test('Editor Services is verified by executable, entry point and exactly one log and session path', () => {
  const proc = { ...fixture(30, 20, 'pwsh', 10, 'c:\\program files\\powershell\\7\\PWSH.EXE'), commandLine: pses() };
  assert.equal(selection.verifyEditorServices(proc, editor, { platform: 'win32' }), true);
  assert.equal(selection.verifyEditorServices({ ...proc, commandLine: pses(' -DebugServiceOnly') }, editor, { platform: 'win32' }), false);
  assert.equal(selection.verifyEditorServices({ ...proc, commandLine: pses(" -LogPath 'C:\\logs\\it''s'") }, editor, { platform: 'win32' }), false);
  assert.equal(selection.verifyEditorServices({ ...proc, exe: 'C:\\other\\pwsh.exe' }, editor, { platform: 'win32' }), false);
  assert.equal(selection.verifyEditorServices({ ...proc, pid: 31 }, editor, { platform: 'win32' }), false);
  const linux = { ...editor, shellPath: '/usr/bin/pwsh', logPath: '/home/u/logs', sessionPath: '/home/u/s/PSES-VSCode-1-2.json' };
  const linuxProc = { ...fixture(30, 20, 'pwsh', 10, '/opt/microsoft/powershell/7/pwsh'),
    commandLine: "/usr/bin/pwsh -NoProfile -Command Import-Module 'x'; Start-EditorServices -LogPath '/home/u/logs' -SessionDetailsPath '/home/u/s/PSES-VSCode-1-2.json'" };
  assert.equal(selection.verifyEditorServices(linuxProc, linux, { platform: 'linux' }), false);
  assert.equal(selection.verifyEditorServices(linuxProc, linux, { platform: 'linux', resolvedShellPath: '/opt/microsoft/powershell/7/pwsh' }), true);
});

test('collection returns samples with target ids, verified editor only, and never command lines', async () => {
  const processes = [code(10, 0, 0), code(11, 10, 1), { ...fixture(30, 11, 'pwsh', 10, editor.shellPath), commandLine: pses() },
    fixture(31, 30, 'pwsh', 11), fixture(32, 11, 'pwsh', 10), { ...fixture(33, 11, 'pwsh'), privateBytes: null }];
  const request = { hostProcessId: 11, rootProcessIds: [11, 30, 404], terminalProcessIds: [30], editorExecutable: editorPath, editor,
    targets: [{ name: 'pwsh-editor-services', adapter: 'powershellEditorServices' }, { name: 'pwsh-terminals', processNames: ['pwsh'], ownership: 'terminal' },
      { name: 'pwsh-children', processNames: ['pwsh'], ownership: 'child' }] };
  const snapshot = async () => ({ processes, source: 'cim', collectorPids: [32] });
  const result = await selection.collectWindowProcesses(request, 1000, undefined, { snapshot, platform: 'win32', now: () => new Date(base) });
  assert.equal(result.editorVerified, true);
  assert.deepEqual(result.processes.map((item) => [item.pid, item.targetId]), [[30, 'pwsh-editor-services'], [31, 'pwsh-children']]);
  assert.ok(result.processes.every((item) => !('commandLine' in item)));
  assert.deepEqual(result.errors.map((item) => item.code).sort(), ['processUnavailableOrChanged', 'rootUnavailable']);
  const unverified = await selection.collectWindowProcesses({ ...request, editor: { ...editor, logPath: 'C:\\elsewhere' } }, 1000, undefined, { snapshot, platform: 'win32' });
  assert.equal(unverified.editorVerified, false);
  assert.equal(unverified.processes.find((item) => item.pid === 30).targetId, 'pwsh-terminals');
});