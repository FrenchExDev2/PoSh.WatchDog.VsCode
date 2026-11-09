'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');
const { WatchdogController } = require('../src/controller');
const { defaults, GiB } = require('../src/policy');

/** Activate the real command registrations with an isolated VS Code API and no background timers. */
async function fixture(enabled = true, delayedConfiguration = false) {
  const commands = new Map();
  let configurationChanged;
  let stored;
  let collections = 0;
  let memoryBytes = GiB;
  let measuredAt = '2026-11-04T04:00:00Z';
  let intervals = 0;
  const statusWrites = { text: 0, tooltip: 0, backgroundColor: 0 };
  const errors = [];
  let input;
  const status = new Proxy({ show() {}, dispose() {} }, { set(target, key, value) {
    if (Object.hasOwn(statusWrites, key)) statusWrites[key]++;
    target[key] = value; return true;
  } });
  const configuration = {
    inspect: (key) => ({ globalValue: key === 'enabled' ? enabled : defaults[key] }),
    async update(key, value) {
      assert.equal(key, 'enabled'); enabled = value;
      if (!delayedConfiguration) configurationChanged({ affectsConfiguration: () => true });
    },
  };
  const disposable = () => ({ dispose() {} });
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ConfigurationTarget: { Global: 1 }, UIKind: { Desktop: 1 },
    env: { uiKind: 1 }, debug: { onDidStartDebugSession: disposable, onDidTerminateDebugSession: disposable },
    window: { createStatusBarItem: () => status,
      createOutputChannel: () => ({ error: (message) => errors.push(message), dispose() {} }),
      showInputBox: async (options) => { input = options; },
      showQuickPick: async () => { throw new Error('fixture action failure'); },
      showErrorMessage: () => Promise.resolve() },
    workspace: { getConfiguration: () => configuration,
      onDidChangeConfiguration: (callback) => { configurationChanged = callback; return disposable(); } },
    commands: { registerCommand: (name, callback) => { commands.set(name, callback); return disposable(); } },
  };
  const journal = { ready: Promise.resolve(), error: null, history: [],
    append: async (entry) => { journal.history.push(entry); }, configure() {} };
  const dependencies = {
    vscode,
    './history': { PersistentJournal: function () { return journal; } },
    './activity': { ActivityTracker: class { get() { return { state: 'unknown' }; } dispose() {} } },
    './observer': { WindowProcessObserver: class {
      async observe() {
        collections++;
        return { target: { state: 'waiting' }, sample: null, inventory: { complete: true, errors: [], measuredAt,
          processes: [{ pid: 42, createdAt: '2026-11-02T10:00:00Z', privateBytes: memoryBytes,
            workingSetBytes: GiB, measuredAt, kind: 'terminal' }] } };
      }
    } },
    './controller': { WatchdogController: class extends WatchdogController { start() {} } },
    './dashboard': { createDashboard: () => ({ update() {}, dispose() {} }) },
    './report-panel': { createReportPanel: disposable },
  };
  const context = { subscriptions: [], globalStorageUri: { fsPath: 'unused' },
    workspaceState: {
      get: () => ({ suspendedReason: 'Restart expired; resume explicitly after checking the session.', suspendUntil: Date.now() + 900000 }),
      update: async (_key, value) => { stored = structuredClone(value); },
    },
  };
  const source = await fs.readFile(require.resolve('../src/extension'), 'utf8');
  const sandbox = { module: { exports: {} }, process,
    require: (name) => dependencies[name] || require(name.startsWith('./') ? `../src/${name.slice(2)}` : name),
    setInterval: () => { intervals++; return 1; }, clearInterval() {} };
  vm.runInNewContext(source, sandbox, { filename: 'extension.js' });
  const api = await sandbox.module.exports.activate(context);
  return { api, journal, commands, statusWrites, errors, input: () => input, intervals: () => intervals,
    setMeasurement: (bytes, at) => { memoryBytes = bytes; measuredAt = at; }, stored: () => stored, collections: () => collections,
    dispose: () => context.subscriptions.forEach((item) => item.dispose()) };
}

test('command failures retain their original details in the output channel', async (t) => {
  const f = await fixture(); t.after(f.dispose);
  await f.commands.get('powershellWatchdog.changeMode')();
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /Command changeMode:.*fixture action failure/s);
});

test('suspension validation explains the exclusive lower and inclusive upper bounds', async (t) => {
  const f = await fixture(); t.after(f.dispose);
  await f.commands.get('powershellWatchdog.suspend')();
  const validate = f.input().validateInput;
  for (const value of ['', '0', '-1', '10081', 'NaN']) assert.match(validate(value), /greater than 0 and at most 10080/);
  for (const value of ['0.5', '1', '10080']) assert.equal(validate(value), null);
});

test('unchanged observations do not reassign the native tooltip or status, and no age timer runs', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  await f.commands.get('powershellWatchdog.enable')();
  const before = { ...f.statusWrites };
  await f.api.sampleNow(); await f.api.sampleNow();
  assert.deepEqual(f.statusWrites, before);
  assert.equal(f.intervals(), 0);
});

test('a changed measurement still updates the hover and status through the collection callback', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  await f.commands.get('powershellWatchdog.enable')();
  const before = { ...f.statusWrites };
  f.setMeasurement(GiB / 2, '2026-11-04T04:00:15Z');
  await f.api.sampleNow();
  assert.equal(f.statusWrites.tooltip, before.tooltip + 1);
  assert.equal(f.statusWrites.text, before.text + 1);
  assert.equal(f.statusWrites.backgroundColor, before.backgroundColor);
});

for (const command of ['enable', 'resume']) {
  for (const enabled of [true, false]) {
    test(`${command} clears persisted suspension and collects immediately when enabled=${enabled}`, async (t) => {
      const f = await fixture(enabled, !enabled);
      t.after(f.dispose);
      await f.commands.get(`powershellWatchdog.${command}`)();
      assert.equal(f.api.getSnapshot().state, 'normal');
      assert.equal(f.collections(), 1);
      assert.equal(f.stored().suspendedReason, null);
      assert.equal(f.stored().suspendUntil, 0);
      assert.equal(f.api.getSnapshot().processes.length, 1);
    });
  }
}
