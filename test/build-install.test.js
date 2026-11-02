'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

/** Run the actual delivery script against isolated CLI fixtures, retaining argument boundaries. */
async function fixture(t, scenario) {
  // Windows CI can expose TEMP through an 8.3 alias; compare the actual canonical paths.
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog vsix épreuve ')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'scripts'));
  await fs.mkdir(path.join(directory, 'node_modules/@vscode/vsce'), { recursive: true });
  await fs.mkdir(path.join(directory, 'dist'));
  const script = path.join(directory, 'scripts/Build-InstallVsix.ps1');
  const cli = path.join(directory, 'code fixture.cmd');
  const archive = path.join(directory, 'dist/fixture-watchdog-1.2.3.vsix');
  await fs.copyFile(path.join(__dirname, '../scripts/Build-InstallVsix.ps1'), script);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture-watchdog', publisher: 'FrenchExDev', version: '1.2.3' }), 'utf8');
  const nativeFixture = path.join(__dirname, 'build-install-cli.fixture.js');
  await fs.copyFile(nativeFixture, path.join(directory, 'node_modules/@vscode/vsce/vsce'));
  await fs.copyFile(nativeFixture, path.join(directory, 'code fixture.js'));
  await fs.writeFile(cli, `@echo off\r\n"${process.execPath}" "%~dp0code fixture.js" %*\r\nexit /b %errorlevel%\r\n`, 'utf8');
  await fs.writeFile(archive, 'stale package', 'utf8');
  const report = path.join(directory, 'result.json');
  await execute('pwsh', ['-NoLogo', '-NoProfile', '-File', path.join(__dirname, 'Build-InstallVsix.Fixture.ps1'),
    '-BuildScript', script, '-FakeCli', cli, '-Report', report, '-Scenario', scenario], { timeout: 30000, encoding: 'utf8', windowsHide: true });
  return { report: JSON.parse(await fs.readFile(report, 'utf8')), archive, cli, directory };
}

test('VSIX build installs the newly verified version in the selected profile, preserving spaces and Unicode', async (t) => {
  const f = await fixture(t, 'Success');
  assert.equal(f.report.Success, true, f.report.Error);
  assert.equal(f.report.Calls.length, 3);
  assert.deepEqual(f.report.Calls[1].Arguments, ['--install-extension', f.archive, '--force', '--profile', 'Développement équipe']);
  assert.deepEqual(f.report.Calls[2].Arguments, ['--list-extensions', '--show-versions', '--profile', 'Développement équipe']);
  assert.ok(f.report.Calls.every((call) => call.Directory === f.directory));
  assert.ok(!f.report.LoadedModules.some((name) => /QuietCli/i.test(name)));
  assert.equal(f.report.Result.Channel, 'Stable');
  assert.equal(f.report.Result.Extension, 'FrenchExDev.fixture-watchdog@1.2.3');
  assert.match(await fs.readFile(`${f.archive}.sha256`, 'utf8'), /^[a-f0-9]{64}  fixture-watchdog-1\.2\.3\.vsix\n$/);
});

for (const scenario of ['PackagingFailure', 'MissingPackage', 'WrongVersion', 'InstallationFailure', 'UnconfirmedVersion']) {
  test(`VSIX delivery rejects ${scenario} and stops before subsequent steps`, async (t) => {
    const f = await fixture(t, scenario);
    assert.equal(f.report.Success, false);
    assert.ok(f.report.Error);
    const expectedCalls = scenario === 'InstallationFailure' ? 2 : scenario === 'UnconfirmedVersion' ? 3 : 1;
    assert.equal(f.report.Calls.length, expectedCalls);
    if (scenario === 'PackagingFailure') assert.match(f.report.Error, /code de sortie 7/);
    if (scenario === 'InstallationFailure') assert.match(f.report.Error, /code de sortie 8/);
    if (scenario === 'PackagingFailure') await assert.rejects(fs.access(f.archive), { code: 'ENOENT' });
  });
}

test('VSIX preview neither invokes native tools nor overwrites an existing archive', async (t) => {
  const f = await fixture(t, 'Preview');
  assert.equal(f.report.Success, true, f.report.Error);
  assert.equal(f.report.Calls.length, 0);
  assert.equal(await fs.readFile(f.archive, 'utf8'), 'stale package');
});
