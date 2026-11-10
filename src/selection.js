'use strict';

const vm = require('node:vm');
const fsp = require('node:fs/promises');
const { pathFor, normalizeName, samePath, snapshotProcesses } = require('./platform');

const MAX_DEPTH = 128;
const MAX_SELECTED = 256;
const PATTERN_TIMEOUT_MS = 100;

/**
 * An editor process shares the hosting editor's executable (Windows, Linux) or lives in the same
 * application bundle as the main executable or one of its helpers (macOS).
 */
function editorMatcher(executable, platform = process.platform) {
  if (typeof executable !== 'string' || !executable) return () => false;
  if (platform === 'darwin') {
    const bundle = /^(.*?\.app)\//.exec(executable)?.[1];
    if (!bundle) return (proc) => samePath(proc?.exe, executable, platform);
    const prefix = `${bundle}/`;
    return (proc) => {
      const exe = proc?.exe;
      if (typeof exe !== 'string' || !exe.startsWith(prefix)) return false;
      const rest = exe.slice(prefix.length);
      return /^Contents\/MacOS\/[^/]+$/.test(rest) || /^Contents\/Frameworks\/[^/]*Helper[^/]*\.app\/Contents\/MacOS\/[^/]+$/.test(rest);
    };
  }
  return (proc) => samePath(proc?.exe, executable, platform);
}

const created = (proc) => (proc?.createdAt ? Date.parse(proc.createdAt) : NaN);

/** Resolve the application root through consecutive editor processes, rejecting cycles and reused parent PIDs. */
function editorInstance(proc, byId, isEditor) {
  const seen = new Set();
  for (let depth = 0; proc && depth < MAX_DEPTH; depth++) {
    if (seen.has(proc.pid) || !Number.isFinite(created(proc)) || !isEditor(proc)) return null;
    seen.add(proc.pid);
    const parent = byId.get(proc.ppid);
    if (!parent || !isEditor(parent)) return proc;
    if (!Number.isFinite(created(parent)) || created(parent) > created(proc)) return null;
    proc = parent;
  }
  return null;
}

/**
 * Select processes owned by this window: a descendant of a root (extension host or terminal) whose first
 * editor ancestor belongs to the extension host's own editor instance. The candidate itself may be an
 * editor-executable process (Electron run as Node), but no other editor host is ever crossed.
 */
function selectWindowProcesses(processes, { hostProcessId, rootProcessIds = [], editorExecutable, excludedProcessIds = [],
  platform = process.platform, candidate = () => true } = {}) {
  const byId = new Map(processes.map((proc) => [proc.pid, proc]));
  const isEditor = editorMatcher(editorExecutable, platform);
  const host = byId.get(hostProcessId);
  const hostInstance = host ? editorInstance(host, byId, isEditor) : null;
  const roots = new Set(rootProcessIds);
  const excluded = new Set(excludedProcessIds);
  const selected = [];
  const errors = [];
  for (const proc of processes) {
    if (proc.pid === hostProcessId || excluded.has(proc.pid) || excluded.has(proc.ppid) || !candidate(proc)) continue;
    let cursor = proc;
    const seen = new Set();
    let owned = false; let wasSelected = false; let rootPid = 0;
    for (let depth = 0; cursor && depth < MAX_DEPTH; depth++) {
      if (seen.has(cursor.pid)) break;
      seen.add(cursor.pid);
      if (roots.has(cursor.pid)) { owned = true; rootPid = cursor.pid; }
      if (depth > 0 && isEditor(cursor)) {
        const instance = editorInstance(cursor, byId, isEditor);
        if (owned && hostInstance && instance && instance.pid === hostInstance.pid) { wasSelected = true; selected.push({ proc, rootPid }); }
        break;
      }
      const parent = byId.get(cursor.ppid);
      if (!parent || !Number.isFinite(created(cursor)) || !Number.isFinite(created(parent)) || created(parent) > created(cursor)) break;
      cursor = parent;
    }
    if (owned && !wasSelected && errors.length < MAX_SELECTED) errors.push({ pid: proc.pid, code: 'ownershipUnverified' });
  }
  return { selected, errors, hostVerified: !!hostInstance };
}

/** Evaluate one user pattern over many command lines inside a bounded VM; ReDoS cannot stall the host. */
function testPattern(pattern, lines, timeout = PATTERN_TIMEOUT_MS) {
  try {
    const result = vm.runInNewContext('(() => { const re = new RegExp(pattern, "i"); return lines.map((line) => typeof line === "string" && re.test(line)); })()',
      { pattern, lines }, { timeout });
    return { matches: Array.from(result, Boolean) };
  } catch (error) {
    return { error: error?.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ? 'patternTimeout' : 'invalidPattern' };
  }
}

function ownershipMatches(ownership, entry, { hostProcessId, terminalProcessIds }) {
  const terminal = terminalProcessIds.has(entry.proc.pid);
  if (ownership === 'terminal') return terminal;
  if (ownership === 'child') return !terminal;
  if (ownership === 'extensionHost') return entry.proc.ppid === hostProcessId;
  return ownership === 'window';
}

/** Assign each owned process to the first matching target (profile order). Command lines never leave this function. */
function matchTargets(selected, targets, { hostProcessId, terminalProcessIds = new Set(), platform = process.platform, timeout } = {}) {
  const assigned = new Map();
  const errors = [];
  for (const target of targets) {
    if (target.adapter) continue;
    const names = new Set((target.processNames || []).map((name) => normalizeName(name, platform)));
    const wildcard = names.has('*');
    const pending = selected.filter((entry) => !assigned.has(entry.proc.pid) && (wildcard || names.has(entry.proc.name)) &&
      ownershipMatches(target.ownership, entry, { hostProcessId, terminalProcessIds }));
    if (!pending.length) continue;
    let accepted = pending;
    if (target.commandLine) {
      const result = testPattern(target.commandLine, pending.map((entry) => entry.proc.commandLine), timeout);
      if (result.error) { errors.push({ pid: 0, code: result.error, target: target.name }); continue; }
      accepted = pending.filter((_entry, index) => result.matches[index]);
    }
    for (const entry of accepted) assigned.set(entry.proc.pid, target.name);
  }
  return { assigned, errors };
}

function quotedArgumentCount(commandLine, name, value) {
  const escaped = String(value).replace(/'/g, "''").replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...commandLine.matchAll(new RegExp(`(?:^|\\s)-${name}\\s+'${escaped}'(?=\\s|"|$)`, 'gi'))].length;
}

/** Only the explicitly associated Editor Services process can authorize its restart command. */
function verifyEditorServices(proc, editor, { platform = process.platform, resolvedShellPath } = {}) {
  if (!proc || !editor || proc.pid !== editor.pid || typeof proc.commandLine !== 'string') return false;
  const exeMatches = samePath(proc.exe, editor.shellPath, platform) || samePath(proc.exe, resolvedShellPath, platform) ||
    (!proc.exe && normalizeName(pathFor(platform).basename(editor.shellPath), platform) === proc.name);
  return exeMatches && /Start-EditorServices/i.test(proc.commandLine) && !/-DebugServiceOnly\b/i.test(proc.commandLine) &&
    quotedArgumentCount(proc.commandLine, 'LogPath', editor.logPath) === 1 &&
    quotedArgumentCount(proc.commandLine, 'SessionDetailsPath', editor.sessionPath) === 1;
}

/** Collect one bounded inventory of this window's processes for the configured targets. */
async function collectWindowProcesses(request, milliseconds, signal, { snapshot = snapshotProcesses, platform = process.platform,
  realpath = fsp.realpath, now = () => new Date() } = {}) {
  const { processes, source, collectorPids = [] } = await snapshot({ platform, timeout: milliseconds, signal });
  const measuredAt = now().toISOString();
  const targets = Array.isArray(request.targets) ? request.targets : [];
  const nameSets = targets.filter((target) => !target.adapter).map((target) => new Set((target.processNames || []).map((name) => normalizeName(name, platform))));
  const wildcard = nameSets.some((names) => names.has('*'));
  const adapterTarget = targets.find((target) => target.adapter === 'powershellEditorServices');
  const editorPid = adapterTarget && request.editor?.pid;
  const candidate = (proc) => wildcard || proc.pid === editorPid || nameSets.some((names) => names.has(proc.name));
  const { selected, errors } = selectWindowProcesses(processes, { hostProcessId: request.hostProcessId,
    rootProcessIds: request.rootProcessIds, editorExecutable: request.editorExecutable, excludedProcessIds: collectorPids, platform, candidate });
  const terminalProcessIds = new Set(request.terminalProcessIds || []);
  const matched = matchTargets(selected, targets, { hostProcessId: request.hostProcessId, terminalProcessIds, platform });
  errors.push(...matched.errors);
  let editorVerified = false;
  if (editorPid) {
    const editorEntry = selected.find((entry) => entry.proc.pid === editorPid);
    let resolvedShellPath;
    try { resolvedShellPath = platform === 'win32' ? undefined : await realpath(request.editor.shellPath); } catch { /* Keep the configured path. */ }
    editorVerified = verifyEditorServices(editorEntry?.proc, request.editor, { platform, resolvedShellPath });
    if (editorVerified) matched.assigned.set(editorPid, adapterTarget.name);
  }
  const samples = [];
  let limited = false;
  for (const entry of selected) {
    const targetId = matched.assigned.get(entry.proc.pid);
    if (!targetId) continue;
    const proc = entry.proc;
    if (!proc.createdAt || proc.privateBytes === null || proc.workingSetBytes === null) {
      if (errors.length < MAX_SELECTED) errors.push({ pid: proc.pid, code: 'processUnavailableOrChanged' }); else limited = true;
      continue;
    }
    if (samples.length >= MAX_SELECTED) { limited = true; continue; }
    samples.push({ pid: proc.pid, createdAt: proc.createdAt, privateBytes: proc.privateBytes, workingSetBytes: proc.workingSetBytes,
      privateBytesSource: proc.privateBytesSource, measuredAt, rootPid: entry.rootPid, parentPid: proc.ppid,
      cpuTimeMs: proc.cpuTimeMs, threadCount: proc.threadCount, handleCount: proc.handleCount, targetId, collector: source });
  }
  const available = new Set(processes.map((proc) => proc.pid));
  for (const rootId of request.rootProcessIds || []) if (!available.has(rootId) && errors.length < MAX_SELECTED) errors.push({ pid: rootId, code: 'rootUnavailable' });
  return { processes: samples, errors: errors.slice(0, MAX_SELECTED), limited: limited || errors.length > MAX_SELECTED, editorVerified, source };
}

module.exports = { editorMatcher, editorInstance, selectWindowProcesses, testPattern, matchTargets, verifyEditorServices, collectWindowProcesses };