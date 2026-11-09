'use strict';

// Objective: configs are validated, located, layered and authorized predictably, and one bad file never disables the others.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const targets = require('../src/targets');
const selection = require('../src/selection');
const { testPattern } = selection;

const { normalizeName } = require('../src/platform');

// Built-in automatic restart commands and where each ID was verified (contributes.commands of the extension manifest).
const VERIFIED_AUTOMATIC = {
  'pwsh-editor-services': 'PowerShell.RestartSession', // ms-vscode.PowerShell (0.5.x qualification)
  'eslint': 'eslint.restart',
  'tsgo': 'typescript.native-preview.restart',
  'python': 'python.analysis.restartLanguageServer',
  'rust-analyzer': 'rust-analyzer.restartServer',
  // verified-automatic-end
};

/** Match fixture processes of one OS against a built-in profile: host PID 2, terminal shells listed in `terminals`. */
async function matchBuiltin(profile, platform, processes, terminals = []) {
  const { configs } = await targets.loadConfigs({ builtinDirectory: path.join(__dirname, '..', 'configs') });
  const resolved = targets.resolveProfile({}, profile, configs);
  const entries = processes.map(([pid, ppid, name, commandLine = null]) => ({ proc: { pid, ppid, name: normalizeName(name, platform), commandLine }, rootPid: ppid }));
  const { assigned, errors } = selection.matchTargets(entries, resolved.targets.map((entry) => targets.collectorTarget(entry)),
    { hostProcessId: 2, terminalProcessIds: new Set(terminals), platform });
  assert.deepEqual(errors, []);
  return Object.fromEntries(processes.map(([pid]) => [pid, assigned.get(pid) || null]));
}

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
  assert.deepEqual([...configs.keys()].sort(), ['all-terminals', 'csharp', 'eslint', 'node-tools', 'pwsh-children', 'pwsh-editor-services', 'pwsh-terminals', 'python', 'python-tools', 'rust-analyzer', 'rust-builds', 'tsgo', 'tsserver']);
  for (const entry of configs.values()) {
    assert.equal(entry.builtin, true);
    for (const name of entry.config.match?.processNames || []) assert.ok(!/\.exe$/i.test(name), `${entry.name} names must not be Windows-only`);
    // Automatic only with a restart command verified against the owning extension's package.json (see VERIFIED_AUTOMATIC).
    if (entry.config.action.mode === 'automatic') assert.equal(entry.config.action.restartCommand, VERIFIED_AUTOMATIC[entry.name], `${entry.name}: unverified automatic restart`);
    else assert.ok(!VERIFIED_AUTOMATIC[entry.name], `${entry.name}: listed as automatic but notify-only`);
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

test('every built-in profile lists existing built-in configs, specific configs before all-terminals', async () => {
  const { configs } = await targets.loadConfigs({ builtinDirectory: path.join(__dirname, '..', 'configs') });
  for (const [name, list] of Object.entries(targets.BUILTIN_PROFILES)) {
    assert.ok(list.length > 0 && new Set(list).size === list.length, name);
    for (const config of list) assert.ok(configs.has(config), `${name}: ${config}`);
    if (list.includes('all-terminals')) assert.equal(list.at(-1), 'all-terminals', `${name}: the catch-all comes last`);
    const resolved = targets.resolveProfile({}, name, configs);
    assert.equal(resolved.fallback, false); assert.deepEqual(resolved.warnings, []);
    assert.deepEqual(resolved.targets.map((entry) => entry.name), [...list]);
    assert.ok(Object.isFrozen(list));
  }
});

test('powershell-full and minimal profiles', async () => {
  const { configs } = await targets.loadConfigs({ builtinDirectory: path.join(__dirname, '..', 'configs') });
  assert.deepEqual(targets.resolveProfile({}, 'powershell-full', configs).targets.map((entry) => entry.name), ['pwsh-editor-services', 'pwsh-terminals', 'pwsh-children', 'all-terminals']);
  assert.deepEqual(targets.resolveProfile({}, 'minimal', configs).targets.map((entry) => entry.name), ['pwsh-editor-services']);
  assert.deepEqual(targets.resolveProfile({ minimal: ['tsserver'] }, 'minimal', configs).targets.map((entry) => entry.name), ['tsserver'], 'a user profile replaces a built-in one');
  assert.ok(targets.resolveProfile({}, 'minimal', configs).available.includes('powershell-full'));
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

test('wave 2 configs: ESLint server and tsgo command lines on every OS', async () => {
  const { configs } = await targets.loadConfigs({ builtinDirectory: path.join(__dirname, '..', 'configs') });
  assert.deepEqual(testPattern(configs.get('eslint').config.match.commandLine, [
    '"C:\\Users\\u\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe" c:\\Users\\u\\.vscode\\extensions\\dbaeumer.vscode-eslint-3.0.34\\server\\out\\eslintServer.js --node-ipc --clientProcessId=12',
    '/usr/share/code/code /home/u/.vscode/extensions/dbaeumer.vscode-eslint-3.0.34/server/out/eslintServer.js --node-ipc',
    '/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) /Users/u/.vscode/extensions/dbaeumer.vscode-eslint-3.0.34/server/out/eslintServer.js',
    'node /repo/node_modules/eslint/bin/eslint.js .']).matches, [true, true, true, false]);
  assert.deepEqual(testPattern(configs.get('tsgo').config.match.commandLine, ['c:\\x\\lib\\tsgo.exe --lsp --stdio', '/x/lib/tsgo --lsp', 'tsgo --build', 'tsgo --lspx']).matches, [true, true, false, false]);
});

test('web profile assigns language servers, builds and other shells on Windows, Linux and macOS', async () => {
  const eslint = (prefix) => prefix + '/ext/dbaeumer.vscode-eslint-3.0.34/server/out/eslintServer.js --node-ipc';
  const cases = {
    win32: [[10, 2, 'Code - Insiders.exe', eslint('"C:\\Code.exe" c:')], [11, 2, 'Code - Insiders.exe', '"C:\\Code.exe" "c:\\ts\\lib\\tsserver.js" --serverMode partialSemantic'],
      [12, 2, 'tsgo.exe', 'C:\\x\\tsgo.exe --lsp --stdio'], [20, 2, 'pwsh.exe'], [21, 20, 'node.exe', 'node build.js'], [22, 20, 'git.exe'], [23, 2, 'Code - Insiders.exe', 'C:\\Code.exe other.js']],
    linux: [[10, 2, 'code', eslint('/usr/share/code/code /home/u')], [11, 2, 'code', '/usr/share/code/code /x/typescript/lib/tsserver.js'],
      [12, 2, 'tsgo', '/x/tsgo --lsp --stdio'], [20, 2, 'bash'], [21, 20, 'node', 'node build.js'], [22, 20, 'git'], [23, 2, 'code', '/usr/share/code/code other.js']],
    darwin: [[10, 2, 'Code Helper (Plugin)', eslint('/A/Code Helper (Plugin) /Users/u')], [11, 2, 'Code Helper (Plugin)', '/A/Code Helper (Plugin) /x/tsserver.js'],
      [12, 2, 'tsgo', '/x/tsgo --lsp --stdio'], [20, 2, 'zsh'], [21, 20, 'node', 'node build.js'], [22, 20, 'git'], [23, 2, 'Code Helper (Plugin)', '/A/Code Helper other.js']],
  };
  for (const [platform, processes] of Object.entries(cases)) {
    assert.deepEqual(await matchBuiltin('web', platform, processes, [20]),
      { 10: 'eslint', 11: 'tsserver', 12: 'tsgo', 20: 'all-terminals', 21: 'node-tools', 22: null, 23: null }, platform);
  }
});

test('dotnet profile assigns Roslyn and pwsh terminals on Windows and Linux', async () => {
  assert.deepEqual(await matchBuiltin('dotnet', 'win32', [[30, 2, 'Microsoft.CodeAnalysis.LanguageServer.exe', 'C:\\u\\.roslyn\\Microsoft.CodeAnalysis.LanguageServer.exe --logLevel Information'],
    [31, 2, 'pwsh.exe'], [32, 2, 'bash.exe']], [31, 32]), { 30: 'csharp', 31: 'pwsh-terminals', 32: null });
  assert.deepEqual(await matchBuiltin('dotnet', 'linux', [[30, 2, 'dotnet', '/usr/bin/dotnet /home/u/.roslyn/Microsoft.CodeAnalysis.LanguageServer.dll'], [31, 2, 'pwsh']], [31]),
    { 30: 'csharp', 31: 'pwsh-terminals' });
});

test('wave 3 configs: Pylance server and Python interpreters on every OS', async () => {
  const { configs } = await targets.loadConfigs({ builtinDirectory: path.join(__dirname, '..', 'configs') });
  assert.deepEqual(testPattern(configs.get('python').config.match.commandLine, [
    'C:\\Code.exe c:\\Users\\u\\.vscode\\extensions\\ms-python.vscode-pylance-2026.4.1\\dist\\server.bundle.js --cancellationReceive=file:x',
    '/usr/share/code/code /home/u/.vscode/extensions/ms-python.vscode-pylance-2026.4.1/dist/server.bundle.js',
    '/A/Code Helper (Plugin) /Users/u/.vscode/extensions/ms-python.vscode-pylance-2026.4.1/dist/server.bundle.js',
    'C:\\Code.exe c:\\ext\\ms-python.vscode-pylance-2026.4.1\\dist\\typeServer.bundle.js']).matches, [true, true, true, false]);
  assert.deepEqual(testPattern(configs.get('python-tools').config.match.commandLine, [
    '"C:\\Program Files\\Python312\\python.exe" -m pytest', 'C:\\Users\\u\\.venv\\Scripts\\pythonw.exe app.py', 'py -3.12 x.py',
    '/usr/bin/python3.12 -m ipykernel_launcher -f k.json', 'python3', '/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python -m pytest',
    'pythonista run', '/usr/bin/mypy src', 'node python.js', '"C:\\Program Files\\Py Tools\\pyright.exe"']).matches,
    [true, true, true, true, true, true, false, false, false, false]);
});

test('python and rust profiles assign servers, tools and shells on Windows, Linux and macOS', async () => {
  const pylance = '/ext/ms-python.vscode-pylance-2026.4.1/dist/server.bundle.js';
  const cases = {
    win32: [[10, 2, 'Code.exe', 'C:\\Code.exe c:' + pylance.replace(/\//g, '\\')], [20, 2, 'pwsh.exe'], [21, 20, 'python.exe', 'C:\\venv\\Scripts\\python.exe -m pytest'],
      [22, 20, 'cargo.exe', 'cargo build'], [23, 22, 'rustc.exe', 'rustc --crate-name x'], [24, 2, 'rust-analyzer.exe', 'c:\\ra\\rust-analyzer.exe']],
    linux: [[10, 2, 'code', '/usr/share/code/code ' + pylance], [20, 2, 'bash'], [21, 20, 'python3.12', '/usr/bin/python3.12 -m pytest'],
      [22, 20, 'cargo', 'cargo build'], [23, 22, 'rustc', 'rustc --crate-name x'], [24, 2, 'rust-analyzer', '/ra/rust-analyzer']],
    darwin: [[10, 2, 'Code Helper (Plugin)', '/A/Code Helper (Plugin) ' + pylance], [20, 2, 'zsh'], [21, 20, 'Python', '/Library/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python -m pytest'],
      [22, 20, 'cargo', 'cargo build'], [23, 22, 'rustc', 'rustc --crate-name x'], [24, 2, 'rust-analyzer', '/ra/rust-analyzer']],
  };
  for (const [platform, processes] of Object.entries(cases)) {
    assert.deepEqual(await matchBuiltin('python', platform, processes, [20]), { 10: 'python', 20: 'all-terminals', 21: 'python-tools', 22: null, 23: null, 24: null }, platform);
    assert.deepEqual(await matchBuiltin('rust', platform, processes, [20]), { 10: null, 20: 'all-terminals', 21: null, 22: 'rust-builds', 23: 'rust-builds', 24: 'rust-analyzer' }, platform);
  }
});
