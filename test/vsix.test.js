'use strict';

// Objective: the packaged VSIX contains the runtime, built-in configs and schema, and none of the removed Windows-only collectors.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const root = path.join(__dirname, '..');

test('vsce would package configs, schema and runtime sources only', { timeout: 120000 }, async () => {
  const vsce = path.join(root, 'node_modules', '@vscode', 'vsce', 'vsce');
  const { stdout } = await promisify(execFile)(process.execPath, [vsce, 'ls', '--no-dependencies'], { cwd: root, maxBuffer: 4 * 1024 * 1024 });
  const files = stdout.split(/\r?\n/).map((line) => line.trim().replace(/\\/g, '/')).filter(Boolean);
  for (const name of ['pwsh-editor-services', 'pwsh-terminals', 'pwsh-children', 'tsserver', 'csharp', 'all-terminals']) {
    assert.ok(files.includes(`configs/${name}.watchdog.json`), `configs/${name}.watchdog.json missing`);
  }
  assert.ok(files.includes('schemas/watchdog-config.schema.json'));
  for (const source of ['src/extension.js', 'src/platform.js', 'src/selection.js', 'src/targets.js', 'src/migration.js', 'package.json']) assert.ok(files.includes(source), source);
  assert.ok(!files.some((file) => /^(test|scripts|\.sandbox|node_modules|verification)\//.test(file)), 'no test, script, sandbox or dependency files');
});