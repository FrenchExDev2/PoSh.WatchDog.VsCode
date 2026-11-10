'use strict';

// Objective: several targets are monitored at once, each with its own state, safeguards and restart command,
// and a change to one config never resets the evidence of the others.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { WatchdogController } = require('../src/controller');
const { defaults, GiB } = require('../src/policy');

const at = '2026-11-09T09:00:00Z';
const make = (pid, bytes, targetId) => ({ pid, createdAt: at, privateBytes: bytes, workingSetBytes: GiB, measuredAt: new Date().toISOString(), rootPid: 42, targetId });
const policy = (extra = {}) => ({ ...defaults, restartGraceSeconds: 0, consecutiveSamples: 1, restartTimeoutSeconds: 0.05, ...extra });

function fixture({ tsBytes = 5 * GiB, tsCount = 1, commands = ['typescript.restartTsServer', 'PowerShell.RestartSession'], debugging = () => false } = {}) {
  let tsPid = 100;
  const restarts = [];
  const stored = [];
  const journal = { history: [], append: async (entry) => journal.history.push(entry) };
  const observe = async () => {
    const ts = Array.from({ length: tsCount }, (_item, index) => make(tsPid + index * 1000, tsBytes, 'tsserver'));
    const node = make(7, 9 * GiB, 'node');
    const processes = [...ts, node].map((sample) => ({ ...sample, automaticRestart: tsCount === 1 && sample.targetId === 'tsserver' }));
    return { target: { state: 'waiting', detail: 'No PSES.' }, sample: null, inventory: { processes, errors: [], limited: false, complete: true, measuredAt: new Date().toISOString() },
      targets: { tsserver: tsCount === 1 ? { target: { name: 'tsserver', pid: processes[0].pid }, sample: processes[0] } : { target: { state: 'ambiguous', detail: 'two' }, sample: null } } };
  };
  const controller = new WatchdogController({ observe, journal, debugging, commands: async () => commands,
    restart: async (command, name) => { restarts.push([command, name]); tsPid++; }, store: async (value) => stored.push(value) }, policy());
  const tsPolicy = policy({ warningPrivateGiB: 2, restartPrivateGiB: 4 });
  const nodePolicy = policy({ warningPrivateGiB: 6, restartPrivateGiB: 8, mode: 'notifyOnly' });
  controller.configureTargets(policy(), [
    { name: 'tsserver', label: 'TypeScript server', policy: tsPolicy, command: 'typescript.restartTsServer', debugTypes: ['node'] },
    { name: 'node', label: 'Node', policy: nodePolicy, command: null, debugTypes: [] }]);
  return { controller, restarts, stored, journal };
}

test('a unique generic target restarts through its own command while other targets only alert', async () => {
  const { controller, restarts, stored, journal } = fixture();
  await controller.tick();
  assert.deepEqual(restarts, [['typescript.restartTsServer', 'tsserver']]);
  const slot = controller.slot('tsserver');
  assert.equal(slot.restartOutcome, 'succeeded');
  assert.equal(slot.sample.pid, 101);
  assert.equal(controller.restartOutcome, null, 'the Editor Services slot is untouched');
  assert.equal(controller.slot('node'), null, 'targets without a restart command have no restart slot');
  const nodeSample = controller.inventory.processes.find((sample) => sample.targetId === 'node');
  assert.deepEqual(nodeSample.thresholds, { warningPrivateGiB: 6, restartPrivateGiB: 8 });
  assert.equal(nodeSample.state, 'confirmed');
  assert.equal(stored.at(-1).targets.tsserver.restarts.length, 1);
  assert.ok(journal.history.some((entry) => entry.targets?.[0]?.targetId === 'tsserver'));
  const snapshot = controller.snapshot();
  assert.deepEqual(snapshot.targets.map((target) => target.name), ['pwsh-editor-services', 'tsserver']);
  assert.equal(snapshot.targetPolicies.node.mode, 'notifyOnly');
});

test('two matching processes keep the restart manual and fall back to per-process alerts', async () => {
  const { controller, restarts } = fixture({ tsCount: 2 });
  await controller.tick();
  assert.deepEqual(restarts, []);
  assert.equal(controller.slot('tsserver').state, 'waiting');
  const alerts = controller.inventory.processes.filter((sample) => sample.targetId === 'tsserver');
  assert.deepEqual(alerts.map((sample) => sample.state), ['confirmed', 'confirmed']);
  assert.equal(await controller.manualRestart('tsserver'), false);
});

test('debug types defer only the target that declares them and a missing command suspends only that target', async () => {
  const debugged = fixture({ debugging: (types) => Array.isArray(types) && types.includes('node') });
  await debugged.controller.tick();
  assert.deepEqual(debugged.restarts, []);
  const missing = fixture({ commands: ['PowerShell.RestartSession'] });
  await missing.controller.tick();
  assert.equal(missing.controller.slot('tsserver').state, 'suspended');
  assert.match(missing.controller.slot('tsserver').detail, /typescript.restartTsServer is unavailable/);
  assert.equal(missing.controller.engine.suspendedReason, null);
  assert.equal(missing.controller.snapshot().targets.find((target) => target.name === 'tsserver').state, 'suspended');
  // A confirmed alert of another process outranks a suspended secondary target in the window state.
  assert.equal(missing.controller.state, 'confirmed');
});

test('reconfiguring one target keeps the evidence and quota of the others', async () => {
  const { controller } = fixture();
  const base = policy();
  const ts = (extra) => ({ name: 'tsserver', label: 'TypeScript server', policy: policy({ warningPrivateGiB: 2, restartPrivateGiB: 4, consecutiveSamples: 5, ...extra }), command: 'typescript.restartTsServer', debugTypes: [] });
  const other = { name: 'other', label: 'Other', policy: policy({ consecutiveSamples: 5 }), command: 'other.restart', debugTypes: [] };
  controller.configureTargets(base, [ts(), other]);
  await controller.tick();
  assert.equal(controller.slot('tsserver').engine.count, 1);
  controller.slot('other').engine.count = 2;
  const revision = controller.revision;
  controller.configureTargets(base, [ts({ warningPrivateGiB: 1 }), other]);
  assert.equal(controller.slot('tsserver').engine.count, 0, 'changed target is reset');
  assert.equal(controller.slot('other').engine.count, 2, 'unchanged target keeps its series');
  assert.equal(controller.revision, revision, 'the Editor Services slot and globals are untouched');
  controller.configureTargets(base, [other]);
  assert.equal(controller.slot('tsserver'), null);
});

test('per-target persisted state survives a reload and the old flat format still loads', async () => {
  const { controller, stored } = fixture();
  await controller.tick();
  const saved = stored.at(-1);
  const reloaded = new WatchdogController({ journal: { history: [], append: async () => {} } }, policy(), saved);
  reloaded.configureTargets(policy(), [{ name: 'tsserver', label: 'TS', policy: policy({ warningPrivateGiB: 2, restartPrivateGiB: 4 }), command: 'typescript.restartTsServer', debugTypes: [] }]);
  assert.equal(reloaded.slot('tsserver').engine.restarts.length, 1);
  const legacy = new WatchdogController({ journal: { history: [], append: async () => {} } }, policy(), { restarts: [Date.now()], suspendedReason: 'x', cancelledIdentity: '1:a' });
  assert.equal(legacy.engine.restarts.length, 1);
  assert.equal(legacy.engine.suspendedReason, 'x');
  assert.equal(legacy.cancelledIdentity, '1:a');
});