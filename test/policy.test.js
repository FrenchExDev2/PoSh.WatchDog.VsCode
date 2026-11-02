'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PolicyEngine, defaults, GiB, validatePolicy } = require('../src/policy');

const sample = (privateGiB = 8, pid = 123, createdAt = '2026-10-29T09:00:00Z') =>
  ({ pid, createdAt, privateBytes: privateGiB * GiB, workingSetBytes: 1 * GiB });

test('AC-04: one warning per threshold episode, resident memory does not hide private allocation', () => {
  const engine = new PolicyEngine();
  assert.equal(engine.evaluate(sample(5), 0).notifyWarning, true);
  assert.equal(engine.evaluate(sample(6), 15000).notifyWarning, false);
  engine.evaluate(sample(2), 30000);
  assert.equal(engine.evaluate(sample(5), 45000).notifyWarning, true);
});

test('AC-05/06: three inclusive consecutive high samples authorize one request', () => {
  const engine = new PolicyEngine();
  assert.equal(engine.evaluate(sample(), 0).restart, false);
  engine.evaluate(sample(7), 15000);
  assert.equal(engine.count, 0);
  assert.equal(engine.evaluate(sample(), 30000).restart, false);
  assert.equal(engine.evaluate(sample(), 45000).restart, false);
  assert.equal(engine.evaluate(sample(), 60000).restart, true);
  engine.restartRequested(60000, true);
  engine.restartFinished(60000, 'succeeded');
  assert.equal(engine.evaluate(sample(), 75000).state, 'cooldown');
});

test('AC-07: unknown sample and long gaps break continuity', () => {
  const engine = new PolicyEngine();
  engine.evaluate(sample(), 0);
  assert.equal(engine.evaluate(null, 15000).state, 'error');
  assert.equal(engine.evaluate(sample(), 30000).restart, false);
  engine.evaluate(sample(), 45000);
  assert.equal(engine.evaluate(sample(), 150000).restart, false);
  assert.equal(engine.count, 1);
});

test('continuity includes the collection deadline as well as the delay between collections', () => {
  const engine = new PolicyEngine({ ...defaults, sampleIntervalSeconds: 1, collectTimeoutSeconds: 3 });
  assert.equal(engine.evaluate(sample(), 0).restart, false);
  assert.equal(engine.evaluate(sample(), 4000).restart, false);
  assert.equal(engine.evaluate(sample(), 8000).restart, true);
  assert.equal(engine.count, 3);
});

test('gaps beyond the collection-aware tolerance still reset the series', () => {
  const engine = new PolicyEngine({ ...defaults, sampleIntervalSeconds: 1, collectTimeoutSeconds: 3 });
  engine.evaluate(sample(), 0);
  engine.evaluate(sample(), 5500);
  assert.equal(engine.count, 2);
  assert.equal(engine.evaluate(sample(), 11001).restart, false);
  assert.equal(engine.count, 1);
});

test('explicit samples cannot accelerate the configured persistence interval', () => {
  const engine = new PolicyEngine();
  for (let now = 0; now < 15000; now += 1000) assert.equal(engine.evaluate(sample(), now).restart, false);
  assert.equal(engine.count, 1);
  assert.equal(engine.evaluate(sample(), 15000).restart, false);
  assert.equal(engine.evaluate(sample(), 30000).restart, true);
});

test('AC-08: debug sessions defer restart and end requires a fresh series', () => {
  const engine = new PolicyEngine();
  for (let index = 0; index < 4; index++) assert.equal(engine.evaluate(sample(), index * 15000, { debugging: true }).state, 'deferred');
  assert.equal(engine.evaluate(sample(), 60000, { debugging: false }).restart, false);
  assert.equal(engine.count, 1);
  assert.equal(engine.evaluate(sample(), 75000).restart, false);
  assert.equal(engine.evaluate(sample(), 90000).restart, true);
});

test('AC-09: PID reuse with a new creation date resets counters', () => {
  const engine = new PolicyEngine();
  engine.evaluate(sample(), 0);
  engine.evaluate(sample(), 15000);
  assert.equal(engine.evaluate(sample(8, 123, '2026-10-29T10:00:00Z'), 30000).restart, false);
  assert.equal(engine.count, 1);
});

test('AC-11: rolling quota survives reload, expires by time, and suspension needs explicit resume', () => {
  const engine = new PolicyEngine({ ...defaults, consecutiveSamples: 1 }, { restarts: [0, 1, 2] });
  assert.equal(engine.evaluate(sample(), 30000).state, 'suspended');
  const reloaded = new PolicyEngine(engine.policy, engine.persist());
  assert.equal(reloaded.evaluate(sample(), 3600003).restart, false);
  reloaded.resume();
  assert.equal(reloaded.evaluate(sample(), 3615003).restart, true);
});

test('automatic restarts without sustained improvement suspend after cooldown and persistence', () => {
  const engine = new PolicyEngine({ ...defaults, consecutiveSamples: 1 });
  engine.restartFinished(0, 'succeeded');
  assert.equal(engine.evaluate(sample(), 10000).state, 'cooldown');
  const reloaded = new PolicyEngine(engine.policy, engine.persist());
  assert.equal(reloaded.evaluate(sample(), 120000).state, 'suspended');
});

test('AC-13: disabled and notifyOnly never authorize automatic restart', () => {
  for (const policy of [{ ...defaults, enabled: false }, { ...defaults, mode: 'notifyOnly' }]) {
    const engine = new PolicyEngine(policy);
    for (let index = 0; index < 10; index++) assert.equal(engine.evaluate(sample(100), index * 15000).restart, false);
  }
});

test('invalid policy, timer overflow, non-integers, NaN and invalid types fail closed', () => {
  for (const policy of [{ warningPrivateGiB: 8 }, { restartPrivateGiB: NaN }, { mode: 'other' },
    { sampleIntervalSeconds: 2 ** 31 }, { consecutiveSamples: 1.5 }, { enabled: 'true' }, { cooldownSeconds: 0 }]) {
    const engine = new PolicyEngine({ ...defaults, ...policy });
    assert.ok(validatePolicy(engine.policy).length);
    assert.equal(engine.evaluate(sample(), 0).state, 'error');
  }
});

test('policy edits reset the consecutive series', () => {
  const engine = new PolicyEngine();
  engine.evaluate(sample(), 0);
  engine.evaluate(sample(), 15000);
  engine.configure({ ...defaults, restartPrivateGiB: 9 });
  assert.equal(engine.evaluate(sample(9), 30000).restart, false);
  assert.equal(engine.count, 1);
});

test('suspension expiry requires fresh samples and restart failures persist across reload', () => {
  const engine = new PolicyEngine();
  engine.evaluate(sample(), 0);
  engine.suspend(30000);
  assert.equal(engine.evaluate(sample(), 15000).state, 'suspended');
  assert.equal(engine.evaluate(sample(), 30000).restart, false);
  engine.restartFinished(30000, 'expired');
  const reloaded = new PolicyEngine(defaults, engine.persist());
  assert.equal(reloaded.evaluate(sample(), 45000).state, 'suspended');
});
