'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WatchdogController } = require('../src/controller');
const { defaults, GiB } = require('../src/policy');
const { withDeadline } = require('../src/collector');

function fixture(overrides = {}, policy = {}) {
  let pid = 1;
  let requests = 0;
  const terminal = {};
  const journal = { history: [], append: async (entry) => journal.history.push(entry) };
  const controller = new WatchdogController({
    resolve: async () => ({ pid, terminal }),
    collect: async (target) => ({ pid: target.pid, createdAt: '2026-10-29T09:00:00Z', privateBytes: 8 * GiB,
      workingSetBytes: GiB, measuredAt: new Date().toISOString() }),
    commands: async () => ['PowerShell.RestartSession'],
    restart: async () => { requests++; pid++; },
    debugging: () => false, journal,
    ...overrides,
  }, { ...defaults, restartGraceSeconds: 0, consecutiveSamples: 1, restartTimeoutSeconds: 0.04, ...policy });
  return { controller, requests: () => requests };
}

test('AC-06/10: command return requires measured replacement before success', async () => {
  const { controller, requests } = fixture();
  await controller.tick();
  assert.equal(requests(), 1);
  assert.equal(controller.restartOutcome, 'succeeded');
  assert.equal(controller.sample.pid, 2);
  await controller.tick();
  assert.equal(requests(), 1);
});

test('AC-10: normal command return with unchanged identity expires and suspends', async () => {
  const { controller } = fixture({ restart: async () => {} });
  await controller.tick();
  assert.equal(controller.restartOutcome, 'expired');
  assert.equal(controller.state, 'suspended');
  assert.equal(controller.sample, null);
  assert.ok(controller.lastValid);
});

test('AC-12: a hung restart command is bounded and cannot overlap after resume', async () => {
  let requests = 0;
  const { controller } = fixture({ restart: () => { requests++; return new Promise(() => {}); } });
  await controller.tick();
  assert.equal(controller.restartOutcome, 'expired');
  assert.equal(controller.pendingCommand, true);
  await controller.resume();
  await controller.tick();
  assert.equal(requests, 1);
});

test('missing or rejected restart command suspends, without forced termination', async () => {
  const missing = fixture({ commands: async () => [] });
  await missing.controller.tick();
  assert.equal(missing.requests(), 0);
  assert.equal(missing.controller.state, 'suspended');
  const rejected = fixture({ restart: async () => { throw new Error('sensitive command text'); } });
  await rejected.controller.tick();
  assert.equal(rejected.controller.restartOutcome, 'failed');
  assert.ok(!JSON.stringify(rejected.controller.snapshot()).includes('sensitive'));
});

test('AC-07: failed collection clears current value and keeps the previous valid sample separate', async () => {
  let fail = false;
  const { controller } = fixture({ collect: async (target) => {
    if (fail) throw new Error('access denied');
    return { pid: target.pid, createdAt: '2026-10-29T09:00:00Z', privateBytes: 8 * GiB, workingSetBytes: GiB, measuredAt: new Date().toISOString() };
  } }, { mode: 'notifyOnly' });
  await controller.tick();
  fail = true;
  await controller.tick();
  assert.equal(controller.sample, null);
  assert.ok(controller.lastValid);
  assert.equal(controller.engine.count, 0);
});

test('AC-15: concurrent ticks never overlap collectors', async () => {
  let active = 0;
  let maximum = 0;
  const { controller } = fixture({ collect: async () => {
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    return null;
  } });
  await Promise.all([controller.tick(), controller.tick(), controller.tick()]);
  assert.equal(maximum, 1);
});

test('policy changes during collection discard stale evidence and prevent dispatch', async () => {
  const { controller, requests } = fixture({ collect: async () => {
    controller.configure({ ...defaults, enabled: false });
    return { pid: 1, createdAt: 'old', privateBytes: 8 * GiB };
  } });
  await controller.tick();
  assert.equal(requests(), 0);
  assert.equal(controller.state, 'disabled');
});

test('final sample below threshold prevents restart', async () => {
  let reads = 0;
  const { controller, requests } = fixture({ collect: async (target) => ({ pid: target.pid, createdAt: 'same',
    privateBytes: ++reads === 1 ? 8 * GiB : GiB, workingSetBytes: GiB, measuredAt: new Date().toISOString() }) });
  await controller.tick();
  assert.equal(requests(), 0);
  assert.equal(controller.engine.count, 0);
});

test('unknown or remote environments never request commands', async () => {
  const { controller, requests } = fixture({ resolve: async () => { const error = new Error(); error.code = 'unsupported'; throw error; } });
  await controller.tick();
  assert.equal(controller.state, 'unsupported');
  assert.equal(requests(), 0);
});

test('deadline and cancellation also bound non-resolving session association', async () => {
  await assert.rejects(withDeadline(() => new Promise(() => {}), 10), { code: 'timeout' });
  const abort = new AbortController();
  const task = withDeadline(() => new Promise(() => {}), 1000, abort.signal);
  abort.abort();
  await assert.rejects(task, { code: 'cancelled' });
});

for (const action of ['disable', 'notifyOnly', 'suspend', 'debug', 'dispose']) {
  test(`restart is cancelled when ${action} occurs during quota persistence`, { timeout: 3000 }, async () => {
    let reached;
    let release;
    let held = false;
    let debugging = false;
    let saved;
    const waiting = new Promise((resolve) => { reached = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const { controller, requests } = fixture({
      debugging: () => debugging,
      store: async (value) => {
        saved = structuredClone(value);
        if (!held && value.suspendedReason && value.restarts.length) {
          held = true;
          reached();
          await gate;
        }
      },
    });
    const running = controller.tick();
    try {
      await waiting;
      if (action === 'disable') controller.configure({ ...controller.engine.policy, enabled: false });
      if (action === 'notifyOnly') controller.configure({ ...controller.engine.policy, mode: 'notifyOnly' });
      if (action === 'suspend') await controller.suspend(15);
      if (action === 'debug') { debugging = true; controller.engine.resetSeries(); }
      if (action === 'dispose') controller.dispose();
      release();
      await running;
      assert.equal(requests(), 0);
      assert.equal(controller.pendingCommand, false);
      assert.equal(controller.engine.count, 0);
      assert.equal(controller.engine.restarts.length, 0, 'A cancelled dispatch must not consume quota.');
      assert.deepEqual(saved.restarts, []);
      assert.equal(saved.suspendedReason, null, 'A cancelled dispatch must not leave a pending restart marker.');
      if (action === 'disable') assert.equal(controller.state, 'disabled');
      if (action === 'notifyOnly') assert.equal(controller.state, 'waiting');
      if (action === 'suspend') assert.equal(controller.state, 'suspended');
      if (action === 'debug') assert.equal(controller.state, 'deferred');
    } finally { release(); await running; controller.dispose(); }
  });
}

test('synchronous restart failure clears the command lock and suspends automatic actions', async () => {
  const { controller } = fixture({ restart: () => { throw new Error('sensitive command text'); } });
  await controller.tick();
  assert.equal(controller.restartOutcome, 'failed');
  assert.equal(controller.pendingCommand, false);
  assert.equal(controller.state, 'suspended');
  assert.equal(controller.engine.restarts.length, 1);
  assert.ok(!JSON.stringify(controller.snapshot()).includes('sensitive command text'));
});

test('successful slow collections can satisfy persistence with a short sampling interval', async () => {
  let now = 0;
  const { controller, requests } = fixture({ now: () => now }, {
    sampleIntervalSeconds: 1, collectTimeoutSeconds: 3, consecutiveSamples: 3,
  });
  // Two seconds of successful collection plus the one-second post-collection delay.
  for (now of [0, 3000, 6000]) await controller.tick();
  assert.equal(requests(), 1);
  assert.equal(controller.restartOutcome, 'succeeded');
});

test('suspend, resume and configuration actions are retained without duplicate paused samples', async () => {
  const { controller } = fixture({}, { mode: 'notifyOnly' });
  const journal = controller.dependencies.journal;
  await controller.tick();
  await controller.suspend(15);
  assert.equal(controller.sample, null);
  await controller.tick();
  await controller.tick();
  await controller.resume();
  assert.equal(controller.sample, null);
  controller.configure({ ...controller.engine.policy, enabled: false });
  await controller.tick();
  await controller.tick();
  controller.configure({ ...controller.engine.policy, enabled: true });
  assert.deepEqual(journal.history.map((entry) => entry.state), ['confirmed', 'suspended', 'waiting', 'disabled', 'waiting']);
  assert.ok(journal.history.slice(1).every((entry) => entry.sample === null && entry.processes === undefined));
});

test('an initially disabled controller records its state once without collecting', async () => {
  const { controller } = fixture({ collect: () => { throw new Error('Must not collect.'); } }, { enabled: false });
  await controller.tick();
  await controller.tick();
  assert.deepEqual(controller.dependencies.journal.history.map((entry) => entry.state), ['disabled']);
});

test('a rejected configuration event write is exposed without an unhandled rejection', async () => {
  const journal = { history: [], append: async () => { throw new Error('Disk unavailable.'); } };
  const { controller } = fixture({ journal });
  controller.configure({ ...controller.engine.policy, enabled: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(journal.error, 'Policy change could not be recorded.');
  assert.equal(controller.state, 'disabled');
});
