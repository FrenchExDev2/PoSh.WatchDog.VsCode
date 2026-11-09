'use strict';

// Objective: configs are validated, located, layered and authorized predictably, and one bad file never disables the others.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const targets = require('../src/targets');
const { testPattern } = require('../src/selection');

const valid = (extra = {}) => ({ schemaVersion: 1, name: 'node-build', label: 'Node build', match: { processNames: ['node'], ownership: 'child' },
  thresholds: { warningPrivateGiB: 2, actionPrivateGiB: 3 }, ...extra });
const errorsOf = (raw, fileBase = raw?.name) => targets.validateConfig(raw, { fileBase }).errors;

test('a minimal config is normalized with safe defaults', () => {
  const { config, errors } = targets.validateConfig(valid(), { fileBase: 'node-build' });
  assert.deepEqual(errors, []);
  assert.equal(config.action.mode, 'notifyOnly');
  assert.equal(config.action.restartCommand, null);
  assert.equal(config.thresholds.consecutiveSamples, 3);
  assert.equal(config.scaleWithWorkload, true);
  assert.ok(Object.isFrozen(config.action));
});

test('the validator rejects each malformed field with a precise message', () => {
  assert.match(errorsOf(valid(), 'other').join(), /must equal the file name/);
  assert.match(errorsOf(valid({ name: 'Bad Name' })).join(), /name:/);
  assert.match(errorsOf(valid({ schemaVersion: 2 })).join(), /schemaVersion/);
  assert.match(errorsOf(valid({ surprise: 1 })).join(), /surprise: unknown property/);
  assert.match(errorsOf(valid({ thresholds: { warningPrivateGiB: 3, actionPrivateGiB: 3 } })).join(), /greater than warningPrivateGiB/);
  assert.match(errorsOf(valid({ match: { processNames: ['C:\\x\\node.exe'], ownership: 'child' } })).join(), /processNames/);
  assert.match(errorsOf(valid({ match: { processNames: ['*'], ownership: 'child' } })).join(), /requires match.commandLine/);
  assert.deepEqual(errorsOf(valid({ match: { processNames: ['*'], ownership: 'terminal' } })), []);
  assert.match(errorsOf(valid({ match: { processNames: ['node'], ownership: 'everywhere' } })).join(), /ownership/);
  assert.match(errorsOf(valid({ match: { processNames: ['node'], ownership: 'child', commandLine: '(' } })).join(), /invalid regular expression/);
  assert.match(errorsOf(valid({ action: { mode: 'automatic' } })).join(), /requires action.restartCommand/);
  assert.match(errorsOf(valid({ action: { restartCommand: 'rm -rf /' } })).join(), /restartCommand/);
  assert.match(errorsOf(valid({ action: { kill: true } })).join(), /kill: unknown property/);
  assert.match(errorsOf(valid({ adapter: 'powershellEditorServices', action: { restartCommand: 'workbench.action.reloadWindow' } })).join(), /only restarts through PowerShell.RestartSession/);
  assert.deepEqual(errorsOf(null), ['The config must be a JSON object.']);
});

test('an adapter ignores match with a warning and always uses its own command', () => {
  const result = targets.validateConfig(valid({ adapter: 'powershellEditorServices', action: { mode: 'automatic' } }), { fileBase: 'node-build' });
  assert.deepEqual(result.errors, []);
  assert.match(result.warnings.join(), /match: ignored/);
  assert.equal(result.config.match, null);
  assert.equal(result.config.action.restartCommand, 'PowerShell.RestartSession');
  assert.equal(result.config.action.mode, 'automatic');
});

test('the JSON schema and the runtime validator accept the same properties', async () => {
  const schema = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'schemas', 'watchdog-config.schema.json'), 'utf8'));
  const unknown = (property, value) => errorsOf(valid({ [property]: value }));
  for (const key of Object.keys(schema.properties)) assert.ok(!unknown(key, undefined).some((error) => error.includes(`${key}: unknown`)), key);
  for (const section of ['match', 'thresholds', 'action']) {
    for (const key of Object.keys(schema.properties[section].properties)) {
      const raw = valid();
      raw[section] = { ...(raw[section] || {}), [key]: undefined };
      assert.ok(!errorsOf(raw).some((error) => error.includes(`${section}.${key}: unknown`)), `${section}.${key}`);
    }
  }
});

test('every built-in config is valid, cross-platform and matches its intended processes', async () => {
  const { configs, issues } = await targets.loadConfigs({ builtinDirectory: path.join(__dirname, '..', 'configs') });
  assert.deepEqual(issues, []);
  assert.deepEqual([...configs.keys()].sort(), ['all-terminals', 'csharp', 'pwsh-children', 'pwsh-editor-services', 'pwsh-terminals', 'tsserver']);
  for (const entry of configs.values()) {
    assert.equal(entry.builtin, true);
    for (const name of entry.config.match?.processNames || []) assert.ok(!/\.exe$/i.test(name), `${entry.name} names must not be Windows-only`);
    if (entry.name !== 'pwsh-editor-services') assert.equal(entry.config.action.mode, 'notifyOnly', entry.name);
  }
  assert.deepEqual(targets.BUILTIN_PROFILES.default, ['pwsh-editor-services', 'pwsh-terminals', 'pwsh-children']);
  const tsserver = configs.get('tsserver').config.match.commandLine;
  assert.deepEqual(testPattern(tsserver, ['"C:\\Program Files\\Microsoft VS Code\\Code.exe" "c:\\x\\typescript\\lib\\tsserver.js" --serverMode partialSemantic',
    '/usr/share/code/code /usr/share/code/resources/app/extensions/node_modules/typescript/lib/tsserver.js --useInferredProjectPerProjectRoot',
    '/a/tsserver.json', '/a/typingsInstaller.js']).matches, [true, true, false, false]);
  const csharp = configs.get('csharp').config.match.commandLine;
  assert.deepEqual(testPattern(csharp, ['C:\\u\\.vscode\\extensions\\ms-dotnettools.csharp-2.1\\.roslyn\\Microsoft.CodeAnalysis.LanguageServer.exe --logLevel Information',
    '/usr/bin/dotnet /home/u/.vscode/extensions/ms-dotnettools.csharp/.roslyn/Microsoft.CodeAnalysis.LanguageServer.dll']).matches, [true, true]);
});

test('config paths expand ~, ${userHome} and ${env:NAME} and refuse relative or workspace paths', () => {
  const win = { platform: 'win32', home: 'C:\\Users\\jean', env: { OneDrive: 'D:\\OneDrive' } };
  assert.equal(targets.expandConfigPath('~\\watchdog', win).path, 'C:\\Users\\jean\\watchdog');
  assert.equal(targets.expandConfigPath('${env:ONEDRIVE}/cfg', win).path, 'D:\\OneDrive\\cfg');
  assert.match(targets.expandConfigPath('\\cfg', win).error, /absolute/);
  assert.match(targets.expandConfigPath('cfg', win).error, /absolute/);
  const posix = { platform: 'linux', home: '/home/jean', env: { XDG_CONFIG_HOME: '/home/jean/.config' } };
  assert.equal(targets.expandConfigPath('~/cfg', posix).path, '/home/jean/cfg');
  assert.equal(targets.expandConfigPath('${userHome}/a/../b', posix).path, '/home/jean/b');
  assert.equal(targets.expandConfigPath('${env:XDG_CONFIG_HOME}/watchdog', posix).path, '/home/jean/.config/watchdog');
  assert.match(targets.expandConfigPath('${env:xdg_config_home}/x', posix).error, /not set/);
  assert.match(targets.expandConfigPath('${workspaceFolder}/cfg', posix).error, /workspaceFolder/);
  assert.match(targets.expandConfigPath('./cfg', posix).error, /absolute/);
  assert.match(targets.expandConfigPath('${cwd}/x', posix).error, /Unsupported/);
  assert.equal(targets.defaultConfigDirectory({ home: '/Users/jean', platform: 'darwin' }), '/Users/jean/.frenchexdev/memory-watchdog');
  assert.equal(targets.isInside('C:\\Repo\\cfg\\a.watchdog.json', 'c:\\repo', 'win32'), true);
  assert.equal(targets.isInside('/repo2/a.watchdog.json', '/repo', 'linux'), false);
});

async function folder(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-configs-'));
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

test('later folders override by name, invalid files are excluded individually and the source is reported', async () => {
  const builtin = path.join(__dirname, '..', 'configs');
  const first = await folder({ 'pwsh-terminals.watchdog.json': { ...valid({ name: 'pwsh-terminals', label: 'Mine' }) },
    'broken.watchdog.json': '{ nope', 'wrong.watchdog.json': valid(), 'notes.json': valid() });
  const second = await folder({ 'pwsh-terminals.watchdog.json': '\uFEFF' + JSON.stringify(valid({ name: 'pwsh-terminals', label: 'Last' })),
    'huge.watchdog.json': ' '.repeat(70 * 1024) });
  try {
    const { configs, issues, infos } = await targets.loadConfigs({ builtinDirectory: builtin,
      directories: [{ path: first }, { path: second }, { path: path.join(first, 'missing') }, { path: path.join(first, 'missing-default'), optional: true }],
      workspaceFolders: [second] });
    const terminals = configs.get('pwsh-terminals');
    assert.equal(terminals.config.label, 'Last');
    assert.equal(terminals.overrides, path.join(first, 'pwsh-terminals.watchdog.json'));
    assert.equal(terminals.builtin, false);
    assert.equal(terminals.inWorkspace, true);
    assert.match(terminals.hash, /^[0-9a-f]{64}$/);
    assert.equal(infos.length, 2);
    assert.ok(configs.has('pwsh-editor-services'));
    const messages = issues.map((issue) => `${path.basename(issue.file)}:${issue.severity}:${issue.message}`).join('\n');
    assert.match(messages, /broken\.watchdog\.json:error:Invalid JSON/);
    assert.match(messages, /wrong\.watchdog\.json:error:name/);
    assert.match(messages, /huge\.watchdog\.json:error:Larger than 64 KiB/);
    assert.match(messages, /missing:warning:Config folder unavailable/);
    assert.doesNotMatch(messages, /notes\.json|missing-default/);
  } finally {
    await fs.rm(first, { recursive: true, force: true });
    await fs.rm(second, { recursive: true, force: true });
  }
});

test('profiles resolve config names, warn on unknown names and fall back to default without automatic actions', () => {
  const configs = new Map(['pwsh-editor-services', 'pwsh-terminals', 'pwsh-children', 'tsserver'].map((name) => [name, { name }]));
  const builtIn = targets.resolveProfile(undefined, undefined, configs);
  assert.deepEqual([builtIn.name, builtIn.fallback, builtIn.targets.map((entry) => entry.name)], ['default', false, ['pwsh-editor-services', 'pwsh-terminals', 'pwsh-children']]);
  const web = targets.resolveProfile({ web: ['tsserver', 'ghost', 'tsserver'] }, 'web', configs);
  assert.deepEqual(web.targets.map((entry) => entry.name), ['tsserver']);
  assert.match(web.warnings.join(), /unknown or invalid config "ghost"/);
  const missing = targets.resolveProfile({ web: ['tsserver'] }, 'typo', configs);
  assert.deepEqual([missing.name, missing.fallback], ['default', true]);
  assert.match(missing.warnings.join(), /does not exist/);
  assert.match(targets.resolveProfile({ 'Bad Name': [] }, 'default', configs).warnings.join(), /must be a list/);
  assert.deepEqual(targets.resolveProfile({ default: ['tsserver'] }, 'default', configs).targets.map((entry) => entry.name), ['tsserver']);
});

const entry = (extra = {}) => ({ name: 'node-build', file: 'C:\\cfg\\node-build.watchdog.json', builtin: false, hash: 'a'.repeat(64), inWorkspace: false,
  config: targets.validateConfig(valid({ action: { mode: 'automatic', restartCommand: 'my.restart' } }), { fileBase: 'node-build' }).config, ...extra });
const globals = { mode: 'automatic', workload: 'build', sampleIntervalSeconds: 15, collectTimeoutSeconds: 3, enabled: true };

test('automatic user restart commands need approval of the exact content, and trust for workspace files', () => {
  const item = entry();
  assert.equal(targets.needsApproval(item, {}, 'win32'), true);
  const approvals = targets.approve({}, item, 'win32');
  assert.deepEqual(approvals, { 'c:\\cfg\\node-build.watchdog.json': item.hash });
  assert.equal(targets.isApproved(approvals, { ...item, file: 'C:\\CFG\\Node-Build.watchdog.json' }, 'win32'), true);
  assert.equal(targets.isApproved(approvals, { ...item, hash: 'b'.repeat(64) }, 'win32'), false, 'edited content must be re-approved');
  assert.equal(targets.isApproved(approvals, { ...item, file: '/CFG/node-build.watchdog.json' }, 'linux'), false);
  assert.deepEqual(targets.targetPolicy(item, globals, { platform: 'win32' }).reasons, ['restart command not approved']);
  const allowed = targets.targetPolicy(item, globals, { approvals, platform: 'win32' });
  assert.equal(allowed.automatic, true);
  assert.equal(allowed.command, 'my.restart');
  assert.equal(allowed.policy.mode, 'automatic');
  assert.equal(allowed.policy.restartPrivateGiB, 3);
  assert.equal(allowed.policy.profile, 'build');
  assert.deepEqual(allowed.policy.processThresholds, {});
  assert.equal(targets.targetPolicy({ ...item, inWorkspace: true }, globals, { approvals, trusted: false, platform: 'win32' }).automatic, false);
  assert.equal(targets.targetPolicy({ ...item, inWorkspace: true }, globals, { approvals, trusted: true, platform: 'win32' }).automatic, true);
  assert.equal(targets.targetPolicy(item, { ...globals, mode: 'notifyOnly' }, { approvals, platform: 'win32' }).policy.mode, 'notifyOnly');
  assert.equal(targets.targetPolicy(item, globals, { approvals, forceNotify: true, platform: 'win32' }).automatic, false);
  assert.equal(targets.targetPolicy({ ...item, builtin: true }, globals, {}).automatic, true);
  const fixed = { ...item, config: { ...item.config, scaleWithWorkload: false } };
  assert.equal(targets.targetPolicy(fixed, globals, { approvals, platform: 'win32' }).policy.profile, 'development');
  assert.deepEqual(Object.keys(targets.collectorTarget(item)).sort(), ['adapter', 'commandLine', 'name', 'ownership', 'processNames']);
});