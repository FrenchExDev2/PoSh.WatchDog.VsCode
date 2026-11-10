'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults, validatePolicy } = require('../src/policy');
const { readMachinePolicy, readGlobals, readLegacyValues, globalPolicy, GLOBAL_SETTINGS, SECTION } = require('../src/configuration');
const manifest = require('../package.json');

test('workspace and language overrides cannot increase automatic authority', () => {
  const configuration = { inspect: (key) => ({ defaultValue: defaults[key],
    globalValue: key === 'mode' ? 'notifyOnly' : undefined,
    workspaceValue: key === 'mode' ? 'automatic' : false,
    workspaceFolderValue: 'automatic', globalLanguageValue: 'automatic' }) };
  assert.deepEqual(readMachinePolicy(configuration), { ...defaults, mode: 'notifyOnly' });
});

test('explicit invalid values are validated rather than silently replaced with defaults', () => {
  const policy = readMachinePolicy({ inspect: (key) => ({ globalValue: key === 'enabled' ? null : undefined }) });
  assert.ok(validatePolicy(policy).some((error) => error.includes('enabled')));
});

test('every 0.5.x setting stays declared, machine-scoped and deprecated with a pointer to 0.6', () => {
  const properties = manifest.contributes.configuration.properties;
  for (const [key, value] of Object.entries(defaults)) {
    const property = properties[`frenchexdev.powershellWatchdog.${key}`];
    assert.equal(property.scope, 'machine', key);
    assert.deepEqual(property.default, value, key);
    assert.match(property.markdownDeprecationMessage, /Deprecated in 0\.6/, key);
  }
});

test('every 0.6 setting is machine-scoped and its default agrees with the runtime fallback', () => {
  const properties = manifest.contributes.configuration.properties;
  const declared = Object.keys(properties).filter((key) => key.startsWith(`${SECTION}.`));
  assert.deepEqual(declared.map((key) => key.slice(SECTION.length + 1)).sort(), Object.keys(GLOBAL_SETTINGS).sort());
  assert.equal(Object.keys(properties).length, declared.length + Object.keys(defaults).length);
  for (const [key, { fallback }] of Object.entries(GLOBAL_SETTINGS)) {
    assert.equal(properties[`${SECTION}.${key}`].scope, 'machine', key);
    assert.deepEqual(properties[`${SECTION}.${key}`].default, fallback, key);
    assert.equal(properties[`${SECTION}.${key}`].markdownDeprecationMessage, undefined, key);
  }
});

test('new values win, old values are honored until migration, and workspace values never count', () => {
  const inspect = (values) => ({ inspect: (key) => ({ globalValue: values[key], workspaceValue: 'automatic' }) });
  assert.equal(readGlobals(inspect({}), inspect({ mode: 'notifyOnly', profile: 'build' })).mode, 'notifyOnly');
  assert.equal(readGlobals(inspect({}), inspect({ profile: 'build' })).workload, 'build');
  assert.equal(readGlobals(inspect({ mode: 'automatic' }), inspect({ mode: 'notifyOnly' })).mode, 'automatic');
  assert.deepEqual(readGlobals(inspect({}), inspect({})).configPaths, []);
  assert.deepEqual(readLegacyValues(inspect({ cooldownSeconds: 5 })), { cooldownSeconds: 5 });
  const policy = globalPolicy(readGlobals(inspect({ workload: 'tests' }), inspect({})));
  assert.equal(policy.profile, 'tests');
  assert.deepEqual(validatePolicy(policy), []);
});

test('the manifest contributes new ids, the config schema and limited untrusted support', () => {
  assert.equal(manifest.version, '0.6.0');
  assert.ok(manifest.contributes.commands.every((command) => command.command.startsWith('memoryWatchdog.')));
  assert.deepEqual(manifest.contributes.jsonValidation, [{ fileMatch: '*.watchdog.json', url: './schemas/watchdog-config.schema.json' }]);
  assert.equal(manifest.capabilities.untrustedWorkspaces.supported, 'limited');
  assert.equal(manifest.contributes.views.memoryWatchdog[0].id, 'memoryWatchdog.dashboardView');
  assert.ok(manifest.activationEvents.includes('onView:memoryWatchdog.dashboardView'));
});