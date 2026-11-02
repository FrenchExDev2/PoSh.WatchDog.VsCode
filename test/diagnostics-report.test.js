'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { buildReportModel, renderReportHtml, exportVisualReport } = require('../src/diagnostics-report');
const { createChartTools } = require('../src/report-chart');
const GiB = 1024 ** 3;
const createdAt = '2026-10-29T08:00:00.000Z';
const processSample = (changes = {}) => ({ pid: 12, createdAt, measuredAt: createdAt, kind: 'terminal',
  privateBytes: GiB, workingSetBytes: GiB / 2, automaticRestart: false, ...changes });
const entry = (seconds, changes = {}) => ({ at: new Date(Date.parse(createdAt) + seconds * 1000).toISOString(),
  state: 'normal', decision: 'Measured.', complete: true, processCount: 1, omittedProcesses: 0,
  sampleIntervalSeconds: 15, warningPrivateGiB: 4, restartPrivateGiB: 8, processes: [processSample()], ...changes });
const snapshot = (changes = {}) => ({ state: 'normal', detail: 'Measured.', mode: 'notifyOnly',
  policy: { sampleIntervalSeconds: 15 }, inventory: { complete: true }, processes: [processSample()], history: [], ...changes });

test('retained disk and memory history are merged, ordered and deduplicated', () => {
  const first = entry(0); const last = entry(30);
  const model = buildReportModel({ snapshot: snapshot({ history: [last, first] }), retained: { entries: [entry(15), first], filesRead: 2, bytesRead: 900 } });
  assert.deepEqual(model.entries.map((item) => item.at), [0, 15, 30].map((seconds) => Date.parse(createdAt) + seconds * 1000));
  assert.equal(model.quality.duplicates, 1);
  assert.equal(model.quality.filesRead, 2);
  assert.equal(model.quality.bytesRead, 900);
});

test('workspace history identifies sessions and retains each process effective thresholds', () => {
  const model = buildReportModel({ snapshot: snapshot({ history: [entry(0, { sessionId: 'previous-session', profile: 'tests',
    processes: [processSample({ thresholds: { warningPrivateGiB: 2, restartPrivateGiB: 3 } })] })] }), retained: { scope: 'workspace' } });
  assert.equal(model.quality.historyScope, 'workspace'); assert.equal(model.entries[0].sessionId, 'previous-session');
  assert.equal(model.entries[0].processes[0].thresholds.restartPrivateGiB, 3);
});

test('PID reuse produces independent identities and peak rankings', () => {
  const next = processSample({ createdAt: '2026-10-29T08:00:20Z', privateBytes: 3 * GiB });
  const model = buildReportModel({ snapshot: snapshot({ processes: [next], history: [entry(0), entry(30, { processes: [next] })] }) });
  assert.equal(model.series.length, 2);
  assert.notEqual(model.series[0].id, model.series[1].id);
  assert.equal(model.series[0].peakPrivateBytes, 3 * GiB);
  assert.equal(model.series[1].peakPrivateBytes, GiB);
});

test('legacy Editor Services-only history stays explicitly incomplete', () => {
  const model = buildReportModel({ snapshot: snapshot({ history: [entry(0, { processes: undefined, processCount: undefined, complete: undefined,
    sampleIntervalSeconds: undefined, sample: processSample({ kind: 'editorServices' }) })] }) });
  assert.equal(model.entries[0].processes[0].pid, 12);
  assert.equal(model.entries[0].processCount, null);
  assert.equal(model.quality.incompleteEntries, 1);
  assert.equal(model.quality.inferredCadence, true);
});

test('top-20 omission and a separate editor sample preserve evidence without inventing a total', () => {
  const editor = processSample({ pid: 90, kind: 'editorServices', privateBytes: GiB / 4 });
  const model = buildReportModel({ snapshot: snapshot({ history: [entry(0, { processCount: 21, omittedProcesses: 20, sample: editor })] }) });
  assert.equal(model.quality.incompleteEntries, 1);
  assert.equal(model.entries[0].processCount, 21);
  assert.equal(model.entries[0].processes.length, 1);
  assert.ok(model.series.some((item) => item.pid === 90));
});

test('unknown or invalid measurements remain null and malformed timestamps are counted', () => {
  const model = buildReportModel({ snapshot: snapshot({ processes: [], inventory: null, history: [entry(0, {
    processes: [processSample({ privateBytes: null, workingSetBytes: -1 }), processSample({ pid: 13, privateBytes: 1e308, createdAt: 'invalid' })],
  }), { at: 'invalid' }] }) });
  assert.equal(model.current.available, false);
  assert.equal(model.entries[0].processes[0].privateBytes, null);
  assert.equal(model.entries[0].processes[0].workingSetBytes, null);
  assert.equal(model.entries[0].processes.length, 1);
  assert.equal(model.quality.invalidEntries, 1);
});

test('untrusted text cannot escape the embedded JSON or become executable markup', () => {
  const attack = '</script><img src=x onerror="globalThis.attacked=true">&\u2028';
  const model = buildReportModel({ snapshot: snapshot({ detail: attack, history: [entry(0, { decision: attack, commandLine: 'PRIVATE COMMAND' })] }), environment: { app: attack } });
  const html = renderReportHtml(model);
  assert.ok(!html.includes(attack));
  assert.ok(!html.includes('PRIVATE COMMAND'));
  assert.ok(html.includes('Content-Security-Policy'));
  const data = JSON.parse(/<script id="report-data" type="application\/json">([\s\S]*?)<\/script>/.exec(html)[1]);
  assert.equal(data.current.detail, attack);
  assert.equal(data.environment.app, attack);
});

test('only recorded transitions and restart results become timeline events', () => {
  const model = buildReportModel({ snapshot: snapshot({ history: [entry(0), entry(15), entry(30, { state: 'warning', decision: 'Warning.' }),
    entry(45, { state: 'warning' }), entry(60, { state: 'cooldown', decision: 'Restart succeeded.' })] }) });
  assert.equal(model.events.length, 2);
  assert.equal(model.events[1].decision, 'Restart succeeded.');
});

test('per-process warnings are recorded even when the editor state is unchanged', () => {
  const model = buildReportModel({ snapshot: snapshot({ history: [entry(0), entry(15, { processes: [processSample({ state: 'warning' })] })] }) });
  assert.equal(model.events.length, 1);
  assert.deepEqual(model.events[0].warnings, [{ pid: 12, state: 'warning' }]);
});

test('missing samples, long collection gaps and PID reuse cannot be connected by a chart line', () => {
  const model = buildReportModel({ snapshot: snapshot({ history: [entry(0), entry(15, { processes: [] }), entry(30), entry(300),
    entry(315, { processes: [processSample({ createdAt: '2026-10-29T08:05:10Z' })] })] }) });
  const segments = createChartTools().segments(model.entries, `12:${createdAt}`, 'privateBytes', 15);
  assert.deepEqual(segments.map((item) => item.length), [1, 1, 1]);
});

test('display-only reduction preserves isolated peaks, troughs and endpoint observations', () => {
  const points = Array.from({ length: 10000 }, (_, at) => ({ at, value: at === 4891 ? 9000 : at === 8002 ? -20 : 5 }));
  const result = createChartTools().thinSegment(points, 200);
  assert.ok(result.length <= 200);
  assert.equal(result[0], points[0]); assert.equal(result.at(-1), points.at(-1));
  assert.ok(result.includes(points[4891])); assert.ok(result.includes(points[8002]));
  assert.equal(points.length, 10000);
});

test('an empty diagnostic still produces a complete offline HTML document', () => {
  const html = renderReportHtml(buildReportModel({ snapshot: snapshot({ history: [], processes: [], inventory: null, state: 'disabled' }) }));
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('No measured process'));
  assert.ok(!/\b(?:src|href)="https?:/i.test(html));
});

test('automatic exports are unique, use workspace storage and open only after a complete write', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-html-'));
  try {
    const opened = [];
    const options = { journal: { readRetainedHistory: async () => ({ entries: [] }) }, getSnapshot: () => snapshot(),
      environment: {}, storagePath: path.join(directory, 'workspace'), globalStoragePath: path.join(directory, 'global'),
      openReport: async (file, html) => {
        assert.ok(html.endsWith('</html>'));
        assert.equal(await fs.readFile(file, 'utf8'), html);
        opened.push(file); return true;
      },
      onOpenFailure: () => { throw new Error('Unexpected open failure.'); } };
    const first = await exportVisualReport(options); const second = await exportVisualReport(options);
    assert.notEqual(first.filePath, second.filePath);
    assert.ok(first.filePath.startsWith(options.storagePath + path.sep));
    assert.equal(first.opened, true); assert.equal(opened.length, 2);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});

test('failed tab opening keeps the HTML and exposes its path; global storage works without a workspace', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-html-'));
  try {
    let revealed;
    const result = await exportVisualReport({ journal: { readRetainedHistory: async () => { throw new Error('Denied'); } }, getSnapshot: () => snapshot(),
      globalStoragePath: directory, openReport: async () => { throw new Error('No webview'); }, onOpenFailure: (file) => { revealed = file; } });
    assert.equal(result.opened, false); assert.equal(revealed, result.filePath);
    const html = await fs.readFile(result.filePath, 'utf8');
    assert.ok(html.includes('"code":"unreadable"'));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
