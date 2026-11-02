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
    window: { createStatusBarItem: () => ({ show() {}, dispose() {} }),
      showErrorMessage: (message) => { throw new Error(message); } },
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
        return { target: { state: 'waiting' }, sample: null, inventory: { complete: true, errors: [],
          processes: [{ pid: 42, createdAt: '2026-11-02T10:00:00Z', privateBytes: GiB,
            workingSetBytes: GiB, measuredAt: new Date().toISOString(), kind: 'terminal' }] } };
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
    setInterval: () => 1, clearInterval() {} };
  vm.runInNewContext(source, sandbox, { filename: 'extension.js' });
  const api = await sandbox.module.exports.activate(context);
  return { api, journal, commands, stored: () => stored, collections: () => collections,
    dispose: () => context.subscriptions.forEach((item) => item.dispose()) };
}

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
