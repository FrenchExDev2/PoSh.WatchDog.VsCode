'use strict';

// Objective: the dashboard and report charts use one tested axis computation, so small processes are not
// flattened by distant thresholds, units stay binary (1024) and every tick lies exactly on the plotted scale.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createChartTools } = require('../src/report-chart');
const { TrendTracker } = require('../src/trends');
const { WatchdogController } = require('../src/controller');
const { dashboardModel } = require('../src/dashboard');
const { buildReportModel } = require('../src/diagnostics-report');
const { globalPolicy } = require('../src/configuration');
const { targetPolicy } = require('../src/targets');
const { defaults } = require('../src/policy');

const { memoryScale, scaleTop, formatBytes } = createChartTools();
const MiB = 1024 ** 2; const GiB = 1024 ** 3;

test('memory axis uses MiB below 1 GiB, GiB above, round steps and a ceiling covering the peak', () => {
  for (const [bytes, unit, labels] of [
    [53 * MiB, 'MiB', ['0 MiB', '20 MiB', '40 MiB', '60 MiB']],
    [0.375 * GiB, 'MiB', ['0 MiB', '100 MiB', '200 MiB', '300 MiB', '400 MiB']],
    [1000 * MiB, 'MiB', ['0 MiB', '250 MiB', '500 MiB', '750 MiB', '1000 MiB']],
    [2 * GiB, 'GiB', ['0 GiB', '0.5 GiB', '1 GiB', '1.5 GiB', '2 GiB']],
    [9 * GiB, 'GiB', ['0 GiB', '2.5 GiB', '5 GiB', '7.5 GiB', '10 GiB']],
    [16 * GiB, 'GiB', ['0 GiB', '4 GiB', '8 GiB', '12 GiB', '16 GiB']],
    [32 * GiB, 'GiB', ['0 GiB', '10 GiB', '20 GiB', '30 GiB', '40 GiB']]]) {
    const scale = memoryScale(bytes);
    assert.equal(scale.unit, unit, `${bytes}`);
    assert.deepEqual(scale.ticks.map((tick) => tick.label), labels, `${bytes}`);
    assert.ok(scale.ceilingBytes >= bytes, 'the ceiling covers the peak');
    assert.equal(scale.ticks.at(-1).bytes, scale.ceilingBytes, 'the last tick is the ceiling');
    assert.ok(scale.ticks.length >= 2 && scale.ticks.length <= 6);
    for (const [index, tick] of scale.ticks.entries()) assert.ok(Math.abs(tick.bytes - index * scale.stepBytes) < 1, 'ticks are exact multiples of the step');
  }
});

test('memory axis never divides by zero for empty, zero, negative or non-finite peaks', () => {
  for (const bytes of [0, -5, null, undefined, NaN, Infinity]) {
    const scale = memoryScale(bytes);
    assert.ok(Number.isFinite(scale.ceilingBytes) && scale.ceilingBytes > 0, String(bytes));
    assert.equal(scale.ticks[0].label, '0 MiB');
    assert.ok(scale.ticks.every((tick) => Number.isFinite(tick.bytes)));
  }
});

test('only thresholds within twice the observed peak widen the scale', () => {
  assert.equal(scaleTop(53 * MiB, [6 * GiB, 12 * GiB]), 53 * MiB, 'a 50 MiB shell is not drawn against a 12 GiB axis');
  assert.equal(scaleTop(3 * GiB, [4 * GiB, 8 * GiB]), 4 * GiB, 'a near threshold stays visible');
  assert.equal(scaleTop(5 * GiB, [4 * GiB, 8 * GiB, NaN, -1]), 8 * GiB);
  assert.equal(scaleTop(0, [4 * GiB]), 0, 'no data: thresholds alone do not define the scale');
});

test('memory values use binary units and never print NaN', () => {
  assert.equal(formatBytes(53 * MiB), '53 MiB');
  assert.equal(formatBytes(1.5 * GiB), '1.50 GiB');
  assert.equal(formatBytes(9 * GiB), '9.00 GiB');
  assert.equal(formatBytes(null), '—');
  assert.equal(formatBytes(NaN, 'Unknown'), 'Unknown');
});

test('growth of a process whose memory became unknown is unknown, not a drop to zero', () => {
  const tracker = new TrendTracker();
  const policy = { ...defaults, growthWindowSeconds: 1, growthWarningMiB: 1 };
  const sample = (bytes) => ({ pid: 5, createdAt: '2026-11-09T09:00:00Z', privateBytes: bytes, cpuTimeMs: 100 });
  tracker.update([sample(2 * GiB)], policy, 1_000);
  const unknown = sample(null);
  tracker.update([unknown], policy, 16_000);
  assert.equal(unknown.growth.deltaMiB, null);
  assert.equal(unknown.growth.rateMiBPerMinute, null);
  assert.equal(unknown.growth.warning, false);
  assert.equal(unknown.cpuPercent, 0, 'CPU % = CPU ms delta / elapsed ms × 100');
});

test('a target that ignores the workload still reports the selected workload to the dashboard and the journal', async () => {
  const globals = globalPolicy({ ...defaults, workload: 'build', mode: 'automatic' });
  const entry = { name: 'pwsh-editor-services', file: '/x/pwsh-editor-services.watchdog.json', builtin: true, hash: 'h', scaleWithWorkload: false,
    config: { scaleWithWorkload: false, thresholds: { warningPrivateGiB: 3, actionPrivateGiB: 5, consecutiveSamples: 3, growthWarningMiB: 512, growthWindowSeconds: 300 },
      action: { mode: 'notifyOnly', restartCommand: null, deferWhileDebugging: [], graceSeconds: 30, cooldownSeconds: 600, maxPerHour: 2, timeoutSeconds: 120, deferWhileRunningCommands: true, requireKnownIdle: false } } };
  const { policy } = targetPolicy(entry, globals, {});
  assert.equal(policy.profile, 'development', 'absolute thresholds are not multiplied');
  assert.equal(policy.workload, 'build');
  const journal = { history: [], append: async (item) => journal.history.push(item) };
  const controller = new WatchdogController({ observe: async () => ({ target: { state: 'waiting', detail: 'none' }, sample: null, inventory: null }),
    journal, commands: async () => [], restart: async () => {} }, policy);
  assert.equal(controller.snapshot().profile, 'build');
  assert.equal(dashboardModel(controller.snapshot()).profile, 'build');
  await controller.tick();
  assert.equal(journal.history.at(-1).profile, 'build');
  controller.dispose();
});

test('dashboard threshold lines follow each config: scaled per workload, or identical when scaleWithWorkload is false', () => {
  const model = dashboardModel({ configs: { profile: 'default', configs: [
    { name: 'tsserver', active: true, warningPrivateGiB: 2, actionPrivateGiB: 4, scaleWithWorkload: true },
    { name: 'fixed', active: true, warningPrivateGiB: 3, actionPrivateGiB: 5, scaleWithWorkload: false },
    { name: 'idle', active: false, warningPrivateGiB: 1, actionPrivateGiB: 2 }] } });
  const pick = (kind) => model.profileThresholds.filter((item) => item.kind === kind).map((item) => [item.profile, item.warningPrivateGiB, item.restartPrivateGiB]);
  assert.deepEqual(pick('tsserver'), [['development', 2, 4], ['tests', 3, 6], ['build', 4, 8]]);
  assert.deepEqual(pick('fixed'), [['development', 3, 5], ['tests', 3, 5], ['build', 3, 5]]);
  assert.deepEqual(pick('idle'), [], 'inactive configs draw nothing');
});

test('report series carry the target label used in the ranking and selector', () => {
  const at = '2026-11-09T09:00:00.000Z';
  const report = buildReportModel({ snapshot: { history: [{ at, state: 'normal', processes: [
    { pid: 9, createdAt: at, privateBytes: 3 * GiB, workingSetBytes: GiB, targetId: 'tsserver', targetLabel: 'TypeScript server' }] }] } });
  assert.equal(report.series[0].targetId, 'tsserver');
  assert.equal(report.series[0].targetLabel, 'TypeScript server');
});