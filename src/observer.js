'use strict';

const { resolveSession, WatchdogError } = require('./session');
const { withDeadline } = require('./collector');
const { collectWindowProcesses } = require('./selection');

const MAX_PROCESSES = 256;

function validSample(sample) {
  return Number.isSafeInteger(sample.pid) && sample.pid > 0 && Number.isFinite(Date.parse(sample.createdAt)) &&
    Number.isFinite(Date.parse(sample.measuredAt)) && Number.isSafeInteger(sample.privateBytes) && sample.privateBytes >= 0 &&
    Number.isSafeInteger(sample.workingSetBytes) && sample.workingSetBytes >= 0 && Number.isSafeInteger(sample.rootPid);
}

/** The 0.5.x behavior: the built-in default profile. */
const defaultTargets = Object.freeze([
  Object.freeze({ name: 'pwsh-editor-services', label: 'PowerShell Editor Services', adapter: 'powershellEditorServices' }),
  Object.freeze({ name: 'pwsh-terminals', label: 'PowerShell terminals', processNames: ['pwsh'], ownership: 'terminal' }),
  Object.freeze({ name: 'pwsh-children', label: 'PowerShell child processes', processNames: ['pwsh'], ownership: 'child' }),
]);
const legacyTarget = { editorServices: 'pwsh-editor-services', terminal: 'pwsh-terminals', child: 'pwsh-children' };

/** Portable in-process collector; rejects malformed or oversized results rather than interpreting them. */
async function collectProcesses(request, milliseconds, signal) {
  try {
    const result = await collectWindowProcesses(request, milliseconds, signal);
    if (!Array.isArray(result.processes) || result.processes.length > MAX_PROCESSES || !result.processes.every(validSample)) throw new Error('Invalid inventory');
    if (new Set(result.processes.map((sample) => sample.pid)).size !== result.processes.length) throw new Error('Duplicate processes');
    return result;
  } catch (error) {
    if (error instanceof WatchdogError) throw error;
    throw new WatchdogError(error?.code === 'timeout' ? 'timeout' : error?.code === 'unsupported' ? 'unsupported' : 'collection', 'Process collection failed; memory unavailable.');
  }
}

class WindowProcessObserver {
  constructor(vscode, options = {}) {
    this.vscode = vscode;
    this.hostPid = options.hostPid || process.pid;
    this.editorExecutable = options.editorExecutable || process.execPath;
    this.collect = options.collect || collectProcesses;
    this.resolveEditor = options.resolveEditor || resolveSession;
    this.activity = options.activity;
    this.terminals = new Map();
    this.setTargets(options.targets || defaultTargets);
  }

  /** Targets of the active profile: `{ name, label, adapter?, processNames?, ownership?, commandLine?, command? }`. */
  setTargets(targets) {
    this.targetList = targets.map((target) => Object.freeze({ ...target }));
    this.targetsByName = new Map(this.targetList.map((target) => [target.name, target]));
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
    const adapter = this.targetList.find((target) => target.adapter === 'powershellEditorServices');
    let editor = null;
    let editorIssue = null;
    if (adapter) {
      try { editor = await withDeadline(() => this.resolveEditor(this.vscode), Math.min(300, milliseconds / 4), signal); }
      catch (error) {
        editorIssue = ['unsupported', 'ambiguous'].includes(error.code) ? error.code : 'unavailable';
        editor = { state: editorIssue, detail: error.message };
      }
    }
    const active = roots.filter((entry) => entry && this.vscode.window.terminals.includes(entry.terminal) && !entry.terminal.exitStatus);
    const remaining = milliseconds - (Date.now() - start);
    if (remaining <= 0) throw new WatchdogError('timeout', 'Process collection deadline exceeded.');
    const terminalProcessIds = [...new Set(active.map((entry) => entry.pid))];
    const request = { hostProcessId: this.hostPid, rootProcessIds: [...new Set([this.hostPid, ...terminalProcessIds])], terminalProcessIds,
      editorExecutable: this.editorExecutable,
      editor: editor?.pid ? { pid: editor.pid, shellPath: editor.shellPath, logPath: editor.logPath, sessionPath: editor.sessionPath } : null,
      targets: this.targetList.map(({ name, adapter: kind, processNames, ownership, commandLine }) => ({ name, adapter: kind, processNames, ownership, commandLine })) };
    const result = await this.collect(request, remaining, signal);
    // Ancestry verification must still refer to a live terminal of this window after collection.
    const editorVerified = !!result.editorVerified && !!editor?.terminal && this.vscode.window.terminals.includes(editor.terminal) && !editor.terminal.exitStatus;
    this.terminals.clear();
    const processes = result.processes.map((sample) => {
      const isEditor = editorVerified && sample.pid === editor?.pid;
      const kind = isEditor ? 'editorServices' : terminalProcessIds.includes(sample.pid) ? 'terminal' : 'child';
      let targetId = sample.targetId || legacyTarget[kind];
      // The adapter target is only ever assigned to the independently verified Editor Services process.
      if (!isEditor && targetId === adapter?.name) targetId = legacyTarget[kind] === adapter?.name ? null : legacyTarget[kind];
      const target = this.targetsByName.get(targetId);
      return { ...sample,
        cpuTimeMs: Number.isFinite(sample.cpuTimeMs) && sample.cpuTimeMs >= 0 ? sample.cpuTimeMs : null,
        threadCount: Number.isSafeInteger(sample.threadCount) && sample.threadCount >= 0 ? sample.threadCount : null,
        handleCount: Number.isSafeInteger(sample.handleCount) && sample.handleCount >= 0 ? sample.handleCount : null,
        parentPid: Number.isSafeInteger(sample.parentPid) && sample.parentPid > 0 ? sample.parentPid : null,
        kind, targetId: target ? targetId : null, targetLabel: target?.label || null, automaticRestart: isEditor };
    }).filter((sample) => sample.targetId);
    // A generic restart target is actionable only when exactly one process of this window matches it.
    const targets = {};
    for (const target of this.targetList) {
      if (target.adapter || !target.command) continue;
      const matches = processes.filter((sample) => sample.targetId === target.name);
      if (matches.length === 1) {
        matches[0].automaticRestart = true;
        targets[target.name] = { target: { name: target.name, label: target.label, command: target.command, pid: matches[0].pid }, sample: matches[0] };
      } else {
        targets[target.name] = { target: { name: target.name, state: matches.length ? 'ambiguous' : 'waiting',
          detail: matches.length ? `${matches.length} processes match; restart stays manual and alerts apply per process.` : 'No matching process in this window.' }, sample: null };
      }
    }
    for (const sample of processes) {
      const root = active.find((entry) => entry.pid === sample.rootPid || entry.pid === sample.pid);
      if (root) {
        this.terminals.set(`${sample.pid}:${new Date(sample.createdAt).toISOString()}`, root.terminal);
        sample.terminalName = String(root.terminal.name || 'Terminal').slice(0, 120);
        if (targets[sample.targetId]?.sample === sample) targets[sample.targetId].target.terminal = root.terminal;
      }
      sample.activity = this.activity?.get(root?.terminal || (sample.kind === 'editorServices' ? editor?.terminal : null)) || { state: 'unknown', source: 'unavailable' };
    }
    const editorSample = processes.find((sample) => sample.kind === 'editorServices');
    return { target: editorSample ? editor : { state: 'waiting', detail: adapter ? 'No verified Editor Services restart target in this window.' : 'Editor Services is not part of the active profile.' },
      sample: editorSample || null, targets, inventory: { processes, errors: result.errors, limited: result.limited,
        complete: !result.limited && result.errors.length === 0 && unresolvedTerminals === 0,
        unresolvedTerminals, editorIssue, editorDetail: editor?.detail || null, measuredAt: new Date().toISOString(), scope: 'window',
        collector: result.source || null } };
  }

  showTerminal(identity) {
    const terminal = this.terminals.get(identity);
    if (!terminal || !this.vscode.window.terminals.includes(terminal) || terminal.exitStatus) return false;
    terminal.show(); return true;
  }
}

module.exports = { WindowProcessObserver, collectProcesses, validSample, defaultTargets };