'use strict';

// Objective: report and trend statistics equal values computed by hand, including irregular sampling,
// interleaved sessions, rounding boundaries, rolling windows and workload multipliers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildReportModel } = require('../src/diagnostics-report');
const { createChartTools } = require('../src/report-chart');
const { TrendTracker } = require('../src/trends');
const { WatchdogController } = require('../src/controller');
const { defaults, processPolicy } = require('../src/policy');

const MiB = 1024 ** 2; const GiB = 1024 ** 3;
const t0 = Date.parse('2026-11-09T09:00:00.000Z');
const createdAt = '2026-11-09T08:00:00.000Z';
const proc = (pid, privateBytes, extra = {}) => ({ pid, createdAt, measuredAt: createdAt, kind: 'terminal', privateBytes, workingSetBytes: privateBytes === null ? null : privateBytes / 2, ...extra });
const entry = (seconds, sessionId, processes, extra = {}) => ({ at: new Date(t0 + seconds * 1000).toISOString(), state: 'normal', decision: 'Measured.', sessionId, processes, complete: true, ...extra });
const tools = createChartTools();

test('median: odd count takes the middle, even count the mean of the two middle values', () => {
  assert.equal(tools.median([30, 10, 20]), 20);
  assert.equal(tools.median([15, 300, 15, 300]), 157.5, 'not the upper middle value 300');
  assert.equal(tools.median([]), null);
  assert.equal(tools.median([NaN, 4]), 4);
});

test('cadence is inferred per session, not from interleaved windows', () => {
  // Session A every 15 s at 0/15/30/45, session B every 15 s at 7/22/37: all real gaps are 15 s.
  // Pooled gaps would be 7,8,7,8,7,8 and give 8 s (median), shortening the long-gap rule to 20 s.
  const entries = [0, 15, 30, 45].map((s) => entry(s, 'A', [proc(5, GiB)], { sampleIntervalSeconds: undefined }))
    .concat([7, 22, 37].map((s) => entry(s, 'B', [proc(6, GiB)], { sampleIntervalSeconds: undefined })));
  const model = buildReportModel({ snapshot: { history: entries, processes: [] } });
  assert.equal(model.quality.inferredInterval, 15);
});

test('a process curve is not broken by entries of another window session', () => {
  const entries = [entry(0, 'A', [proc(5, GiB)]), entry(7, 'B', [proc(6, GiB)]), entry(15, 'A', [proc(5, 2 * GiB)]),
    entry(22, 'B', [proc(6, GiB)]), entry(30, 'A', [proc(5, 3 * GiB)])].map((item) => ({ ...item, sampleIntervalSeconds: 15 }));
  const model = buildReportModel({ snapshot: { history: entries, processes: [] } });
  const segments = tools.segments(model.entries, '5:' + createdAt, 'privateBytes', 15);
  assert.deepEqual(segments.map((segment) => segment.map((point) => point.value / GiB)), [[1, 2, 3]], 'one continuous segment');
  // Same identity surviving a window reload (sessions A then C): a real absence in its own session still breaks the line.
  const reload = [entry(0, 'A', [proc(5, GiB)]), entry(15, 'C', [proc(5, GiB)]), entry(30, 'C', []), entry(45, 'C', [proc(5, GiB)])]
    .map((item) => ({ ...item, sampleIntervalSeconds: 15 }));
  assert.deepEqual(tools.segments(buildReportModel({ snapshot: { history: reload, processes: [] } }).entries, '5:' + createdAt, 'privateBytes', 15)
    .map((segment) => segment.length), [2, 1]);
});

test('peaks ignore unknown values and series keep first/last observation times', () => {
  const entries = [entry(0, 'A', [proc(5, GiB)]), entry(15, 'A', [proc(5, null)]), entry(30, 'A', [proc(5, 3 * GiB)]), entry(45, 'A', [proc(5, 2 * GiB)])];
  const [series] = buildReportModel({ snapshot: { history: entries, processes: [] } }).series;
  assert.equal(series.peakPrivateBytes, 3 * GiB);
  assert.equal(series.peakResidentBytes, 1.5 * GiB);
  assert.equal(series.firstAt, t0); assert.equal(series.lastAt, t0 + 45_000);
});

test('byte formatting chooses the unit after rounding', () => {
  assert.equal(tools.formatBytes(512 * MiB + 1.5 * GiB), '2.00 GiB');
  assert.equal(tools.formatBytes(1023.4 * MiB), '1023 MiB');
  assert.equal(tools.formatBytes(1023.6 * MiB), '1.00 GiB', 'not 1024 MiB');
  assert.equal(tools.formatBytes(0.4 * MiB), '0 MiB');
});

test('growth and CPU with irregular sampling', () => {
  // t = 0 s, 10 s, 70 s; private 1000, 1100, 1700 MiB; CPU 0, 500, 3500 ms.
  const tracker = new TrendTracker();
  const policy = { ...defaults, sampleIntervalSeconds: 30, collectTimeoutSeconds: 10, growthWindowSeconds: 60, growthWarningMiB: 512 };
  const s = (mib, cpu) => ({ pid: 9, createdAt, privateBytes: mib * MiB, cpuTimeMs: cpu });
  const samples = [s(1000, 0), s(1100, 500), s(1700, 3500)];
  tracker.update([samples[0]], policy, 0); tracker.update([samples[1]], policy, 10_000); tracker.update([samples[2]], policy, 70_000);
  const last = samples[2];
  // Cutoff 70 - 60 = 10 s: the window starts at the latest point at or before it (t = 10 s, 1100 MiB).
  assert.equal(last.growth.deltaMiB, 600, '1700 - 1100');
  assert.equal(last.growth.observedSeconds, 60);
  assert.equal(last.growth.rateMiBPerMinute, 600, '600 MiB / (60 s / 60)');
  assert.equal(last.growth.warning, false, 'only 2 observations remain in the window; confirmation needs 3');
  assert.equal(last.cpuPercent, 5, '(3500 - 500) ms / 60000 ms × 100');
  assert.equal(samples[1].cpuPercent, 5, '500 ms / 10000 ms × 100');
});

test('workload multiplies relative thresholds but never absolute per-kind overrides', () => {
  const build = processPolicy({ ...defaults, warningPrivateGiB: 4, restartPrivateGiB: 8, profile: 'build', processThresholds: { terminal: { warningPrivateGiB: 5 } } }, 'terminal');
  assert.equal(build.warningPrivateGiB, 5, 'absolute override');
  assert.equal(build.restartPrivateGiB, 16, '8 × 2');
  assert.equal(processPolicy({ ...defaults, warningPrivateGiB: 2.5, restartPrivateGiB: 4, profile: 'tests' }).warningPrivateGiB, 3.75);
});

test('automatic restart counts cover the last hour only and every target', () => {
  let now = t0;
  const controller = new WatchdogController({ observe: async () => ({ target: { state: 'waiting', detail: 'none' }, sample: null, inventory: null }),
    journal: { history: [], append: async () => {} }, commands: async () => [], restart: async () => {}, now: () => now }, defaults);
  controller.configureTargets(defaults, [{ name: 'ts', label: 'TS', policy: { ...defaults }, command: 'x.restart', debugTypes: [] }]);
  controller.engine.restarts = [t0 - 2 * 3600_000, t0 - 10 * 60_000];
  controller.slot('ts').engine.restarts = [t0 - 59 * 60_000, t0 - 61 * 60_000];
  const snapshot = controller.snapshot();
  assert.equal(snapshot.automaticRestarts, 1, 'primary: only the restart 10 minutes ago');
  assert.equal(snapshot.automaticRestartsLastHour, 2, 'primary 1 + ts 1 (59 min ago); 61 min and 2 h are outside');
  assert.equal(buildReportModel({ snapshot }).current.automaticRestarts, 2);
  now = t0 + 51 * 60_000; // primary restart now 61 min old, ts restart 110 min old
  assert.equal(controller.snapshot().automaticRestartsLastHour, 0);
  controller.dispose();
});
