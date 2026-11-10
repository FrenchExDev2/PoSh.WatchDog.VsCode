'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');
const { WatchdogController } = require('../src/controller');
const { GiB } = require('../src/policy');

/** Activate the real command registrations with an isolated VS Code API and no background timers. */
async function fixture(enabled = true, delayedConfiguration = false, options = {}) {
  const settings = { ...(options.settings || {}) };
  const legacySettings = { ...(options.legacy || {}) };
  const globalValues = new Map(Object.entries(options.globalState || {}));
  const messages = [];
  const logs = [];
  const commands = new Map();
  const observed = {};
  let configurationChanged;
  let stored;
  let collections = 0;
  let memoryBytes = GiB;
  let measuredAt = '2026-11-04T04:00:00Z';
  let intervals = 0;
  const animationTimers = new Map();
  let nextTimer = 0;
  const statusWrites = { text: 0, tooltip: 0, backgroundColor: 0 };
  const errors = [];
  let input;
  const status = new Proxy({ show() {}, dispose() {} }, { set(target, key, value) {
    if (Object.hasOwn(statusWrites, key)) statusWrites[key]++;
    target[key] = value; return true;
  } });
  const configuration = {
    inspect: (key) => ({ globalValue: key === 'enabled' ? enabled : settings[key] }),
    async update(key, value) {
      if (key === 'enabled') enabled = value; else settings[key] = value;
      if (!delayedConfiguration) configurationChanged({ affectsConfiguration: () => true });
    },
  };
  const legacyConfiguration = { inspect: (key) => ({ globalValue: legacySettings[key] }), async update() { throw new Error('legacy settings are read-only'); } };
  const disposable = () => ({ dispose() {} });
  const vscode = {
    StatusBarAlignment: { Right: 1 }, ThemeColor: class { constructor(id) { this.id = id; } }, ConfigurationTarget: { Global: 1 }, UIKind: { Desktop: 1 },
    env: { uiKind: 1 }, debug: { onDidStartDebugSession: disposable, onDidTerminateDebugSession: disposable },
    window: { createStatusBarItem: () => status,
      createOutputChannel: () => ({ error: (message) => errors.push(message), warn: (message) => logs.push(message), info: (message) => logs.push(message), dispose() {} }),
      showInputBox: async (options) => { input = options; },
      showQuickPick: async (items) => { if (options.pick) return (await items)[0]; throw new Error('fixture action failure'); },
      showErrorMessage: () => Promise.resolve(),
      showInformationMessage: (message) => { messages.push(message); return Promise.resolve(options.answer); },
      showWarningMessage: (message) => { messages.push(message); return Promise.resolve(options.answer); } },
    workspace: { getConfiguration: (name) => name === 'frenchexdev.powershellWatchdog' ? legacyConfiguration : configuration,
      isTrusted: options.trusted ?? true, workspaceFolders: (options.workspaceFolders || []).map((fsPath) => ({ uri: { scheme: 'file', fsPath } })),
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
      setTargets(list) { observed.targets = list; }
      async observe() {
        collections++;
        if (options.observe) await options.observe();
        return { target: { state: 'waiting' }, sample: null, inventory: { complete: true, errors: [], measuredAt,
          processes: [{ pid: 42, createdAt: '2026-11-02T10:00:00Z', privateBytes: memoryBytes,
            workingSetBytes: GiB, measuredAt, kind: 'terminal' }] } };
      }
    } },
    './controller': { WatchdogController: class extends WatchdogController { start() {} } },
    './dashboard': { createDashboard: () => ({ update() {}, dispose() {} }) },
    './report-panel': { createReportPanel: disposable },
  };
  const context = { subscriptions: [], globalStorageUri: { fsPath: 'unused' }, extensionPath: require('node:path').join(__dirname, '..'),
    globalState: { get: (key, fallback) => (globalValues.has(key) ? globalValues.get(key) : fallback), update: async (key, value) => { globalValues.set(key, value); } },
    workspaceState: {
      get: () => ({ suspendedReason: 'Restart expired; resume explicitly after checking the session.', suspendUntil: Date.now() + 900000 }),
      update: async (_key, value) => { stored = structuredClone(value); },
    },
  };
  const source = await fs.readFile(require.resolve('../src/extension'), 'utf8');
  const sandbox = { module: { exports: {} }, process, setTimeout, clearTimeout, __dirname: require('node:path').join(__dirname, '..', 'src'),
    require: (name) => dependencies[name] || require(name.startsWith('./') ? `../src/${name.slice(2)}` : name),
    setInterval: (callback) => { intervals++; animationTimers.set(++nextTimer, callback); return nextTimer; },
    clearInterval: (id) => { if (animationTimers.delete(id)) intervals--; } };
  vm.runInNewContext(source, sandbox, { filename: 'extension.js' });
  const api = await sandbox.module.exports.activate(context);
  return { api, journal, commands, observed, messages, logs, globalValues, settings, status, statusWrites, errors, input: () => input, intervals: () => intervals,
    animate: () => { for (const callback of animationTimers.values()) callback(); },
    setMeasurement: (bytes, at) => { memoryBytes = bytes; measuredAt = at; }, stored: () => stored, collections: () => collections,
    dispose: () => context.subscriptions.forEach((item) => item.dispose()) };
}

test('command failures retain their original details in the output channel', async (t) => {
  const f = await fixture(); t.after(f.dispose);
  await f.commands.get('memoryWatchdog.changeMode')();
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /Command changeMode:.*fixture action failure/s);
});

test('suspension validation explains the exclusive lower and inclusive upper bounds', async (t) => {
  const f = await fixture(); t.after(f.dispose);
  await f.commands.get('memoryWatchdog.suspend')();
  const validate = f.input().validateInput;
  for (const value of ['', '0', '-1', '10081', 'NaN']) assert.match(validate(value), /greater than 0 and at most 10080/);
  for (const value of ['0.5', '1', '10080']) assert.equal(validate(value), null);
});

test('unchanged observations animate text only during collection and leave no idle timer', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  await f.commands.get('memoryWatchdog.enable')();
  const before = { ...f.statusWrites };
  await f.api.sampleNow(); await f.api.sampleNow();
  assert.equal(f.statusWrites.text, before.text);
  assert.equal(f.statusWrites.tooltip, before.tooltip);
  assert.equal(f.statusWrites.backgroundColor, before.backgroundColor);
  assert.equal(f.intervals(), 0);
});

test('a changed measurement still updates the hover and status through the collection callback', async (t) => {
  const f = await fixture();
  t.after(f.dispose);
  await f.commands.get('memoryWatchdog.enable')();
  const before = { ...f.statusWrites };
  f.setMeasurement(GiB / 2, '2026-11-04T04:00:15Z');
  await f.api.sampleNow();
  assert.equal(f.statusWrites.tooltip, before.tooltip + 1);
  assert.equal(f.statusWrites.text, before.text + 1);
  assert.equal(f.statusWrites.backgroundColor, before.backgroundColor);
});

for (const fails of [false, true]) {
  test(`the spinner follows the real collection lifecycle (failure=${fails})`, async (t) => {
    let finish;
    const f = await fixture(true, false, { observe: () => new Promise((resolve, reject) => {
      finish = () => fails ? reject(new Error('collection failed')) : resolve();
    }) });
    t.after(f.dispose);
    const collection = f.commands.get('memoryWatchdog.enable')();
    while (!finish) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.intervals(), 1);
    assert.match(f.status.text, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    const before = { ...f.statusWrites };
    const text = f.status.text;
    f.animate();
    assert.notEqual(f.status.text, text);
    assert.equal(f.statusWrites.tooltip, before.tooltip);
    const pose = f.status.text.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)[0];
    finish(); await collection;
    assert.equal(f.intervals(), 0);
    assert.equal(f.api.getSnapshot().health.collecting, false);
    assert.ok(f.status.text.includes(pose), 'the last pose stays visible after collection');
    if (fails) assert.match(f.status.text, /Measurement unavailable/);
    else assert.match(f.status.text, /1 proc.*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/);
  });
}

for (const command of ['enable', 'resume']) {
  for (const enabled of [true, false]) {
    test(`${command} clears persisted suspension and collects immediately when enabled=${enabled}`, async (t) => {
      const f = await fixture(enabled, !enabled);
      t.after(f.dispose);
      await f.commands.get(`memoryWatchdog.${command}`)();
      assert.equal(f.api.getSnapshot().state, 'normal');
      assert.equal(f.collections(), 1);
      assert.equal(f.stored().suspendedReason, null);
      assert.equal(f.stored().suspendUntil, 0);
      assert.equal(f.api.getSnapshot().processes.length, 1);
    });
  }
}

const os = require('node:os');
const path = require('node:path');
async function configFolder(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-ext-'));
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, `${name}.watchdog.json`), JSON.stringify(content));
  return dir;
}
const userConfig = (name, extra = {}) => ({ schemaVersion: 1, name, label: name, match: { processNames: ['node'], ownership: 'child' },
  thresholds: { warningPrivateGiB: 1, actionPrivateGiB: 2 }, action: { mode: 'automatic', restartCommand: 'my.restart' }, ...extra });

test('zero configuration monitors the built-in default profile like 0.5.x', async (t) => {
  const f = await fixture(true, false, { globalState: { 'memoryWatchdog.migration': 'done' } }); t.after(f.dispose);
  const configs = f.api.getSnapshot().configs;
  assert.equal(configs.profile, 'default');
  assert.equal(f.observed.targets.map((target) => target.name).join(), 'pwsh-editor-services,pwsh-terminals,pwsh-children');
  assert.equal(f.observed.targets[0].command, undefined, 'the adapter command is never handed to the collector');
  assert.equal(configs.configs.find((item) => item.name === 'pwsh-editor-services').automatic, true);
  assert.equal(f.api.getSnapshot().mode, 'automatic');
  assert.equal(configs.errors, 0);
});

test('a user restart command stays notify-only until approved, and an edit requires a new approval', async (t) => {
  const dir = await configFolder({ build: userConfig('build') });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const f = await fixture(true, false, { settings: { configPaths: [dir], profiles: { work: ['build'] }, activeProfile: 'work' }, answer: 'Approve', pick: true,
    globalState: { 'memoryWatchdog.migration': 'done' } });
  t.after(f.dispose);
  let item = f.api.getSnapshot().configs.configs.find((config) => config.name === 'build');
  assert.deepEqual([item.automatic, item.needsApproval], [false, true]);
  assert.ok(f.messages.some((message) => /wants to run my\.restart automatically/.test(message)), JSON.stringify([f.messages, f.logs]));
  assert.equal(f.api.getSnapshot().configs.pendingApprovals, 1);
  await f.api.reloadConfigs();
  await f.commands.get('memoryWatchdog.approveConfig')();
  item = f.api.getSnapshot().configs.configs.find((config) => config.name === 'build');
  assert.deepEqual([item.automatic, item.needsApproval], [true, false]);
  await fs.writeFile(path.join(dir, 'build.watchdog.json'), JSON.stringify(userConfig('build', { label: 'edited' })));
  await f.api.reloadConfigs();
  item = f.api.getSnapshot().configs.configs.find((config) => config.name === 'build');
  assert.deepEqual([item.automatic, item.needsApproval], [false, true]);
});

test('approved configs inside an untrusted workspace stay notify-only', async (t) => {
  const dir = await configFolder({ build: userConfig('build') });
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = await fixture(true, false, { settings: { configPaths: [dir], profiles: { work: ['build'] }, activeProfile: 'work' }, answer: 'Approve', pick: true,
    workspaceFolders: [dir], trusted: false, globalState: { 'memoryWatchdog.migration': 'done' } });
  t.after(first.dispose);
  await first.commands.get('memoryWatchdog.approveConfig')();
  const item = first.api.getSnapshot().configs.configs.find((config) => config.name === 'build');
  assert.equal(item.needsApproval, false);
  assert.equal(item.automatic, false);
  assert.deepEqual(item.blockedBy, ['config is in an untrusted workspace']);
});

test('an unknown active profile falls back to default with automatic actions off, and bad paths are reported', async (t) => {
  const f = await fixture(true, false, { settings: { activeProfile: 'typo', configPaths: ['relative/dir', '${workspaceFolder}/x'] }, globalState: { 'memoryWatchdog.migration': 'done' } });
  t.after(f.dispose);
  const configs = f.api.getSnapshot().configs;
  assert.deepEqual([configs.profile, configs.fallback], ['default', true]);
  assert.equal(f.api.getSnapshot().mode, 'notifyOnly');
  assert.equal(configs.issues.filter((issue) => issue.file === 'relative/dir' || issue.file === '${workspaceFolder}/x').length, 2);
  assert.ok(configs.errors >= 3);
});

test('0.5.x command ids remain callable aliases and the old notifyOnly mode is honored before migration', async (t) => {
  const f = await fixture(true, false, { legacy: { mode: 'notifyOnly' } });
  t.after(f.dispose);
  assert.equal(f.api.getSnapshot().mode, 'notifyOnly');
  assert.ok(f.messages.some((message) => /Migrate your 0\.5\.x settings/.test(message)));
  for (const name of ['enable', 'menu', 'selectProfile', 'restart']) assert.ok(f.commands.has(`powershellWatchdog.${name}`), name);
  await f.commands.get('powershellWatchdog.suspend')();
  assert.match(f.input().prompt, /Suspend monitoring/);
});

test('migration writes overriding configs, approves them and moves globals to the new section', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-home-'));
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = home; process.env.USERPROFILE = home;
  t.after(async () => { Object.assign(process.env, previous); await fs.rm(home, { recursive: true, force: true }); });
  const f = await fixture(true, false, { legacy: { restartPrivateGiB: 6, profile: 'tests', cooldownSeconds: 300 }, answer: 'Migrate' });
  t.after(f.dispose);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const dir = path.join(home, '.frenchexdev', 'memory-watchdog');
  const files = (await fs.readdir(dir)).sort();
  assert.deepEqual(files, ['pwsh-children.watchdog.json', 'pwsh-editor-services.watchdog.json', 'pwsh-terminals.watchdog.json']);
  assert.equal(f.settings.workload, 'tests');
  assert.equal(f.globalValues.get('memoryWatchdog.migration'), 'done');
  const pses = f.api.getSnapshot().configs.configs.find((config) => config.name === 'pwsh-editor-services');
  assert.deepEqual([pses.builtin, pses.automatic, pses.needsApproval], [false, true, false]);
  assert.equal(f.api.getSnapshot().policy.cooldownSeconds, 300);
  assert.equal(f.api.getSnapshot().policy.restartPrivateGiB, 6);
});
