'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { defaults, validatePolicy } = require('../src/policy');
const { readMachinePolicy } = require('../src/configuration');
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

test('every declared setting has machine scope and agrees with the product defaults', () => {
  const properties = manifest.contributes.configuration.properties;
  assert.equal(Object.keys(properties).length, Object.keys(defaults).length);
  for (const [key, value] of Object.entries(defaults)) {
    assert.equal(properties[`frenchexdev.powershellWatchdog.${key}`].scope, 'machine');
    assert.deepEqual(properties[`frenchexdev.powershellWatchdog.${key}`].default, value);
  }
});
