'use strict';

// Objective: platform process parsers produce one normalized shape from Windows CIM, Linux procfs and macOS ps fixtures.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const platform = require('../src/platform');

test('process names drop .exe and fold case only on Windows', () => {
  assert.equal(platform.normalizeName('PWSH.EXE', 'win32'), 'pwsh');
  assert.equal(platform.normalizeName('Code - Insiders.exe', 'win32'), 'code - insiders');
  assert.equal(platform.normalizeName('pwsh', 'linux'), 'pwsh');
  assert.equal(platform.normalizeName('Electron', 'darwin'), 'Electron');
  assert.equal(platform.samePath('C:\\Code\\Code.exe', 'c:\\code\\CODE.EXE', 'win32'), true);
  assert.equal(platform.samePath('/usr/bin/Code', '/usr/bin/code', 'linux'), false);
});

test('Windows CIM snapshot accepts arrays and single objects', () => {
  const item = { p: 12, pp: 11, n: 'pwsh.exe', e: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', c: 'pwsh -NoProfile', t: '2026-11-09T08:00:00.1234560Z',
    ws: 2048, pv: 1024, cpu: 718.75, th: 9, h: 300 };
  const [single] = platform.parseWindowsSnapshot(JSON.stringify(item));
  assert.deepEqual(single, { pid: 12, ppid: 11, name: 'pwsh', rawName: 'pwsh.exe', exe: item.e, commandLine: 'pwsh -NoProfile',
    createdAt: '2026-11-09T08:00:00.123Z', privateBytes: 1024, workingSetBytes: 2048, privateBytesSource: 'private', cpuTimeMs: 718.75,
    threadCount: 9, handleCount: 300 });
  const list = platform.parseWindowsSnapshot('\uFEFF' + JSON.stringify([item, { ...item, p: 4, pp: 0, e: '', c: '', t: null }, { p: 0 }]));
  assert.equal(list.length, 2);
  assert.equal(list[1].exe, null);
  assert.equal(list[1].ppid, null);
  assert.equal(list[1].createdAt, null);
});

const stat = '1234 (my (odd) proc) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 7 0 12345 1000000 500';
const status = 'Name:\tpwsh\nVmRSS:\t    2048 kB\nRssAnon:\t    1000 kB\nVmSwap:\t      24 kB\n';

test('Linux stat parsing survives parentheses and spaces in the command name', () => {
  const parsed = platform.parseLinuxStat(stat);
  assert.deepEqual(parsed, { pid: 1234, comm: 'my (odd) proc', ppid: 1, utime: 250, stime: 50, threads: 7, starttime: 12345 });
  assert.equal(platform.parseLinuxStat('garbage'), null);
  assert.equal(platform.parseBootTime('cpu 1 2 3\nbtime 1793000000\nprocesses 4\n'), 1793000000);
});

test('Linux procfs fixture yields anonymous private memory, RSS working set and boot-relative start time', () => {
  const proc = platform.parseLinuxProcess({ stat, status, cmdline: '/opt/microsoft/powershell/7/pwsh\0-NoProfile\0', exe: '/opt/microsoft/powershell/7/pwsh' },
    { bootTimeSeconds: 1793000000, clockTicks: 100 });
  assert.equal(proc.name, 'pwsh');
  assert.equal(proc.ppid, 1);
  assert.equal(proc.commandLine, '/opt/microsoft/powershell/7/pwsh -NoProfile');
  assert.equal(proc.privateBytes, 1024 * 1024);
  assert.equal(proc.privateBytesSource, 'anonymous');
  assert.equal(proc.workingSetBytes, 2048 * 1024);
  assert.equal(proc.cpuTimeMs, 3000);
  assert.equal(proc.threadCount, 7);
  assert.equal(proc.handleCount, null);
  assert.equal(proc.createdAt, new Date(1793000000 * 1000 + 123450).toISOString());
  const kernelThread = platform.parseLinuxProcess({ stat: '2 (kthreadd) S 0 0 0 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 1', status: 'Name:\tkthreadd\n', cmdline: '', exe: null },
    { bootTimeSeconds: 1, clockTicks: 100 });
  assert.equal(kernelThread.name, 'kthreadd');
  assert.equal(kernelThread.privateBytes, null);
  const oldKernel = platform.parseLinuxProcess({ stat, status: 'VmRSS:\t 10 kB\n', cmdline: '', exe: '/usr/bin/node (deleted)' }, { bootTimeSeconds: 1 });
  assert.equal(oldKernel.privateBytesSource, 'rss');
  assert.equal(oldKernel.exe, '/usr/bin/node');
});

test('Linux snapshot reads procfs through an injected file system and tolerates vanished processes', async () => {
  const files = { '/proc/stat': 'btime 1793000000\n', '/proc/1234/stat': stat, '/proc/1234/status': status, '/proc/1234/cmdline': 'pwsh\0' };
  const fs = { readdir: async () => ['1234', '999', 'self', 'stat'],
    readFile: async (file) => { if (file in files) return files[file]; throw new Error('ENOENT'); },
    readlink: async (file) => { if (file === '/proc/1234/exe') return '/usr/bin/pwsh'; throw new Error('EACCES'); } };
  const list = await platform.snapshotLinux({ fs });
  assert.deepEqual(list.map((item) => [item.pid, item.exe]), [[1234, '/usr/bin/pwsh']]);
});

test('macOS ps fixture parses lstart, cumulative time and executable paths with spaces', () => {
  const main = [
    '  501     1  20480   0:03.25 Mon Nov  9 09:58:01 2026     /Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '  777   501   1024 1-02:03:04 Tue Nov 10 10:00:00 2026     /usr/local/bin/pwsh',
    '  778   777      8   12:34.00 Wed Nov 11 23:59:59 2026     sleep',
    'malformed line'].join('\n');
  const args = '  501 /Applications/Visual Studio Code.app/Contents/MacOS/Electron --type=x\n  777 pwsh -NoLogo\n';
  const list = platform.parseMacPs(main, args);
  assert.equal(list.length, 3);
  assert.equal(list[0].name, 'Electron');
  assert.equal(list[0].exe, '/Applications/Visual Studio Code.app/Contents/MacOS/Electron');
  assert.equal(list[0].createdAt, new Date(2026, 10, 9, 9, 58, 1).toISOString());
  assert.equal(list[0].cpuTimeMs, 3250);
  assert.equal(list[0].privateBytesSource, 'rss');
  assert.equal(list[1].cpuTimeMs, ((24 + 2) * 3600 + 3 * 60 + 4) * 1000);
  assert.equal(list[1].commandLine, 'pwsh -NoLogo');
  assert.equal(list[2].exe, null);
  assert.equal(list[2].commandLine, null);
  assert.equal(platform.parsePsTime('bad'), null);
  assert.ok(Number.isNaN(platform.parseLstart('Foo Bar 1 00:00:00 2026')));
});

test('executables are located through PATH and PATHEXT without a shell', async () => {
  const existing = new Set(['C:\\Tools\\pwsh.EXE', '/opt/bin/pwsh']);
  const access = async (file) => { if (!existing.has(file)) throw new Error('ENOENT'); };
  assert.equal(await platform.findOnPath('pwsh', { env: { Path: 'C:\\Windows;"C:\\Tools"', PATHEXT: '.COM;.EXE' }, platform: 'win32', access }), 'C:\\Tools\\pwsh.EXE');
  assert.equal(await platform.findOnPath('pwsh', { env: { PATH: '/usr/bin:/opt/bin' }, platform: 'linux', access }), '/opt/bin/pwsh');
  assert.equal(await platform.findOnPath('pwsh', { env: { PATH: '/usr/bin' }, platform: 'darwin', access }), null);
  const fallback = await platform.windowsShell({ env: { Path: 'C:\\none', SystemRoot: 'D:\\Win' }, access });
  assert.equal(fallback, 'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

test('snapshot dispatches per platform with constant arguments and reports collector PIDs', async () => {
  const calls = [];
  const runCommand = async (file, args, options) => { calls.push([file, args, options.env?.LC_ALL]); options.onSpawn?.(4242);
    return file.endsWith('ps') ? '' : '[]'; };
  const windows = await platform.snapshotProcesses({ platform: 'win32', runCommand, shell: 'C:\\pwsh.exe' });
  assert.deepEqual(windows.collectorPids, [4242]);
  assert.equal(calls[0][1].at(-1), platform.windowsScript);
  assert.ok(calls[0][1].includes('-NonInteractive'));
  const mac = await platform.snapshotProcesses({ platform: 'darwin', runCommand });
  assert.equal(mac.source, 'ps');
  assert.equal(calls[1][2], 'C');
  await assert.rejects(platform.snapshotProcesses({ platform: 'aix', runCommand }), { code: 'unsupported' });
});

test('the live snapshot of this machine contains the test process itself', { skip: !['win32', 'linux', 'darwin'].includes(process.platform) }, async () => {
  const result = await platform.snapshotProcesses({ timeout: 15000 });
  const self = result.processes.find((item) => item.pid === process.pid);
  assert.ok(self, 'current process missing');
  assert.equal(self.ppid, process.ppid);
  assert.ok(self.privateBytes > 0 && self.workingSetBytes > 0);
  assert.ok(Math.abs(Date.parse(self.createdAt) - (Date.now() - process.uptime() * 1000)) < 60000);
});