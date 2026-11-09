'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { resolveSession, WatchdogError } = require('./session');
const { withDeadline } = require('./collector');

function validSample(sample) {
  return Number.isSafeInteger(sample.pid) && sample.pid > 0 && Number.isFinite(Date.parse(sample.createdAt)) &&
    Number.isFinite(Date.parse(sample.measuredAt)) && Number.isSafeInteger(sample.privateBytes) && sample.privateBytes >= 0 &&
    Number.isSafeInteger(sample.workingSetBytes) && sample.workingSetBytes >= 0 && Number.isSafeInteger(sample.rootPid);
}

function collectProcesses(executable, request, milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
      path.join(__dirname, '../scripts/Measure-WindowProcesses.ps1')],
    { timeout: milliseconds, maxBuffer: 512 * 1024, windowsHide: true, encoding: 'utf8', signal }, (error, stdout) => {
      if (error) return reject(new WatchdogError(error.killed ? 'timeout' : 'collection', 'Process collection failed; memory unavailable.'));
      try {
        const result = JSON.parse(stdout.replace(/^\uFEFF/, ''));
        if (!/^7\./.test(result.powerShellVersion) || !Array.isArray(result.processes) || result.processes.length > 256 ||
          !result.processes.every(validSample) || !Array.isArray(result.errors) || result.errors.length > 256 ||
          typeof result.limited !== 'boolean' || typeof result.editorVerified !== 'boolean') throw new Error('Invalid inventory');
        if (new Set(result.processes.map((sample) => sample.pid)).size !== result.processes.length) throw new Error('Duplicate processes');
        resolve(result);
      } catch { reject(new WatchdogError('collection', 'Invalid process collection response.')); }
    });
    // JSON travels over stdin, never through a shell or a temporary request file.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}

class WindowProcessObserver {
  constructor(vscode, options = {}) {
    this.vscode = vscode;
    this.hostPid = options.hostPid || process.pid;
    this.editorExecutable = options.editorExecutable || process.execPath;
    this.collect = options.collect || collectProcesses;
    this.resolveEditor = options.resolveEditor || resolveSession;
    this.collectorExecutable = options.collectorExecutable;
    this.activity = options.activity;
    this.terminals = new Map();
  }

  async executable(terminals) {
    if (this.collectorExecutable) return this.collectorExecutable;
    const paths = [path.win32.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell/7/pwsh.exe'),
      ...terminals.map((terminal) => terminal.creationOptions?.shellPath).filter((value) =>
        typeof value === 'string' && path.win32.isAbsolute(value) && path.win32.basename(value).toLowerCase() === 'pwsh.exe')];
    for (const candidate of paths) {
      try { await fs.access(candidate); this.collectorExecutable = candidate; return candidate; } catch { /* Try the next installed path. */ }
    }
    // PATH supports portable installations when no absolute installation path was available.
    this.collectorExecutable = 'pwsh.exe';
    return this.collectorExecutable;
  }

  async observe(milliseconds, signal) {
    const start = Date.now();
    const terminals = [...this.vscode.window.terminals].filter((terminal) => !terminal.exitStatus);
    let unresolvedTerminals = Math.max(0, terminals.length - 255);
    const roots = await Promise.all(terminals.slice(0, 255).map(async (terminal) => {
      try {
        const pid = await withDeadline(() => terminal.processId, Math.min(300, milliseconds / 4), signal);
        if (!Number.isSafeInteger(pid) || pid <= 0) { unresolvedTerminals++; return null; }
        return { terminal, pid };
      } catch { unresolvedTerminals++; return null; }
    }));
    let editor;
    let editorIssue = null;
    try { editor = await withDeadline(() => this.resolveEditor(this.vscode), Math.min(300, milliseconds / 4), signal); }
    catch (error) {
      editorIssue = ['unsupported', 'ambiguous'].includes(error.code) ? error.code : 'unavailable';
      editor = { state: editorIssue, detail: error.message };
    }
    const active = roots.filter((entry) => entry && this.vscode.window.terminals.includes(entry.terminal) && !entry.terminal.exitStatus);
    const remaining = milliseconds - (Date.now() - start);
    if (remaining <= 0) throw new WatchdogError('timeout', 'Process collection deadline exceeded.');
    const request = { hostProcessId: this.hostPid, rootProcessIds: [...new Set([this.hostPid, ...active.map((entry) => entry.pid)])],
      editorExecutable: this.editorExecutable,
      editor: editor?.pid ? { pid: editor.pid, shellPath: editor.shellPath, logPath: editor.logPath, sessionPath: editor.sessionPath } : null };
    const result = await this.collect(await this.executable(terminals), request, remaining, signal);
    // Native ancestry verification must still refer to a live terminal of this window after collection.
    const editorVerified = result.editorVerified && this.vscode.window.terminals.includes(editor?.terminal) && !editor.terminal.exitStatus;
    this.terminals.clear();
    const processes = result.processes.map((sample) => ({ ...sample,
      cpuTimeMs: Number.isFinite(sample.cpuTimeMs) && sample.cpuTimeMs >= 0 ? sample.cpuTimeMs : null,
      threadCount: Number.isSafeInteger(sample.threadCount) && sample.threadCount >= 0 ? sample.threadCount : null,
      handleCount: Number.isSafeInteger(sample.handleCount) && sample.handleCount >= 0 ? sample.handleCount : null,
      parentPid: Number.isSafeInteger(sample.parentPid) && sample.parentPid > 0 ? sample.parentPid : null,
      kind: editorVerified && sample.pid === editor?.pid ? 'editorServices' : active.some((entry) => entry.pid === sample.pid) ? 'terminal' : 'child',
      automaticRestart: editorVerified && sample.pid === editor?.pid,
    }));
    for (const sample of processes) {
      const root = active.find((entry) => entry.pid === sample.rootPid || entry.pid === sample.pid);
      if (root) {
        this.terminals.set(`${sample.pid}:${new Date(sample.createdAt).toISOString()}`, root.terminal);
        sample.terminalName = String(root.terminal.name || 'PowerShell').slice(0, 120);
      }
      sample.activity = this.activity?.get(root?.terminal || (sample.automaticRestart ? editor?.terminal : null)) || { state: 'unknown', source: 'unavailable' };
    }
    const editorSample = processes.find((sample) => sample.automaticRestart);
    return { target: editorSample ? editor : { state: 'waiting', detail: 'No verified Editor Services restart target in this window.' },
      sample: editorSample || null, inventory: { processes, errors: result.errors, limited: result.limited,
        complete: !result.limited && result.errors.length === 0 && unresolvedTerminals === 0,
        unresolvedTerminals, editorIssue, editorDetail: editor?.detail || null, measuredAt: new Date().toISOString(), scope: 'window' } };
  }

  showTerminal(identity) {
    const terminal = this.terminals.get(identity);
    if (!terminal || !this.vscode.window.terminals.includes(terminal) || terminal.exitStatus) return false;
    terminal.show(); return true;
  }
}

module.exports = { WindowProcessObserver, collectProcesses, validSample };
