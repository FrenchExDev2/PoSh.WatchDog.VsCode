'use strict';

const nodePath = require('node:path');
const os = require('node:os');
const fsp = require('node:fs/promises');
const { execFile } = require('node:child_process');

/** Path module matching a platform; Windows paths keep their semantics when tests run elsewhere. */
const pathFor = (platform = process.platform) => (platform === 'win32' ? nodePath.win32 : nodePath.posix);

/** Process names compare without `.exe` everywhere and case-insensitively only on Windows. */
function normalizeName(name, platform = process.platform) {
  if (typeof name !== 'string') return '';
  let value = name.trim();
  if (platform === 'win32') value = value.replace(/\.exe$/i, '').toLowerCase();
  return value;
}

function samePath(left, right, platform = process.platform) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const p = pathFor(platform);
  const a = p.normalize(left); const b = p.normalize(right);
  return platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** Locate an executable through PATH (and PATHEXT on Windows) without invoking a shell. */
async function findOnPath(name, { env = process.env, platform = process.platform, access = fsp.access } = {}) {
  const p = pathFor(platform);
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = String(pathValue).split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const extensions = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = p.join(dir.replace(/^"|"$/g, ''), name + (platform === 'win32' && /\.[a-z0-9]+$/i.test(name) ? '' : extension));
      try { await access(candidate, platform === 'win32' ? undefined : fsp.constants?.X_OK ?? 1); return candidate; } catch { /* Try the next PATH entry. */ }
    }
  }
  return null;
}

const finite = (value) => (Number.isFinite(value) ? value : null);
const nonNegativeInteger = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

function entry(fields, platform) {
  const p = pathFor(platform);
  const exe = typeof fields.exe === 'string' && fields.exe ? fields.exe : null;
  const rawName = fields.name || (exe ? p.basename(exe) : '');
  return {
    pid: fields.pid, ppid: Number.isSafeInteger(fields.ppid) && fields.ppid > 0 ? fields.ppid : null,
    name: normalizeName(rawName, platform), rawName, exe,
    commandLine: typeof fields.commandLine === 'string' ? fields.commandLine : null,
    createdAt: Number.isFinite(fields.createdMs) ? new Date(fields.createdMs).toISOString() : null,
    privateBytes: nonNegativeInteger(fields.privateBytes), workingSetBytes: nonNegativeInteger(fields.workingSetBytes),
    privateBytesSource: fields.privateBytesSource || 'private',
    cpuTimeMs: finite(fields.cpuTimeMs), threadCount: nonNegativeInteger(fields.threadCount), handleCount: nonNegativeInteger(fields.handleCount),
  };
}

// Windows: one CIM query returns identity, ancestry, command line and memory. Command lines stay in memory only.
const windowsScript = "$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" +
  "$r=@(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,ExecutablePath,CommandLine,CreationDate,WorkingSetSize,PrivatePageCount,KernelModeTime,UserModeTime,ThreadCount,HandleCount | ForEach-Object {" +
  "[pscustomobject]@{p=[long]$_.ProcessId;pp=[long]$_.ParentProcessId;n=[string]$_.Name;e=[string]$_.ExecutablePath;c=[string]$_.CommandLine;" +
  "t=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')});ws=[long]$_.WorkingSetSize;pv=[long]$_.PrivatePageCount;" +
  "cpu=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000;th=[long]$_.ThreadCount;h=[long]$_.HandleCount}});" +
  "ConvertTo-Json -InputObject $r -Compress -Depth 3";

function parseWindowsSnapshot(text) {
  const parsed = JSON.parse(String(text).replace(/^\uFEFF/, ''));
  const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  return list.filter((item) => Number.isSafeInteger(item?.p) && item.p > 0).map((item) => entry({
    pid: item.p, ppid: item.pp, name: item.n, exe: item.e || null, commandLine: item.c || null,
    createdMs: item.t ? Date.parse(item.t) : NaN, privateBytes: item.pv, workingSetBytes: item.ws,
    cpuTimeMs: item.cpu, threadCount: item.th, handleCount: item.h,
  }, 'win32'));
}

/** Parse /proc/<pid>/stat; the command name may contain spaces and parentheses. */
function parseLinuxStat(text) {
  const close = text.lastIndexOf(')');
  const open = text.indexOf('(');
  if (open < 0 || close < open) return null;
  const rest = text.slice(close + 2).trim().split(/\s+/);
  const number = (index) => Number(rest[index]);
  return { pid: Number(text.slice(0, open).trim()), comm: text.slice(open + 1, close), ppid: number(1),
    utime: number(11), stime: number(12), threads: number(17), starttime: number(19) };
}

function parseLinuxStatus(text) {
  const values = {};
  for (const line of String(text).split('\n')) {
    const match = /^(\w+):\s+(\d+)\s*kB/.exec(line);
    if (match) values[match[1]] = Number(match[2]) * 1024;
    const name = /^Name:\s*(.*)$/.exec(line);
    if (name) values.Name = name[1].trim();
  }
  return values;
}

function parseLinuxProcess({ stat, status, cmdline, exe }, { bootTimeSeconds, clockTicks = 100 }) {
  const s = parseLinuxStat(stat || '');
  if (!s || !Number.isSafeInteger(s.pid) || s.pid <= 0) return null;
  const memory = parseLinuxStatus(status || '');
  const args = String(cmdline || '').split('\0').filter(Boolean);
  const hasAnon = Number.isFinite(memory.RssAnon);
  const p = pathFor('linux');
  return entry({ pid: s.pid, ppid: s.ppid,
    name: exe ? p.basename(exe.replace(/ \(deleted\)$/, '')) : args[0] ? p.basename(args[0]) : memory.Name || s.comm,
    exe: exe ? exe.replace(/ \(deleted\)$/, '') : null, commandLine: args.length ? args.join(' ') : null,
    createdMs: Number.isFinite(bootTimeSeconds) && Number.isFinite(s.starttime) ? bootTimeSeconds * 1000 + Math.round(s.starttime / clockTicks * 1000) : NaN,
    privateBytes: hasAnon ? memory.RssAnon + (memory.VmSwap || 0) : memory.VmRSS,
    privateBytesSource: hasAnon ? 'anonymous' : 'rss', workingSetBytes: memory.VmRSS,
    cpuTimeMs: Number.isFinite(s.utime) && Number.isFinite(s.stime) ? (s.utime + s.stime) / clockTicks * 1000 : null,
    threadCount: s.threads, handleCount: null }, 'linux');
}

function parseBootTime(procStat) {
  const match = /^btime\s+(\d+)/m.exec(String(procStat));
  return match ? Number(match[1]) : NaN;
}

async function snapshotLinux({ fs = fsp, procRoot = '/proc', clockTicks = 100 } = {}) {
  const bootTimeSeconds = parseBootTime(await fs.readFile(`${procRoot}/stat`, 'utf8'));
  const names = (await fs.readdir(procRoot)).filter((name) => /^\d+$/.test(name));
  const read = (file) => fs.readFile(file, 'utf8').catch(() => null);
  const results = await Promise.all(names.map(async (name) => {
    const dir = `${procRoot}/${name}`;
    const [stat, status, cmdline, exe] = await Promise.all([read(`${dir}/stat`), read(`${dir}/status`), read(`${dir}/cmdline`),
      fs.readlink(`${dir}/exe`).catch(() => null)]);
    return stat ? parseLinuxProcess({ stat, status, cmdline, exe }, { bootTimeSeconds, clockTicks }) : null;
  }));
  return results.filter(Boolean);
}

/** ps cumulative CPU time: [[dd-]hh:]mm:ss[.ss]. */
function parsePsTime(value) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(String(value).trim());
  if (!match) return null;
  const [, days = 0, hours = 0, minutes, seconds] = match;
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
}

const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
/** `ps -o lstart` under LC_ALL=C: "Mon Nov  9 09:58:01 2026", local time. */
function parseLstart(value) {
  const match = /^\w{3}\s+(\w{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2}):(\d{2})\s+(\d{4})$/.exec(String(value).trim());
  if (!match || !(match[1] in months)) return NaN;
  return new Date(Number(match[6]), months[match[1]], Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5])).getTime();
}

function parseMacPs(mainOutput, argsOutput) {
  const args = new Map();
  for (const line of String(argsOutput).split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match) args.set(Number(match[1]), match[2].trim());
  }
  const list = [];
  for (const line of String(mainOutput).split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]); const comm = match[6].trim();
    list.push(entry({ pid, ppid: Number(match[2]), name: pathFor('darwin').basename(comm), exe: comm.startsWith('/') ? comm : null,
      commandLine: args.get(pid) ?? null, createdMs: parseLstart(match[5]), privateBytes: Number(match[3]) * 1024,
      privateBytesSource: 'rss', workingSetBytes: Number(match[3]) * 1024, cpuTimeMs: parsePsTime(match[4]) }, 'darwin'));
  }
  return list;
}

function run(file, args, { timeout, signal, env, maxBuffer = 16 * 1024 * 1024, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout, signal, env, maxBuffer, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      if (error) { const failure = new Error('Process snapshot command failed.'); failure.code = error.killed ? 'timeout' : 'collection'; reject(failure); }
      else resolve(stdout);
    });
    if (child?.pid) onSpawn?.(child.pid);
  });
}

async function windowsShell(options = {}) {
  const env = options.env || process.env;
  const found = await findOnPath('pwsh', { env, platform: 'win32', access: options.access });
  if (found) return found;
  // Windows PowerShell 5.1 is part of every supported Windows edition and remains the portable fallback.
  return pathFor('win32').join(env.SystemRoot || env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Enumerate every visible process with identity, ancestry, command line and memory. */
async function snapshotProcesses({ platform = process.platform, timeout = 3000, signal, runCommand = run, fs, shell } = {}) {
  const collectorPids = [];
  const onSpawn = (pid) => collectorPids.push(pid);
  if (platform === 'win32') {
    const executable = shell || await windowsShell();
    // -Command is not subject to the script execution policy; the script is a constant.
    const output = await runCommand(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsScript], { timeout, signal, onSpawn });
    return { processes: parseWindowsSnapshot(output), source: 'cim', collector: executable, collectorPids };
  }
  if (platform === 'linux') return { processes: await snapshotLinux({ fs }), source: 'procfs', collector: 'procfs', collectorPids };
  if (platform === 'darwin') {
    const env = { ...process.env, LC_ALL: 'C' };
    const [main, args] = await Promise.all([
      runCommand('/bin/ps', ['-axww', '-o', 'pid=,ppid=,rss=,time=,lstart=,comm='], { timeout, signal, env, onSpawn }),
      runCommand('/bin/ps', ['-axww', '-o', 'pid=,args='], { timeout, signal, env, onSpawn })]);
    return { processes: parseMacPs(main, args), source: 'ps', collector: '/bin/ps', collectorPids };
  }
  const error = new Error('Unsupported platform.'); error.code = 'unsupported'; throw error;
}

module.exports = { pathFor, normalizeName, samePath, findOnPath, parseWindowsSnapshot, parseLinuxStat, parseLinuxStatus,
  parseLinuxProcess, parseBootTime, snapshotLinux, parsePsTime, parseLstart, parseMacPs, snapshotProcesses, windowsScript, windowsShell,
  homeDirectory: () => os.homedir() };