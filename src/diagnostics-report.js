'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createChartTools } = require('./report-chart');
const { reportClient, reportStyles } = require('./report-view');
const { pruneReports } = require('./history');

const finite = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const text = (value, limit = 2000) => typeof value === 'string' ? value.slice(0, limit) : '';
const time = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;

function normalizeProcess(value) {
  if (!value || !Number.isSafeInteger(value.pid) || value.pid <= 0 || time(value.createdAt) === null) return null;
  const createdAt = new Date(time(value.createdAt)).toISOString();
  return { id: `${value.pid}:${createdAt}`, pid: value.pid, createdAt, kind: text(value.kind, 80) || 'unknown',
    privateBytes: finite(value.privateBytes), workingSetBytes: finite(value.workingSetBytes),
    measuredAt: time(value.measuredAt), automaticRestart: value.automaticRestart === true,
    state: text(value.state, 80), parentPid: finite(value.parentPid), rootPid: finite(value.rootPid),
    cpuPercent: finite(value.cpuPercent), threadCount: finite(value.threadCount), handleCount: finite(value.handleCount),
    thresholds: { warningPrivateGiB: finite(value.thresholds?.warningPrivateGiB), restartPrivateGiB: finite(value.thresholds?.restartPrivateGiB) } };
}

function normalizeEntry(value) {
  if (!value || time(value.at) === null) return null;
  const sample = normalizeProcess(value.sample);
  return { at: time(value.at), state: text(value.state, 80), decision: text(value.decision), mode: text(value.mode, 80),
    warningPrivateGiB: finite(value.warningPrivateGiB), restartPrivateGiB: finite(value.restartPrivateGiB),
    sessionId: text(value.sessionId, 80) || null, profile: text(value.profile, 80) || null,
    sampleIntervalSeconds: finite(value.sampleIntervalSeconds) || null,
    processCount: finite(value.processCount), complete: typeof value.complete === 'boolean' ? value.complete : null,
    omittedProcesses: finite(value.omittedProcesses), collectionErrors: finite(value.collectionErrors), sample,
    processes: (Array.isArray(value.processes) ? value.processes : sample ? [sample] : []).map(normalizeProcess).filter(Boolean) };
}

function buildReportModel({ snapshot, retained = {}, environment = {}, generatedAt = new Date().toISOString() }) {
  const entries = [];
  const seen = new Set();
  let invalidEntries = 0;
  let duplicates = 0;
  for (const raw of [...(retained.entries || []), ...(snapshot.history || [])]) {
    const entry = normalizeEntry(raw);
    if (!entry) { invalidEntries++; continue; }
    const key = JSON.stringify(entry);
    if (seen.has(key)) { duplicates++; continue; }
    seen.add(key); entries.push(entry);
  }
  entries.sort((left, right) => left.at - right.at);
  const currentProcesses = (snapshot.processes || []).map(normalizeProcess).filter(Boolean);
  const series = new Map();
  const include = (process, at) => {
    let item = series.get(process.id);
    if (!item) {
      item = { id: process.id, pid: process.pid, createdAt: process.createdAt, kind: process.kind,
        peakPrivateBytes: null, peakResidentBytes: null, firstAt: at, lastAt: at };
      series.set(item.id, item);
    }
    for (const [source, target] of [['privateBytes', 'peakPrivateBytes'], ['workingSetBytes', 'peakResidentBytes']]) {
      if (process[source] !== null) item[target] = Math.max(item[target] ?? 0, process[source]);
    }
    item.firstAt = Math.min(item.firstAt, at); item.lastAt = Math.max(item.lastAt, at);
    if (process.kind !== 'unknown') item.kind = process.kind;
  };
  for (const entry of entries) {
    for (const process of entry.processes) include(process, entry.at);
    if (entry.sample) include(entry.sample, entry.at);
  }
  for (const process of currentProcesses) include(process, process.measuredAt ?? Date.parse(generatedAt));
  const events = [];
  let previousState = null;
  let previousWarnings = new Set();
  for (const entry of entries) {
    const warnings = new Set(entry.processes.filter((item) => ['warning', 'confirmed'].includes(item.state)).map((item) => `${item.id}:${item.state}`));
    if ((entry.state !== previousState && (entry.state !== 'normal' && entry.state !== 'waiting' || previousState !== null)) ||
        /^Restart\b/.test(entry.decision) || entry.collectionErrors > 0 || [...warnings].some((key) => !previousWarnings.has(key))) {
      events.push({ at: entry.at, state: entry.state, decision: entry.decision,
        warnings: entry.processes.filter((item) => ['warning', 'confirmed'].includes(item.state)).map((item) => ({ pid: item.pid, state: item.state })) });
    }
    previousState = entry.state; previousWarnings = warnings;
  }
  const gaps = entries.slice(1).map((entry, index) => (entry.at - entries[index].at) / 1000).filter((value) => value > 0);
  gaps.sort((left, right) => left - right);
  const inferredInterval = gaps.length ? gaps[Math.floor(gaps.length / 2)] : snapshot.policy?.sampleIntervalSeconds || 15;
  const issues = (retained.issues || []).map((issue) => ({ file: text(issue.file, 80), code: text(issue.code, 80) }));
  const incompleteEntries = entries.filter((entry) => entry.complete !== true || entry.omittedProcesses > 0 ||
    entry.processCount !== null && entry.processCount > entry.processes.length || entry.processes.some((item) => item.privateBytes === null || item.workingSetBytes === null)).length;
  const env = {};
  for (const key of ['extension', 'vscode', 'app', 'platform', 'node', 'powershellExtension']) env[key] = text(environment[key], 160) || null;
  return { schemaVersion: 1, generatedAt, environment: env,
    current: { state: text(snapshot.state, 80), detail: text(snapshot.detail), mode: text(snapshot.mode, 80),
      available: !!snapshot.inventory, complete: snapshot.inventory?.complete === true && currentProcesses.length === (snapshot.processes || []).length,
      processes: currentProcesses, sampleAgeSeconds: finite(snapshot.processSampleAgeSeconds),
      automaticRestarts: finite(snapshot.automaticRestarts), restartOutcome: text(snapshot.restartOutcome, 80) || null },
    entries, series: [...series.values()].sort((left, right) => (right.peakPrivateBytes ?? -1) - (left.peakPrivateBytes ?? -1)), events,
    quality: { filesRead: retained.filesRead || 0, bytesRead: retained.bytesRead || 0, invalidLines: retained.invalidLines || 0,
      invalidEntries, duplicates, issues, incompleteEntries, inferredInterval,
      inferredCadence: entries.some((entry) => !entry.sampleIntervalSeconds), journalError: text(snapshot.journalError) || null,
      historyScope: retained.scope === 'workspace' ? 'workspace' : 'window' } };
}

function renderReportHtml(model) {
  const nonce = randomUUID();
  const data = JSON.stringify(model).replace(/[<>&\u2028\u2029]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; base-uri 'none'; form-action 'none'">
<title>PowerShell Watchdog · Visual diagnostics</title><style nonce="${nonce}">${reportStyles}</style></head>
<body><main><header><p class="eyebrow">POWERSHELL MEMORY WATCHDOG</p><h1>Window diagnostics<span class="badge">OFFLINE REPORT</span></h1><p id="subtitle"></p></header>
<section id="summary" class="cards" aria-label="Current measurements"></section>
<aside id="quality" aria-label="Data coverage"></aside>
<section class="panel"><div class="section-head"><div><h2>Memory over time</h2><p>Private committed and resident memory, measured independently.</p></div><label>Process<select id="process-select"></select></label></div>
<div class="chart-controls"><span class="legend private">Private committed</span><span class="legend resident">Resident</span><label><input id="thresholds" type="checkbox" checked> Show per-process thresholds</label></div>
<div id="chart-empty" class="empty" hidden></div><svg id="memory-chart" viewBox="0 0 1100 390" role="img" aria-label="Process memory history"></svg><p id="chart-readout" class="readout" aria-live="polite"></p><p id="chart-note" class="muted"></p></section>
<div class="columns"><section class="panel"><h2>Largest observed peaks</h2><p>Private committed memory · per process identity</p><div id="ranking"></div></section>
<section class="panel"><h2>Recorded events</h2><p>State changes, memory warnings and restart outcomes.</p><div id="events"></div><div class="pager"><button id="events-prev" type="button">Previous</button><span id="events-page"></span><button id="events-next" type="button">Next</button></div></section></div>
<section class="panel"><h2>Current process inventory</h2><p id="inventory-note"></p><div class="table-wrap"><table><thead><tr><th>PID / created</th><th>Kind</th><th>Private</th><th>Resident</th><th>Automatic restart</th></tr></thead><tbody id="inventory"></tbody></table></div></section>
<section class="panel"><h2>Environment & interpretation</h2><dl id="environment"></dl><ul><li>Current inventory: this VS Code window, its terminals and owned pwsh children. Persistent history can include earlier sessions of the same workspace.</li><li>Thresholds apply to each process. Private and resident memory are never added together.</li><li>Ordinary terminals and child processes use alerts only. Automatic restart is restricted to verified Editor Services.</li><li>Historical inventories retain at most the 20 largest processes per collection; the separate Editor Services sample can provide additional evidence.</li><li>Missing measurements are gaps, not zero. Peaks describe retained observations, not an exhaustive lifetime maximum.</li><li>This is a point-in-time export. Run the command again for an updated report.</li></ul></section>
<footer>Generated locally · No network requests · 1 GiB = 1,073,741,824 bytes</footer></main>
<script id="report-data" type="application/json">${data}</script><script nonce="${nonce}">(${reportClient.toString()})((${createChartTools.toString()})());</script></body></html>`;
}

async function exportVisualReport({ journal, getSnapshot, environment, storagePath, globalStoragePath, openReport, onOpenFailure }) {
  let retained;
  try { retained = await journal.readRetainedHistory(); }
  catch { retained = { entries: [], issues: [{ file: 'journal', code: 'unreadable' }] }; }
  const model = buildReportModel({ snapshot: getSnapshot(), retained, environment });
  const directory = path.join(storagePath || globalStoragePath, 'diagnostic-reports');
  await fs.mkdir(directory, { recursive: true });
  const filePath = path.join(directory, `watchdog-${model.generatedAt.replace(/[:.]/g, '-')}-${randomUUID()}.html`);
  const html = renderReportHtml(model);
  await pruneReports(directory, getSnapshot().policy, Buffer.byteLength(html));
  await fs.writeFile(filePath, html, { encoding: 'utf8', flag: 'wx' });
  let opened = false;
  try { opened = await openReport(filePath, html) === true; } catch { /* Keep the successfully written report. */ }
  if (!opened) await onOpenFailure(filePath);
  return { filePath, opened };
}

module.exports = { normalizeProcess, buildReportModel, renderReportHtml, exportVisualReport };
