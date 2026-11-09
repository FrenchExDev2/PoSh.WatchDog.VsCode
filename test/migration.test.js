'use strict';

// Objective: 0.5.x users keep their effective behavior after a one-time migration that never overwrites their files.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildMigration, writeMigration } = require('../src/migration');
const { validateConfig } = require('../src/targets');
const { processPolicy, defaults } = require('../src/policy');
const targets = require('../src/targets');

test('nothing to migrate when no 0.5.x setting was set', () => {
  assert.deepEqual(buildMigration({}), { settings: {}, files: [], errors: [], needed: false });
});

test('globals map to the new section and profile becomes workload', () => {
  const result = buildMigration({ profile: 'tests', mode: 'notifyOnly', sampleIntervalSeconds: 30, historyMaxMiB: 40 });
  assert.deepEqual(result.settings, { workload: 'tests', mode: 'notifyOnly', sampleIntervalSeconds: 30, historyMaxMiB: 40 });
  assert.equal(result.files.length, 0);
  assert.equal(result.needed, true);
});

test('thresholds and restart safeguards become overriding configs with the same effective values', () => {
  const old = { profile: 'build', warningPrivateGiB: 3, restartPrivateGiB: 6, consecutiveSamples: 5, cooldownSeconds: 600, maxAutomaticRestartsPerHour: 1,
    restartGraceSeconds: 0, deferWhileDebugging: false, requireKnownIdle: true, processThresholds: { terminal: { warningPrivateGiB: 10 } } };
  const { files, errors } = buildMigration(old);
  assert.deepEqual(errors, []);
  assert.deepEqual(files.map((file) => file.fileName), ['pwsh-editor-services.watchdog.json', 'pwsh-terminals.watchdog.json', 'pwsh-children.watchdog.json']);
  const parsed = Object.fromEntries(files.map((file) => [file.name, JSON.parse(file.content)]));
  for (const file of files) {
    assert.ok(validateConfig(parsed[file.name], { fileBase: file.name }).config, file.name);
    assert.equal(file.hash, crypto.createHash('sha256').update(file.content).digest('hex'));
  }
  assert.deepEqual(parsed['pwsh-editor-services'].action, { mode: 'automatic', restartCommand: 'PowerShell.RestartSession', graceSeconds: 0, cooldownSeconds: 600,
    maxPerHour: 1, timeoutSeconds: 45, deferWhileDebugging: [], deferWhileRunningCommands: true, requireKnownIdle: true });
  // Effective numbers before (0.5.x processPolicy) and after (config + workload) are identical for each kind.
  const globals = { ...defaults, workload: 'build' };
  for (const [kind, name] of [['editorServices', 'pwsh-editor-services'], ['terminal', 'pwsh-terminals'], ['child', 'pwsh-children']]) {
    const before = processPolicy({ ...defaults, ...old }, kind);
    const config = validateConfig(parsed[name], { fileBase: name }).config;
    const after = processPolicy(targets.targetPolicy({ name, config, builtin: false, file: name, hash: '', inWorkspace: false }, globals).policy, kind);
    assert.deepEqual([after.warningPrivateGiB, after.restartPrivateGiB, after.consecutiveSamples], [before.warningPrivateGiB, before.restartPrivateGiB, 5], kind);
  }
  assert.equal(parsed['pwsh-terminals'].scaleWithWorkload, false);
  assert.equal(parsed['pwsh-children'].scaleWithWorkload, undefined);
});

test('invalid old values are reported instead of producing broken configs', () => {
  const result = buildMigration({ warningPrivateGiB: 9, restartPrivateGiB: 8 });
  assert.equal(result.files.length, 0);
  assert.match(result.errors.join(), /greater than warningPrivateGiB/);
});

test('migration files are written once and existing files are never overwritten', async () => {
  const dir = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-migration-')), 'nested');
  try {
    const { files } = buildMigration({ warningPrivateGiB: 2 });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'pwsh-terminals.watchdog.json'), 'mine');
    const { written, skipped } = await writeMigration(dir, files);
    assert.deepEqual(written.map((file) => file.name), ['pwsh-editor-services', 'pwsh-children']);
    assert.deepEqual(skipped.map((file) => file.name), ['pwsh-terminals']);
    assert.equal(await fs.readFile(path.join(dir, 'pwsh-terminals.watchdog.json'), 'utf8'), 'mine');
    assert.equal(await fs.readFile(written[0].file, 'utf8'), files[0].content);
  } finally { await fs.rm(path.dirname(dir), { recursive: true, force: true }); }
});