'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { defaults, GiB, processPolicy, validatePolicy, PolicyEngine } = require('../src/policy');
const { WatchdogController } = require('../src/controller');
const { ActivityTracker } = require('../src/activity');
const { TrendTracker } = require('../src/trends');
const { PersistentJournal, pruneReports } = require('../src/history');
const { dashboardModel, renderDashboardHtml, createDashboard } = require('../src/dashboard');

function setup(policy = {}, dependencies = {}) {
  let now = Date.now(); let pid = 1; let bytes = 9 * GiB; let requests = 0; let activity = 'idle';
  const terminal = {};
  const journal = { history: [], append: async (entry) => journal.history.push(entry) };
  const controller = new WatchdogController({ now: () => now, journal, debugging: () => false,
    activity: () => ({ state: activity, source: 'fixture' }),
    resolve: async () => ({ pid, terminal }), collect: async (target) => ({ pid: target.pid, createdAt: new Date(target.pid * 1000).toISOString(),
      measuredAt: new Date(now).toISOString(), privateBytes: bytes, workingSetBytes: GiB, kind: 'editorServices' }),
    commands: async () => ['PowerShell.RestartSession'], restart: async () => { requests++; pid++; }, ...dependencies,
  }, { ...defaults, consecutiveSamples: 1, sampleIntervalSeconds: 1, restartGraceSeconds: 3, ...policy });
  return { controller, terminal, requests: () => requests, advance: (ms) => { now += ms; }, memory: (value) => { bytes = value; },
    activity: (value) => { activity = value; }, pid: () => { pid++; } };
}

test('countdown expires only after fresh identity, threshold and command checks', async () => {
  const f = setup(); await f.controller.tick();
  assert.equal(f.controller.state, 'countdown'); assert.equal(f.requests(), 0);
  f.advance(2000); await f.controller.tick(); assert.equal(f.requests(), 0);
  f.advance(1000); await f.controller.tick(); assert.equal(f.requests(), 1);
  assert.equal(f.controller.restartOutcome, 'succeeded'); assert.equal(f.controller.restartIntent, null);
});

test('cancel blocks the current episode until memory falls below the threshold', async () => {
  const f = setup(); await f.controller.tick(); assert.equal(await f.controller.cancelRestart(), true);
  f.advance(4000); await f.controller.tick(); assert.equal(f.requests(), 0); assert.equal(f.controller.restartIntent, null);
  f.memory(GiB); f.advance(1000); await f.controller.tick();
  f.memory(9 * GiB); f.advance(1000); await f.controller.tick(); assert.ok(f.controller.restartIntent);
});

test('episode cancellation survives profile changes and reload while manual restart supersedes its countdown', async () => {
  let saved; const f = setup({}, { store: async (value) => { saved = structuredClone(value); } });
  await f.controller.tick(); await f.controller.cancelRestart();
  f.controller.configure({ ...f.controller.engine.policy, profile: 'tests' });
  assert.equal(f.controller.cancelledIdentity, saved.cancelledIdentity);
  const restored = new WatchdogController(f.controller.dependencies, { ...defaults, consecutiveSamples: 1 }, saved);
  await restored.tick(); assert.equal(restored.restartIntent, null); assert.equal(f.requests(), 0);
  const manual = setup(); await manual.controller.tick(); assert.ok(manual.controller.restartIntent);
  assert.equal(await manual.controller.manualRestart(), true); assert.equal(manual.controller.restartIntent, null); assert.equal(manual.requests(), 1);
});

test('postponement persists without suspending measurement, and restart now rechecks memory', async () => {
  let saved; const f = setup({}, { store: async (value) => { saved = structuredClone(value); } });
  await f.controller.tick(); await f.controller.postponeRestart(5);
  f.advance(4000); await f.controller.tick(); assert.equal(f.requests(), 0); assert.ok(saved.postponeUntil);
  assert.ok(f.controller.sample); assert.ok(f.controller.snapshot().health.automaticRestartBlockedBy.includes('restartPostponed'));
  f.advance(300000); await f.controller.tick(); assert.ok(f.controller.restartIntent);
  f.memory(GiB); await f.controller.restartNow(); assert.equal(f.requests(), 0); assert.equal(f.controller.restartIntent, null);
});

test('replacement PID, command activity and debugger changes invalidate a countdown', async () => {
  for (const change of ['identity', 'busy', 'debug']) {
    let debugging = false; const f = setup({}, { debugging: () => debugging });
    await f.controller.tick(); const deadline = f.controller.restartIntent.deadline;
    if (change === 'identity') f.pid();
    if (change === 'busy') { f.activity('busy'); f.controller.activityChanged(f.terminal); }
    if (change === 'debug') { debugging = true; f.controller.activityChanged(); }
    f.advance(3000); await f.controller.tick(); assert.equal(f.requests(), 0);
    if (change === 'identity') assert.ok(f.controller.restartIntent.deadline > deadline);
    else assert.equal(f.controller.restartIntent, null);
  }
});

test('cancellation during the final measurement prevents command dispatch', async () => {
  let release; let reached; let reads = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const waiting = new Promise((resolve) => { reached = resolve; });
  const f = setup({}, { collect: async (target) => {
    if (++reads === 3) { reached(); await gate; }
    return { pid: target.pid, createdAt: new Date(target.pid * 1000).toISOString(), privateBytes: 9 * GiB, measuredAt: new Date().toISOString() };
  } });
  await f.controller.tick(); f.advance(3000); const task = f.controller.tick();
  try { await waiting; assert.equal(await f.controller.cancelRestart(), true); release(); await task; assert.equal(f.requests(), 0); }
  finally { release(); await task; f.controller.dispose(); }
});

test('busy activity during durable quota persistence cancels dispatch without consuming quota', async () => {
  let changed = false; const f = setup({ restartGraceSeconds: 0 }, { store: async (value) => {
    if (!changed && value.restarts.length) { changed = true; f.activity('busy'); f.controller.activityChanged(f.terminal); }
  } });
  await f.controller.tick(); assert.equal(f.requests(), 0); assert.deepEqual(f.controller.engine.restarts, []);
});

test('strict idle requirement blocks unknown activity and health reports collection failures and recovery', async () => {
  const f = setup({ requireKnownIdle: true }); f.activity('unknown'); await f.controller.tick();
  assert.equal(f.controller.state, 'deferred'); assert.equal(f.requests(), 0);
  const original = f.controller.dependencies.collect;
  f.controller.dependencies.collect = async () => { throw new Error('private data'); };
  await f.controller.tick(); await f.controller.tick();
  assert.equal(f.controller.snapshot().health.consecutiveErrors, 2);
  assert.equal(f.controller.snapshot().health.lastError, 'collection');
  f.advance(30000); assert.equal(f.controller.snapshot().health.stale, true);
  f.controller.dependencies.collect = original; await f.controller.tick();
  assert.equal(f.controller.snapshot().health.consecutiveErrors, 0); assert.equal(f.controller.snapshot().health.stale, false);
});

test('profiles and absolute process overrides use separate effective thresholds once', () => {
  const policy = { ...defaults, profile: 'tests', processThresholds: { terminal: { warningPrivateGiB: 2, restartPrivateGiB: 3 }, child: { restartPrivateGiB: 9 } } };
  assert.equal(processPolicy(policy).restartPrivateGiB, 12);
  assert.equal(processPolicy(policy, 'terminal').restartPrivateGiB, 3);
  assert.equal(processPolicy(policy, 'child').warningPrivateGiB, 6);
  assert.deepEqual(validatePolicy(policy), []);
  const engine = new PolicyEngine(policy);
  assert.equal(engine.evaluate({ pid: 1, createdAt: 'same', kind: 'terminal', privateBytes: 2.5 * GiB }, 0).state, 'warning');
  assert.ok(validatePolicy({ ...policy, processThresholds: { child: { restartPrivateGiB: 5 } } }).length);
});

test('shell signals remain unknown until observed, track overlapping commands and never inspect their contents', () => {
  const listeners = {}; let disposed = 0; const changed = [];
  const window = {};
  for (const name of ['onDidStartTerminalShellExecution', 'onDidEndTerminalShellExecution', 'onDidCloseTerminal']) window[name] = (callback) => { listeners[name] = callback; return { dispose() { disposed++; } }; };
  const tracker = new ActivityTracker(window, (terminal) => changed.push(terminal));
  const terminal = { shellIntegration: {} }; const a = { get commandLine() { throw new Error('Must not read command text'); } }; const b = {};
  assert.equal(tracker.get(terminal).state, 'unknown');
  listeners.onDidStartTerminalShellExecution({ terminal, execution: a }); listeners.onDidStartTerminalShellExecution({ terminal, execution: b });
  listeners.onDidEndTerminalShellExecution({ terminal, execution: a }); assert.equal(tracker.get(terminal).state, 'busy');
  listeners.onDidEndTerminalShellExecution({ terminal, execution: b }); assert.equal(tracker.get(terminal).state, 'idle');
  delete terminal.shellIntegration; assert.equal(tracker.get(terminal).state, 'unknown');
  listeners.onDidCloseTerminal(terminal); assert.equal(tracker.entries.size, 0); assert.equal(changed.length, 5);
  tracker.dispose(); assert.equal(disposed, 3);
});

test('growth alert requires a full sustained window, deduplicates warnings, resets gaps and PID reuse; CPU is a delta', () => {
  const tracker = new TrendTracker(); const policy = { ...defaults, growthWindowSeconds: 60, sampleIntervalSeconds: 15 };
  const observe = (at, bytes, createdAt = 'same') => {
    const sample = { pid: 1, createdAt, privateBytes: bytes, cpuTimeMs: at / 2 }; tracker.update([sample], policy, at); return sample;
  };
  let sample;
  for (let index = 0; index <= 4; index++) sample = observe(index * 15000, (1000 + index * 150) * 1024 ** 2);
  assert.equal(sample.growth.warning, true); assert.equal(sample.growth.notify, true); assert.equal(sample.cpuPercent, 50);
  sample = observe(75000, 1800 * 1024 ** 2); assert.equal(sample.growth.notify, false);
  sample = observe(180000, 2500 * 1024 ** 2); assert.equal(sample.growth.warning, false); assert.equal(sample.cpuPercent, null);
  sample = observe(195000, 3000 * 1024 ** 2, 'new'); assert.equal(sample.growth.observedSeconds, 0);
  tracker.update([], policy, 210000); assert.equal(tracker.entries.size, 0);
});

test('fast sampling keeps full trend-window coverage while bounding stored observations', () => {
  const tracker = new TrendTracker(); const policy = { ...defaults, growthWindowSeconds: 1100, sampleIntervalSeconds: 1 };
  let sample;
  for (let index = 0; index <= 1100; index++) {
    sample = { pid: 1, createdAt: 'same', privateBytes: index * 1024 ** 2, cpuTimeMs: index * 500 };
    tracker.update([sample], policy, index * 1000);
  }
  assert.equal(sample.growth.warning, true); assert.equal(sample.growth.observedSeconds, 1100);
  assert.ok(tracker.entries.get('1:same').points.length <= 1024); assert.equal(sample.cpuPercent, 50);
});

async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-features-'));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}

test('persistent history reloads, preserves activation identity, bounds memory and skips corrupt or expired entries', async (t) => {
  const root = await directory(t); const now = Date.now();
  const first = new PersistentJournal(root, defaults, () => now); await first.ready;
  for (let i = 0; i < 205; i++) await first.append({ at: new Date(now + i).toISOString(), state: 'normal', decision: 'accents préservés' });
  assert.equal(first.history.length, 200);
  await fs.appendFile(first.filename, 'broken\n' + JSON.stringify({ at: new Date(now - 30 * 86400_000).toISOString() }) + '\n');
  const second = new PersistentJournal(root, defaults, () => now + 1000); await second.ready;
  assert.equal(second.history.length, 200); assert.equal(second.history.at(-1).sessionId, first.sessionId);
  const retained = await second.readRetainedHistory(); assert.equal(retained.entries.length, 205); assert.equal(retained.invalidLines, 1);
  await second.append({ at: new Date(now + 1000).toISOString(), state: 'waiting' });
  assert.notEqual(second.history.at(-1).sessionId, first.sessionId);
});

test('retention removes only owned files, enforces byte budget and recovers a deleted active segment', async (t) => {
  const root = await directory(t); const journal = new PersistentJournal(root, { ...defaults, historyMaxMiB: 1 }); await journal.ready;
  const unrelated = path.join(root, 'notes.jsonl'); await fs.writeFile(unrelated, 'keep');
  const old = path.join(root, `watchdog-history-1000000000000-${randomUUID()}.jsonl`); await fs.writeFile(old, '{}\n');
  await fs.utimes(old, new Date(0), new Date(0));
  for (let i = 0; i < 5; i++) await journal.append({ at: new Date().toISOString(), padding: 'x'.repeat(400000) });
  const files = await fs.readdir(root); let bytes = 0;
  for (const file of files.filter((f) => f.startsWith('watchdog-history-'))) bytes += (await fs.stat(path.join(root, file))).size;
  assert.ok(bytes <= 1024 ** 2); assert.equal(await fs.readFile(unrelated, 'utf8'), 'keep'); assert.ok(!files.includes(path.basename(old)));
  await fs.rm(journal.filename); await journal.append({ at: new Date().toISOString() }); assert.equal(journal.error, null);
});

test('HTML report cleanup applies age and combined size limits and rejects oversize reservations', async (t) => {
  const root = await directory(t); const owned = path.join(root, `watchdog-2026-11-02T00-00-00-000Z-${randomUUID()}.html`);
  const other = path.join(root, 'manual.html'); await fs.writeFile(other, 'keep'); await fs.writeFile(owned, 'x'.repeat(800000));
  await pruneReports(root, { ...defaults, reportMaxMiB: 1 }, 500000);
  await assert.rejects(fs.stat(owned), { code: 'ENOENT' }); assert.equal(await fs.readFile(other, 'utf8'), 'keep');
  await assert.rejects(pruneReports(root, { ...defaults, reportMaxMiB: 1 }, 2 * 1024 ** 2), /exceeds/);
});

test('dashboard excludes arbitrary properties and webview accepts only bounded allowlisted actions', async () => {
  const model = dashboardModel({ processes: [{ pid: 1, createdAt: new Date().toISOString(), privateBytes: GiB, commandLine: 'secret', terminalName: '</script><img src=x>' }] });
  assert.ok(!JSON.stringify(model).includes('secret'));
  const html = renderDashboardHtml(); assert.match(html, /default-src 'none'/); assert.ok(!html.includes('</script><img src=x>'));
  let provider; let receive; const calls = [];
  const vscode = { window: { registerWebviewViewProvider(_id, value) { provider = value; return { dispose() {} }; }, showErrorMessage() {} } };
  const dashboard = createDashboard(vscode, { getSnapshot: () => ({}), onAction: async (...args) => calls.push(args) });
  const view = { webview: { onDidReceiveMessage(callback) { receive = callback; return { dispose() {} }; }, postMessage: async () => true }, onDidDispose() {}, dispose() {} };
  provider.resolveWebviewView(view);
  for (const message of [{ action: 'executeCommand', command: 'evil' }, { action: 'profile', profile: 'evil' }, { action: 'showTerminal', identity: '../escape' }]) await receive(message);
  assert.deepEqual(calls, []);
  await receive({ action: 'profile', profile: 'tests' }); await receive({ action: 'cancelRestart' });
  assert.deepEqual(calls, [['profile', 'tests'], ['cancelRestart']]); assert.deepEqual(view.webview.options.localResourceRoots, []);
  dashboard.dispose();
});
