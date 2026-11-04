'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { WindowProcessObserver, validSample } = require('../src/observer');

const sample = (pid, rootPid = pid) => ({ pid, rootPid, createdAt: '2026-10-29T00:00:00Z', measuredAt: '2026-10-29T00:01:00Z',
  privateBytes: 1024, workingSetBytes: 2048 });
const inventory = (processes = []) => ({ processes, errors: [], limited: false, editorVerified: false });
const terminal = (pid) => ({ processId: Promise.resolve(pid), creationOptions: {} });

test('Windows process selector enforces window, ancestry, lifetime and editor boundaries', async () => {
  const { stdout } = await promisify(execFile)('pwsh', ['-NoProfile', '-File', path.join(__dirname, 'ProcessSelection.Tests.ps1')]);
  const result = JSON.parse(stdout);
  assert.equal(result.passed, 17);
  assert.deepEqual(result.selected, [12, 30, 32, 33, 40]);
  assert.deepEqual(result.insidersSelected, [212, 231, 232]);
});

test('ordinary terminals are measured without activating Microsoft PowerShell', async () => {
  const vscode = { window: { terminals: [terminal(10)] } };
  let request;
  const observer = new WindowProcessObserver(vscode, { hostPid: 42, editorExecutable: 'C:\\Code.exe', collectorExecutable: 'pwsh',
    resolveEditor: async () => ({ state: 'waiting' }),
    collect: async (_exe, input) => { request = input; return inventory([sample(10), sample(11, 10)]); } });
  const result = await observer.observe(1000);
  assert.deepEqual(request.rootProcessIds, [42, 10]);
  assert.equal(request.hostProcessId, 42);
  assert.equal(result.inventory.processes[0].kind, 'terminal');
  assert.equal(result.inventory.processes[1].kind, 'child');
  assert.equal(result.inventory.complete, true);
  assert.equal(result.sample, null);
});

test('unqualified Editor Services does not block ordinary process measurements or authorize restart', async () => {
  const vscode = { window: { terminals: [terminal(10)] } };
  const observer = new WindowProcessObserver(vscode, { hostPid: 42, collectorExecutable: 'pwsh',
    resolveEditor: async () => { const error = new Error(); error.code = 'unsupported'; throw error; },
    collect: async () => inventory([sample(10)]) });
  const result = await observer.observe(1000);
  assert.equal(result.inventory.editorIssue, 'unsupported');
  assert.equal(result.inventory.processes[0].automaticRestart, false);
  assert.equal(result.inventory.complete, true);
});

test('only independently verified Editor Services is exposed as the restart target', async () => {
  const item = terminal(10);
  const editor = { pid: 10, terminal: item };
  const observer = new WindowProcessObserver({ window: { terminals: [item] } }, { hostPid: 42, collectorExecutable: 'pwsh',
    editorExecutable: 'C:\\Insiders\\Code - Insiders.exe',
    resolveEditor: async () => editor,
    collect: async () => ({ ...inventory([sample(10), sample(11, 10)]), editorVerified: true }) });
  const result = await observer.observe(1000);
  assert.equal(result.target, editor);
  assert.equal(result.sample.pid, 10);
  assert.equal(result.inventory.processes.filter((process) => process.automaticRestart).length, 1);
});

test('Stable and Insiders retain restart support using their explicit host identity and executable', async () => {
  for (const editorExecutable of ['C:\\Code\\Code.exe', 'C:\\Insiders\\Code - Insiders.exe']) {
    const item = terminal(10);
    const observer = new WindowProcessObserver({ window: { terminals: [item] } }, { hostPid: 42, collectorExecutable: 'pwsh',
      editorExecutable, resolveEditor: async () => ({ pid: 10, terminal: item }),
      collect: async (_exe, request) => {
        assert.equal(request.hostProcessId, 42);
        assert.equal(request.editorExecutable, editorExecutable);
        return { ...inventory([sample(10)]), editorVerified: true };
      } });
    const result = await observer.observe(1000);
    assert.equal(result.sample.pid, 10);
    assert.equal(result.inventory.processes[0].automaticRestart, true);
    assert.equal(result.inventory.editorIssue, null);
  }
});

test('an Editor Services terminal removed during collection cannot authorize restart', async () => {
  const item = terminal(10);
  const vscode = { window: { terminals: [item] } };
  const observer = new WindowProcessObserver(vscode, { hostPid: 42, collectorExecutable: 'pwsh',
    editorExecutable: 'C:\\Insiders\\Code - Insiders.exe', resolveEditor: async () => ({ pid: 10, terminal: item }),
    collect: async () => { vscode.window.terminals = []; return { ...inventory([sample(10)]), editorVerified: true }; } });
  assert.equal((await observer.observe(1000)).sample, null);
});

test('unresolved terminal PIDs produce explicit partial inventory without blocking resolved terminals', async () => {
  const observer = new WindowProcessObserver({ window: { terminals: [terminal(10), { processId: new Promise(() => {}), creationOptions: {} }] } },
    { hostPid: 42, collectorExecutable: 'pwsh', resolveEditor: async () => ({ state: 'waiting' }), collect: async () => inventory([sample(10)]) });
  const result = await observer.observe(100);
  assert.equal(result.inventory.processes.length, 1);
  assert.equal(result.inventory.unresolvedTerminals, 1);
  assert.equal(result.inventory.complete, false);
});

test('unverified ownership and unavailable processes keep known measurements explicitly partial', async () => {
  const observer = new WindowProcessObserver({ window: { terminals: [terminal(10), terminal(11)] } },
    { hostPid: 42, collectorExecutable: 'pwsh', resolveEditor: async () => ({ state: 'waiting' }),
      collect: async () => ({ ...inventory([sample(10)]), errors: [{ pid: 11, code: 'ownershipUnverified' }] }) });
  const result = await observer.observe(1000);
  assert.equal(result.inventory.processes.length, 1);
  assert.equal(result.inventory.complete, false);
  assert.equal(result.inventory.errors[0].pid, 11);
});

test('a terminal closed while its PID was resolving cannot become an ownership root', async () => {
  const vscode = { window: { terminals: [] } };
  const item = terminal(10);
  item.processId = Promise.resolve().then(() => { vscode.window.terminals = []; return 10; });
  vscode.window.terminals = [item];
  const observer = new WindowProcessObserver(vscode, { hostPid: 42, collectorExecutable: 'pwsh',
    resolveEditor: async () => ({ state: 'waiting' }), collect: async (_exe, request) => {
      assert.deepEqual(request.rootProcessIds, [42]); return inventory();
    } });
  await observer.observe(1000);
});

test('invalid or unknown memory is rejected rather than interpreted as zero', () => {
  assert.equal(validSample(sample(10)), true);
  for (const invalid of [{ privateBytes: null }, { privateBytes: -1 }, { workingSetBytes: NaN }, { pid: 0 }, { createdAt: 'unknown' }]) {
    assert.equal(validSample({ ...sample(10), ...invalid }), false);
  }
});

test('terminal navigation uses normalized creation identity and refuses closed or stale terminals', async () => {
  let shown = 0; const item = { ...terminal(10), name: 'A terminal', show() { shown++; } };
  const vscode = { window: { terminals: [item] } };
  const observer = new WindowProcessObserver(vscode, { hostPid: 42, collectorExecutable: 'pwsh',
    resolveEditor: async () => ({ state: 'waiting' }),
    collect: async () => inventory([{ ...sample(10), createdAt: '2026-10-29T00:00:00.1234567Z', cpuTimeMs: -1, threadCount: null, handleCount: 25 }]) });
  const result = await observer.observe(1000);
  assert.equal(result.inventory.processes[0].cpuTimeMs, null); assert.equal(result.inventory.processes[0].handleCount, 25);
  assert.equal(observer.showTerminal('10:2026-10-29T00:00:00.123Z'), true); assert.equal(shown, 1);
  assert.equal(observer.showTerminal('10:2026-10-29T01:00:00.123Z'), false);
  item.exitStatus = { code: 0 }; assert.equal(observer.showTerminal('10:2026-10-29T00:00:00.123Z'), false);
});
