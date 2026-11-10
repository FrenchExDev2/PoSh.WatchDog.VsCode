'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { describeStatus, formatMemory } = require('../src/presentation');
const { GiB } = require('../src/policy');

const snapshot = (changes = {}) => ({ state: 'waiting', detail: 'No owned processes.', mode: 'automatic', processes: [], inventory: { complete: true }, ...changes });
test('memory formatting selects binary units at their exact boundaries', () => {
  for (const [bytes, expected] of [
    [0, '0 B'], [1, '1 B'], [1023, '1023 B'],
    [1024, '1 KiB'], [1536, '1.5 KiB'],
    [512 * 1024, '512 KiB'], [524841, '512.54 KiB'],
    // 1023.999 KiB rounds to 1024.00 KiB = 1 MiB: the unit follows the rounded value (the old expectations '1024 KiB'/'1024 MiB' were wrong).
    [1024 ** 2 - 1, '1 MiB'], [1024 ** 2, '1 MiB'], [1023.99 * 1024, '1023.99 KiB'],
    [96 * 1024 ** 2, '96 MiB'], [GiB - 1, '1 GiB'],
    [GiB, '1 GiB'], [1.5 * GiB, '1.5 GiB'],
    [1024 ** 4, '1 TiB'], [1024 ** 5, '1 PiB'],
  ]) assert.equal(formatMemory(bytes), expected);
});

test('status and hover use appropriate units for total and individual memory', () => {
  const view = describeStatus(snapshot({ state: 'normal', processes: [
    { pid: 1, privateBytes: 64 * 1024 ** 2, workingSetBytes: 512 * 1024 },
    { pid: 2, privateBytes: 32 * 1024 ** 2, workingSetBytes: GiB },
  ] }));
  assert.match(view.text, /2 proc.*96 MiB total.*⠋/);
  assert.match(view.tooltip, /private 64 MiB, resident 512 KiB/);
  assert.match(view.tooltip, /private 32 MiB, resident 1 GiB/);
});

test('no processes has a clear waiting label without an unknown memory number', () => {
  const view = describeStatus(snapshot());
  assert.match(view.text, /No monitored process/);
  assert.ok(!view.text.includes('unknown'));
  assert.ok(!view.text.includes('automatic'));
});
test('multiple processes show count and committed total with per-process details', () => {
  const view = describeStatus(snapshot({ state: 'normal', processes: [
    { pid: 1, privateBytes: GiB, workingSetBytes: GiB / 2, kind: 'terminal', createdAt: '2026-10-29' },
    { pid: 2, privateBytes: GiB / 2, workingSetBytes: GiB / 4, kind: 'child', createdAt: '2026-10-29' },
  ] }));
  assert.match(view.text, /2 proc.*1\.5 GiB total.*⠋/);
  assert.match(view.tooltip, /Thresholds apply to each process/);
  assert.match(view.tooltip, /other targets: alerts only/);
  assert.match(view.tooltip, /PID 2 \(child\)/);
});
test('partial inventory never presents an exact total', () => {
  const view = describeStatus(snapshot({ state: 'normal', inventory: { complete: false }, processes: [
    { pid: 1, privateBytes: GiB, workingSetBytes: GiB, createdAt: '2026-10-29' },
  ] }));
  assert.match(view.text, /≥ 1 GiB/);
  assert.match(view.tooltip, /total is incomplete/);
  assert.match(describeStatus(snapshot({ inventory: { complete: false } })).text, /Discovering processes/);
});
test('disable and collection errors are human-readable states', () => {
  assert.match(describeStatus(snapshot({ state: 'disabled' })).text, /Monitoring disabled/);
  assert.match(describeStatus(snapshot({ state: 'error' })).text, /Measurement unavailable/);
});

test('hover timestamps stay stable as time passes and change only with new collection evidence', () => {
  const input = snapshot({ inventory: { complete: true, measuredAt: '2026-11-04T04:00:00Z' }, processSampleAgeSeconds: 1 });
  const before = describeStatus(input);
  assert.equal(describeStatus({ ...input, processSampleAgeSeconds: 14 }).tooltip, before.tooltip);
  assert.match(before.tooltip, /Last successful process collection: 2026-11-04T04:00:00Z/);
  const next = describeStatus({ ...input, inventory: { complete: true, measuredAt: '2026-11-04T04:00:15Z' } });
  assert.notEqual(next.tooltip, before.tooltip);
});
