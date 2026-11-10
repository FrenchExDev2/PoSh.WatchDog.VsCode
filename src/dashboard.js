'use strict';

const { randomUUID } = require('node:crypto');
const { normalizeProcess } = require('./diagnostics-report');
const { createChartTools } = require('./report-chart');
const { defaults, processPolicy } = require('./policy');
const { version } = require('../package.json');

const liveIntervals = [0, 2000, 5000];

/** Bound and allowlist all process data crossing the webview boundary. */
function dashboardModel(snapshot = {}) {
  const process = (value) => {
    const item = normalizeProcess(value);
    if (!item) return null;
    const number = (v) => Number.isFinite(v) && v >= 0 ? v : null;
    return { ...item, parentPid: number(value.parentPid), rootPid: number(value.rootPid),
      terminalName: typeof value.terminalName === 'string' ? value.terminalName.slice(0, 120) : '',
      cpuPercent: number(value.cpuPercent), threadCount: number(value.threadCount), handleCount: number(value.handleCount),
      activity: ['busy', 'idle'].includes(value.activity?.state) ? value.activity.state : 'unknown',
      growth: value.growth ? { deltaMiB: Number.isFinite(value.growth.deltaMiB) ? value.growth.deltaMiB : null,
        rateMiBPerMinute: Number.isFinite(value.growth.rateMiBPerMinute) ? value.growth.rateMiBPerMinute : null,
        observedSeconds: number(value.growth.observedSeconds), warning: value.growth.warning === true } : null,
      thresholds: { warningPrivateGiB: number(value.thresholds?.warningPrivateGiB), restartPrivateGiB: number(value.thresholds?.restartPrivateGiB) },
      targetId: typeof value.targetId === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value.targetId) ? value.targetId : null,
      targetLabel: typeof value.targetLabel === 'string' ? value.targetLabel.slice(0, 80) : '' };
  };
  const text = (value, length) => (typeof value === 'string' ? value.slice(0, length) : '');
  const statusConfigs = Array.isArray(snapshot.configs?.configs) ? snapshot.configs.configs.slice(0, 200) : null;
  const policy = { ...defaults, ...snapshot.policy };
  const factors = { development: 1, tests: 1.5, build: 2 };
  const positive = (value) => Number.isFinite(value) && value > 0 ? value : null;
  // With configs, threshold lines belong to a target; \kind\ then carries the target id the client filters on.
  const profileThresholds = statusConfigs ? ['development', 'tests', 'build'].flatMap((profile) => statusConfigs.filter((item) => item.active).map((item) => {
    const factor = item.scaleWithWorkload === false ? 1 : factors[profile];
    return { profile, kind: text(item.name, 64), warningPrivateGiB: positive(item.warningPrivateGiB * factor), restartPrivateGiB: positive(item.actionPrivateGiB * factor) };
  })) : ['development', 'tests', 'build'].flatMap((profile) =>
    ['editorServices', 'terminal', 'child'].map((kind) => {
      const effective = processPolicy({ ...policy, profile }, kind);
      return { profile, kind, warningPrivateGiB: positive(effective.warningPrivateGiB), restartPrivateGiB: positive(effective.restartPrivateGiB) };
    }));
  const countdownTarget = (snapshot.targets || []).find((item) => !item.primary && item.restartCountdown);
  const configs = statusConfigs ? { profile: text(snapshot.configs.profile, 64), fallback: snapshot.configs.fallback === true,
    configs: statusConfigs.map((item) => ({ name: text(item.name, 64), label: text(item.label, 80), file: text(item.file, 400), builtin: item.builtin === true,
      active: item.active === true, automatic: item.automatic === true, needsApproval: item.needsApproval === true, mode: text(item.mode, 20),
      restartCommand: text(item.restartCommand, 128), blockedBy: (item.blockedBy || []).slice(0, 8).map((reason) => text(reason, 120)), overrides: text(item.overrides, 400) })),
    issues: (snapshot.configs.issues || []).slice(0, 50).map((issue) => ({ severity: text(issue.severity, 10), file: text(issue.file, 400), message: text(issue.message, 400) })),
    warnings: (snapshot.configs.warnings || []).slice(0, 20).map((warning) => text(warning, 400)) } : null;
  return { state: String(snapshot.state || 'waiting').slice(0, 80), detail: String(snapshot.detail || '').slice(0, 2000),
    profileThresholds, configs,
    profile: snapshot.profile || 'development', mode: snapshot.mode, sampleAgeSeconds: snapshot.processSampleAgeSeconds ?? null,
    processes: (snapshot.processes || []).slice(0, 256).map(process).filter(Boolean),
    history: (snapshot.history || []).slice(-200).map((entry) => ({ at: entry.at, sessionId: entry.sessionId,
      state: entry.state, decision: String(entry.decision || '').slice(0, 2000),
      processes: (entry.processes || (entry.sample ? [entry.sample] : [])).slice(0, 21).map(process).filter(Boolean) })),
    capturedAt: Date.now(), restartCountdown: snapshot.restartCountdown ? { ...snapshot.restartCountdown, label: 'Editor Services' } :
      countdownTarget ? { ...countdownTarget.restartCountdown, label: text(countdownTarget.label, 80) } : null, postponeUntil: snapshot.postponeUntil,
    health: snapshot.health || {}, journalError: snapshot.journalError || null };
}

/** Client code runs only in the local, isolated VS Code webview. */
function dashboardClient(tools) {
  const api = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  let model = { processes: [], history: [], health: {} };
  let selection = '';
  const send = (action, extra = {}) => api.postMessage({ action, ...extra });
  const text = (tag, value, className) => { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; };
  const metric = (n, digits = 1) => Number.isFinite(n) ? n.toFixed(digits) : '—';
  const memory = (bytes) => tools.formatBytes(bytes);
  // 0.5.x history has no target id: map its kind to the built-in config that now owns those processes.
  const legacyTargets = { editorServices: 'pwsh-editor-services', terminal: 'pwsh-terminals', child: 'pwsh-children' };
  const targetOf = (p) => p?.targetId || (model.configs ? legacyTargets[p?.kind] : null) || p?.kind;
  const round = (value) => Number(value.toFixed(2));
  const date = (value) => value ? new Date(value).toLocaleString() : '—';
  const number = (value) => Number.isFinite(value) ? String(value) : '—';
  function clock() {
    if (model.restartCountdown) $('countdown-text').textContent = `${model.restartCountdown.label} restart in ${Math.max(0, Math.ceil((model.restartCountdown.deadline - Date.now()) / 1000))}s. Its state will be lost.`;
    const age = model.sampleAgeSeconds;
    $('age').textContent = Number.isFinite(age) ? `Last process collection: ${metric(age + Math.max(0, Date.now() - model.capturedAt) / 1000, 0)}s ago.` : 'No current process collection.';
  }
  function chart() {
    const option = $('process-select');
    const known = new Map();
    for (const entry of model.history) for (const p of entry.processes) known.set(p.id, p);
    for (const p of model.processes) known.set(p.id, p);
    if (!known.has(selection)) selection = model.processes[0]?.id || known.keys().next().value || '';
    option.replaceChildren(...[...known.values()].map((p) => { const o = text('option', `PID ${p.pid} · ${p.targetLabel || p.targetId || p.kind} · ${p.createdAt}`); o.value = p.id; return o; }));
    option.value = selection;
    const observations = new Map();
    const sessions = tools.sessionsOf(model.history.map((entry) => ({ ...entry, sample: null })), selection);
    for (const entry of model.history) {
      if (!tools.relevant(entry, sessions)) continue;
      const p = entry.processes.find((item) => item.id === selection);
      const at = Date.parse(entry.at);
      observations.set(at, p ? { ...p, at } : { at, privateBytes: null, workingSetBytes: null });
    }
    const current = model.processes.find((p) => p.id === selection);
    if (current && Number.isFinite(current.measuredAt)) observations.set(current.measuredAt, { ...current, at: current.measuredAt });
    const points = [...observations.values()].filter((p) => Number.isFinite(p.at)).sort((a, b) => a.at - b.at);
    const svg = $('chart'); svg.replaceChildren();
    const legend = $('chart-legend'); legend.replaceChildren();
    const caption = $('chart-note');
    if (!points.length) { caption.textContent = 'No retained measurement. Missing values remain unknown.'; return; }
    const first = Math.min(...points.map((p) => p.at)); const last = Math.max(...points.map((p) => p.at));
    const span = Math.max(1000, last - first);
    const target = targetOf(known.get(selection));
    const all = $('show-profiles').checked;
    const thresholds = (model.profileThresholds || []).filter((p) => p.kind === target && (all || p.profile === model.profile));
    let dataMax = 0;
    for (const p of points) for (const value of [p.privateBytes, p.workingSetBytes]) if (Number.isFinite(value)) dataMax = Math.max(dataMax, value);
    const GiB = 1024 ** 3;
    const thresholdBytes = thresholds.flatMap((p) => [p.warningPrivateGiB, p.restartPrivateGiB]).filter(Number.isFinite).map((value) => value * GiB);
    const scale = tools.memoryScale(tools.scaleTop(dataMax, thresholdBytes));
    const node = (name, attrs) => { const el = document.createElementNS('http://www.w3.org/2000/svg', name); for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value)); svg.append(el); return el; };
    // Keep labels at a readable size in both the sidebar and the full panel.
    const width = Math.max(220, svg.clientWidth || 1000);
    svg.setAttribute('viewBox', `0 0 ${width} 210`);
    const labels = scale.ticks.map((tick) => tick.label);
    const left = Math.max(...labels.map((label) => label.length)) * 8 + 12;
    const right = width - 12;
    const x = (at) => left + (at - first) / span * (right - left);
    const y = (bytes) => 185 - bytes / scale.ceilingBytes * 165;
    for (let i = 0; i < scale.ticks.length; i++) {
      const level = y(scale.ticks[i].bytes);
      node('line', { x1: left, x2: right, y1: level, y2: level, stroke: 'currentColor', 'stroke-opacity': 0.18, 'data-grid': 'memory' });
      node('text', { x: left - 8, y: level, fill: 'currentColor', 'font-size': 12, 'text-anchor': 'end', 'dominant-baseline': 'middle', 'data-axis': 'memory' }).textContent = labels[i];
    }
    node('line', { x1: left, x2: left, y1: 20, y2: 185, stroke: 'currentColor', 'stroke-opacity': 0.5 });
    const profileColors = { development: '#e6b450', tests: '#ee8fba', build: '#8bd49c' };
    const groupedThresholds = new Map();
    // Identical values (scaleWithWorkload: false, or equal products) share one line instead of overlapping in three colours.
    for (const p of thresholds) for (const [key, label, dash] of [['warningPrivateGiB', 'warning', '3 5'], ['restartPrivateGiB', 'high', '10 5']]) {
      if (!Number.isFinite(p[key])) continue;
      const value = round(p[key]);
      const id = `${key}:${value}`;
      if (!groupedThresholds.has(id)) groupedThresholds.set(id, { key, label, dash, value, profiles: [] });
      groupedThresholds.get(id).profiles.push(p.profile);
    }
    for (const p of groupedThresholds.values()) {
      const active = p.profiles.includes(model.profile);
      const profile = active ? model.profile : p.profiles[0];
      const above = p.value * GiB > scale.ceilingBytes;
      const description = `${p.profiles.join('/')} · ${target} · ${p.label} ${p.value} GiB${active ? ' · active' : ''}${above ? ' · above scale' : ''}`;
      if (!above) {
        const line = node('line', { x1: left, x2: right, y1: y(p.value * GiB), y2: y(p.value * GiB), stroke: profileColors[profile], 'stroke-dasharray': p.dash, 'data-profile': profile, 'data-profiles': p.profiles.join(' ') });
        const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = description; line.append(title);
      }
      const item = text('li', description); item.style.color = profileColors[profile]; if (above) item.dataset.offscale = 'true'; legend.append(item);
    }
    const gaps = points.slice(1).map((p, i) => p.at - points[i].at).filter((v) => v > 0).sort((a, b) => a - b);
    const maximumGap = Math.max(30_000, (gaps[Math.floor(gaps.length / 2)] || 15000) * 2.5);
    for (const [key, color] of [['privateBytes', '#55b5ef'], ['workingSetBytes', '#b393ed']]) {
      let segment = []; let previous = null;
      const flush = () => {
        let trace;
        if (segment.length === 1) trace = node('circle', { cx: x(segment[0].at), cy: y(segment[0][key]), r: 3, fill: color });
        if (segment.length > 1) trace = node('polyline', { points: segment.map((p) => `${x(p.at)},${y(p[key])}`).join(' '), fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-dasharray': key === 'workingSetBytes' ? '5 4' : 'none' });
        if (trace) { trace.setAttribute('data-process', selection); trace.setAttribute('data-metric', key); }
        segment = [];
      };
      for (const p of points) {
        if (!Number.isFinite(p[key]) || (previous !== null && p.at - previous > maximumGap)) flush();
        if (Number.isFinite(p[key])) segment.push(p);
        previous = p.at;
      }
      flush();
    }
    caption.textContent = `${points.length} retained observations · ${date(first)} → ${date(last)}. Blue: private; purple dashed: resident. Threshold lines: dotted warning / long-dashed high for this target${all ? ', all workloads' : ', active workload'}; thresholds above twice the observed peak are listed, not drawn, so the traces stay readable. Latest 200 events across sessions; gaps are not zero.`;
  }

  function inventory() {
    const filter = $('kind').value; const order = $('sort').value;
    const list = model.processes.filter((p) => !filter || (filter.startsWith('target:') ? targetOf(p) === filter.slice(7) : p.kind === filter)).sort((a, b) =>
      order === 'cpu' ? (b.cpuPercent ?? -1) - (a.cpuPercent ?? -1) : order === 'pid' ? a.pid - b.pid : (b.privateBytes ?? -1) - (a.privateBytes ?? -1));
    const groups = new Map();
    for (const p of list) { const root = p.rootPid || p.pid; if (!groups.has(root)) groups.set(root, []); groups.get(root).push(p); }
    const body = $('inventory'); body.replaceChildren();
    for (const [root, processes] of groups) {
      const group = document.createElement('tr'); const title = text('td', `${processes[0].terminalName || 'Window / owned processes'} · root PID ${root}`, 'group'); title.colSpan = 9; group.append(title); body.append(group);
      const byPid = new Map(processes.map((p) => [p.pid, p]));
      const depth = (p) => { const seen = new Set([p.pid]); let d = 0; while (byPid.has(p.parentPid) && !seen.has(p.parentPid)) { seen.add(p.parentPid); p = byPid.get(p.parentPid); d++; } return d; };
      const sorted = order === 'tree' ? [...processes].sort((a, b) => {
        const ancestry = (p) => { const chain = [p.pid]; const seen = new Set(chain); while (byPid.has(p.parentPid) && !seen.has(p.parentPid)) { seen.add(p.parentPid); p = byPid.get(p.parentPid); chain.unshift(p.pid); } return chain; };
        const aPath = ancestry(a); const bPath = ancestry(b);
        for (let i = 0; i < Math.min(aPath.length, bPath.length); i++) if (aPath[i] !== bPath[i]) return aPath[i] - bPath[i];
        return aPath.length - bPath.length;
      }) : processes;
      for (const p of sorted) {
        const row = document.createElement('tr');
        const identity = document.createElement('td'); const button = text('button', `${order === 'tree' ? '↳ '.repeat(Math.min(8, depth(p))) : ''}${p.pid}`);
        button.title = `Select chart · created ${p.createdAt} · parent PID ${p.parentPid ?? 'unknown'}`;
        button.onclick = () => { selection = p.id; chart(); }; identity.append(button); row.append(identity);
        const growth = p.growth ? `${metric(p.growth.deltaMiB)} MiB / ${metric(p.growth.observedSeconds, 0)}s${p.growth.warning ? ' ⚠' : ''}` : '—';
        for (const value of [p.targetLabel || p.kind, memory(p.privateBytes), memory(p.workingSetBytes), Number.isFinite(p.cpuPercent) ? `${metric(p.cpuPercent)}%` : '—', `${number(p.threadCount)} / ${number(p.handleCount)}`, growth, p.activity]) row.append(text('td', value));
        row.title = `Warning ${metric(p.thresholds.warningPrivateGiB)} GiB · high ${metric(p.thresholds.restartPrivateGiB)} GiB · CPU uses one logical core as 100%.`;
        const action = document.createElement('td'); const open = text('button', 'Open'); open.disabled = !p.terminalName;
        open.onclick = () => send('showTerminal', { identity: `${p.pid}:${p.createdAt}` }); action.append(open); row.append(action); body.append(row);
      }
    }
    $('empty').hidden = list.length > 0;
  }

  function targetFilter() {
    const select = $('kind'); const current = select.value; const names = new Map();
    for (const p of model.processes) { const id = targetOf(p); if (id && !legacyTargets[id]) names.set(id, p.targetLabel || id); }
    for (const option of [...select.options]) if (option.value.startsWith('target:')) option.remove();
    for (const [id, label] of [...names].sort((a, b) => a[0].localeCompare(b[0]))) { const option = text('option', `Target · ${label}`); option.value = `target:${id}`; select.append(option); }
    select.value = [...select.options].some((option) => option.value === current) ? current : '';
  }
  function render() {
    $('state').textContent = `${model.state} · ${model.mode || '—'} · ${model.processes.length} process(es)`;
    $('detail').textContent = model.detail;
    $('profile').value = model.profile;
    $('live-interval').value = String(model.liveIntervalMs || 0);
    $('live-status').textContent = model.liveIntervalMs > 0 ? `Live collection every ${model.liveIntervalMs < 1000 ? `${model.liveIntervalMs} ms` : `${model.liveIntervalMs / 1000} s`} after each completed collection, while this dashboard is visible.` : 'Live collection is off. The normal Watchdog collection schedule remains active.';
    const countdown = model.restartCountdown;
    $('countdown').hidden = !countdown;
    $('countdown-text').textContent = countdown ? `${countdown.label} restart in ${Math.max(0, Math.ceil((countdown.deadline - Date.now()) / 1000))}s. Its state will be lost.` : '';
    $('postponed').textContent = model.postponeUntil > Date.now() ? `Restarts postponed until ${date(model.postponeUntil)}.` : '';
    const health = model.health || {};
    $('health').replaceChildren();
    const pairs = [ ['Collection status', health.collecting ? 'collecting' : 'waiting'], ['Last collection start', date(health.lastStartedAt)], ['Last collection end', date(health.lastCompletedAt)],
      ['Collection duration', Number.isFinite(health.durationMs) ? `${health.durationMs}ms` : '—'], ['Next collection', date(health.nextCollectionAt)],
      ['Measurement age', Number.isFinite(model.sampleAgeSeconds) ? `${metric(model.sampleAgeSeconds, 0)}s${health.stale ? ' · stale' : ''}` : 'unknown'],
      ['Consecutive errors', number(health.consecutiveErrors)], ['Last error', health.lastError || 'none'],
      ['Inventory', health.inventoryComplete ? 'complete' : 'partial / unavailable'], ['Editor association', health.editorAssociation || 'unknown'],
      ['Editor activity', `${health.activity?.state || 'unknown'} (${health.activity?.source || 'unavailable'})`],
      ['Automatic restart blocked by', (health.automaticRestartBlockedBy || []).join(', ') || 'No current blocker; thresholds still apply.'],
      ['History storage', model.journalError || 'available'] ];
    for (const [name, value] of pairs) $('health').append(text('dt', name), text('dd', value));
    const events = model.history.slice(-30).reverse().map((e) => text('li', `${date(e.at)} · ${e.state} · ${e.decision}`));
    $('events').replaceChildren(...events);
    configs(); targetFilter(); inventory(); chart(); clock();
  }
  function configs() {
    const status = model.configs;
    $('configs-section').hidden = !status;
    if (!status) return;
    $('configs-profile').textContent = `Active profile: ${status.profile}${status.fallback ? ' (fallback: the configured profile does not exist; automatic restarts disabled)' : ''}.`;
    const rows = status.configs.slice().sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)).map((item) => {
      const row = document.createElement('tr'); row.dataset.config = item.name;
      const state = !item.active ? 'available' : item.automatic ? 'active · automatic' : item.needsApproval ? 'active · needs approval' : `active · notify only${item.blockedBy.length ? ` (${item.blockedBy.join(', ')})` : ''}`;
      for (const value of [item.name, item.label, state, item.restartCommand || '—', `${item.builtin ? 'built-in' : item.file}${item.overrides ? ` (overrides ${item.overrides})` : ''}`]) row.append(text('td', value));
      return row;
    });
    $('configs').replaceChildren(...rows);
    $('config-issues').replaceChildren(...[...status.issues.map((issue) => text('li', `${issue.severity} · ${issue.file}: ${issue.message}`)), ...status.warnings.map((warning) => text('li', `warning · ${warning}`))]);
  }
  $('profile').onchange = () => send('profile', { profile: $('profile').value });
  $('live-interval').onchange = () => send('liveInterval', { milliseconds: Number($('live-interval').value) });
  $('show-profiles').onchange = chart;
  new ResizeObserver(chart).observe($('chart'));
  $('sort').onchange = inventory; $('kind').onchange = inventory;
  $('process-select').onchange = () => { selection = $('process-select').value; chart(); };
  for (const action of ['refresh', 'cancelRestart', 'postponeRestart', 'restartNow', 'visualDiagnostics', 'diagnostics']) $(action).onclick = () => send(action);
  window.addEventListener('message', (event) => { if (event.data?.type === 'snapshot') { model = event.data.model; render(); } });
  setInterval(clock, 1000);
  send('ready');
}

function renderDashboardHtml() {
  const nonce = randomUUID();
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'"><title>Memory Watchdog · Live dashboard</title><style nonce="${nonce}">
body{font-family:var(--vscode-font-family,system-ui);color:var(--vscode-foreground,#ddd);background:var(--vscode-editor-background,#181818);margin:0;padding:16px;line-height:1.45}main{max-width:1400px;margin:auto}h1{font-size:22px}h2{font-size:16px}section{border:1px solid var(--vscode-panel-border,#444);padding:14px;border-radius:8px;margin:14px 0}button,select{font:inherit;color:inherit;background:var(--vscode-dropdown-background,#333);border:1px solid var(--vscode-dropdown-border,#666);border-radius:4px;padding:5px 9px;max-width:100%}button{cursor:pointer}button:disabled{opacity:.45;cursor:default}button:focus-visible,select:focus-visible{outline:2px solid var(--vscode-focusBorder,#55b5ef)}.toolbar{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.muted{opacity:.8;font-size:12px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{padding:7px 9px;text-align:right;white-space:nowrap;border-bottom:1px solid var(--vscode-panel-border,#444)}th:first-child,td:first-child,td:nth-child(2){text-align:left}table.configs th,table.configs td{text-align:left}table.configs td:nth-child(3),table.configs td:nth-child(5){white-space:normal;overflow-wrap:anywhere;min-width:14ch}.group{text-align:left;background:var(--vscode-list-hoverBackground,#292929)}svg{width:100%;min-height:150px}dl{display:grid;grid-template-columns:minmax(100px,1fr) minmax(100px,2fr);gap:8px;font-size:12px}dd{margin:0;overflow-wrap:anywhere}dt{opacity:.8}li{overflow-wrap:anywhere;margin:8px 0}#countdown{border-color:#c79641}#process-select{width:100%}[hidden]{display:none!important}@media(max-width:400px){body{padding:8px}section{padding:9px}dl{grid-template-columns:1fr}dd{margin-bottom:6px}}
</style></head><body><main><p class="muted">FRENCHEXDEV MEMORY WATCHDOG · LIVE · v${version}</p><h1>Window dashboard</h1><p id="state">Waiting for a snapshot…</p><p id="detail"></p>
<p id="age" class="muted"></p><section id="live-controls" aria-labelledby="live-heading"><h2 id="live-heading">Live monitoring</h2><div class="toolbar"><label for="live-interval">Refresh interval</label><select id="live-interval"><option value="0">0 · Off</option><option value="2000">2 s</option><option value="5000">5 s</option></select><button id="refresh">Collect now</button></div><p id="live-status" class="muted" role="status">Live collection is off. Choose a refresh interval to enable it.</p></section><div class="toolbar"><button id="visualDiagnostics">Export HTML</button><button id="diagnostics">JSON diagnostics</button><label>Workload <select id="profile"><option value="development">Development · ×1</option><option value="tests">Tests · ×1.5</option><option value="build">Build · ×2</option></select></label></div>
<section id="countdown" hidden aria-live="polite"><h2 id="countdown-text"></h2><div class="toolbar"><button id="cancelRestart">Cancel this episode</button><button id="postponeRestart">Postpone 5 minutes</button><button id="restartNow">Restart now</button></div></section><p id="postponed"></p>
<section><h2>Memory history</h2><select id="process-select" aria-label="Chart process"></select><label><input id="show-profiles" type="checkbox"> Show all workload profiles (otherwise the active one)</label><svg id="chart" viewBox="0 0 1000 210" role="img" aria-label="Private and resident memory over time with workload profile thresholds"></svg><ul id="chart-legend" class="muted"></ul><p id="chart-note" class="muted"></p></section>
<section><h2>Monitored processes</h2><div class="toolbar"><label>Sort <select id="sort"><option value="private">Private memory</option><option value="cpu">CPU</option><option value="pid">PID</option><option value="tree">Process tree</option></select></label><label>Filter <select id="kind"><option value="">All</option><option value="editorServices">Editor Services</option><option value="terminal">Terminal</option><option value="child">Child</option></select></label></div><div class="scroll"><table><thead><tr><th>PID</th><th>Target</th><th>Private</th><th>Resident</th><th>CPU</th><th>Threads / handles</th><th>Growth</th><th>Activity</th><th>Terminal</th></tr></thead><tbody id="inventory"></tbody></table></div><p id="empty">No current process measurement.</p><p class="muted">Grouped by terminal/root. CPU: 100% = one logical core, can exceed 100%. Growth describes retained observations, not proof of a leak. Automatic restarts: verified Editor Services, or a target with its own restart command when exactly one process matches it.</p></section>
<section><h2>Watchdog health</h2><dl id="health"></dl></section><section id="configs-section" hidden><h2>Configs</h2><p id="configs-profile"></p><div class="scroll"><table class="configs"><thead><tr><th>Name</th><th>Label</th><th>Status</th><th>Restart command</th><th>Source</th></tr></thead><tbody id="configs"></tbody></table></div><ul id="config-issues" class="muted"></ul></section><section><h2>Recent history</h2><ol id="events"></ol><p class="muted">Persisted history is workspace-scoped across sessions. Export HTML to inspect all retained entries. No command text, terminal output or working directory is collected.</p></section></main><script nonce="${nonce}">(${dashboardClient.toString()})((${createChartTools.toString()})());</script></body></html>`;
}

/** Share a live model between an activity-bar view and an optional editor panel. */
function createDashboard(vscode, { getSnapshot, onAction, onError = () => {}, timers = { setTimeout, clearTimeout } }) {
  const views = new Set(); let panel; let liveIntervalMs = 0; let timer; let collecting = false; let disposed = false;
  const post = (webview) => webview.postMessage({ type: 'snapshot', model: { ...dashboardModel(getSnapshot()), liveIntervalMs } });
  const update = () => { for (const view of views) void post(view.webview).then(undefined, () => {}); };
  const visible = () => [...views].some((view) => view.visible !== false);
  const schedule = () => {
    timers.clearTimeout(timer); timer = undefined;
    if (disposed || collecting || !liveIntervalMs || !visible()) return;
    timer = timers.setTimeout(async () => {
      timer = undefined;
      if (disposed || !visible()) return;
      collecting = true;
      try { await onAction('refresh'); }
      catch (error) { onError('Live collection', error); if (!disposed) void vscode.window.showErrorMessage('Watchdog live collection failed. See Output → Memory Watchdog.'); }
      finally { collecting = false; if (!disposed) { update(); schedule(); } }
    }, liveIntervalMs);
  };
  const attach = (view) => {
    views.add(view);
    view.webview.options = { enableScripts: true, enableForms: false, enableCommandUris: false, localResourceRoots: [] };
    const receiving = view.webview.onDidReceiveMessage(async (message) => {
      try {
        if (message?.action === 'ready') { await post(view.webview); return; }
        if (message?.action === 'liveInterval' && liveIntervals.includes(message.milliseconds)) {
          liveIntervalMs = message.milliseconds; schedule(); update(); return;
        }
        const actions = ['refresh', 'cancelRestart', 'postponeRestart', 'restartNow', 'visualDiagnostics', 'diagnostics'];
        if (actions.includes(message?.action)) await onAction(message.action);
        else if (message?.action === 'profile' && ['development', 'tests', 'build'].includes(message.profile)) await onAction('profile', message.profile);
        else if (message?.action === 'showTerminal' && typeof message.identity === 'string' && /^\d+:\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(message.identity)) await onAction('showTerminal', message.identity);
      } catch (error) { onError('Dashboard action', error); void vscode.window.showErrorMessage('Watchdog dashboard action failed. See Output → Memory Watchdog.'); }
    });
    const visibility = (view.onDidChangeVisibility || view.onDidChangeViewState)?.call(view, schedule);
    view.onDidDispose(() => { receiving.dispose(); visibility?.dispose(); views.delete(view); if (panel === view) panel = undefined; schedule(); });
    view.webview.html = renderDashboardHtml();
    void post(view.webview);
    schedule();
  };
  const provider = vscode.window.registerWebviewViewProvider('memoryWatchdog.dashboardView', { resolveWebviewView: attach });
  return {
    open() { if (!panel) { panel = vscode.window.createWebviewPanel('memoryWatchdog.dashboard', 'Memory Watchdog · Live', vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: false }); attach(panel); } panel.reveal(); },
    update,
    dispose() { disposed = true; timers.clearTimeout(timer); provider.dispose(); for (const view of [...views]) view.dispose(); views.clear(); },
  };
}

module.exports = { dashboardModel, dashboardClient, renderDashboardHtml, createDashboard };
