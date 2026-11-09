'use strict';

function reportClient(tools) {
  const report = JSON.parse(document.getElementById('report-data').textContent);
  const byId = (id) => document.getElementById(id);
  const GiB = 1073741824;
  const number = (value) => tools.formatBytes(value, 'Unknown');
  const who = (process) => process.targetLabel || process.targetId || process.kind;
  const date = (value) => value == null ? 'Unknown' : new Date(value).toLocaleString();
  function element(tag, value, className) {
    const item = document.createElement(tag);
    if (value !== undefined) item.textContent = value;
    if (className) item.className = className;
    return item;
  }
  function svgElement(tag, attributes, value) {
    const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, attribute] of Object.entries(attributes)) item.setAttribute(key, String(attribute));
    if (value !== undefined) item.textContent = value;
    return item;
  }
  const current = report.current;
  const states = { normal: 'Monitoring', waiting: 'Waiting', warning: 'Memory warning', confirmed: 'Threshold confirmed',
    disabled: 'Monitoring disabled', suspended: 'Suspended', error: 'Measurement unavailable',
    cooldown: 'Stabilizing', deferred: 'Restart deferred', restarting: 'Restarting', unsupported: 'Unsupported', ambiguous: 'Ambiguous association' };
  byId('subtitle').textContent = `Exported ${date(report.generatedAt)} · ${report.entries.length.toLocaleString()} retained collections · ${report.entries.length ? date(report.entries[0].at) + ' — ' + date(report.entries.at(-1).at) : 'No historical measurements'}`;
  const privateKnown = current.processes.every((item) => item.privateBytes !== null);
  const total = current.processes.reduce((sum, item) => sum + (item.privateBytes || 0), 0);
  const exact = current.complete && privateKnown;
  const cards = [
    ['WATCHDOG STATE', states[current.state] || current.state || 'Unknown', current.detail],
    ['MEASURED PROCESSES', current.available ? `${current.complete ? '' : '≥ '}${current.processes.length}` : 'Unknown', 'Owned by this VS Code window'],
    ['PRIVATE MEMORY', current.available ? `${exact ? '' : '≥ '}${number(total)}` : 'Unknown', exact ? 'Sum of the complete current inventory' : 'Observed lower bound · inventory incomplete'],
    ['LATEST COLLECTION', current.sampleAgeSeconds === null ? 'Unknown' : `${Math.round(current.sampleAgeSeconds)} s ago`, `${current.automaticRestarts ?? 'Unknown'} automatic editor restart requests in the rolling hour`],
  ];
  for (const [label, value, detail] of cards) {
    const card = element('article', undefined, 'card');
    card.append(element('p', label, 'eyebrow'), element('strong', value), element('p', detail, 'muted'));
    byId('summary').append(card);
  }
  const quality = report.quality;
  const notes = [`History scope: ${quality.historyScope === 'workspace' ? 'workspace across sessions; the current inventory remains window-scoped' : 'current window journals'}.`,
    `Sources: ${quality.filesRead} retained journal file(s), ${(quality.bytesRead / 1048576).toFixed(2)} MiB read, plus current in-memory history.`,
    `${quality.duplicates} duplicate entries removed.`];
  if (!quality.filesRead) notes.push('No disk journal was available; this report uses the available in-memory history.');
  if (quality.incompleteEntries) notes.push(`${quality.incompleteEntries} historical inventories have partial or unknown coverage. Missing processes and collection errors interrupt their curves.`);
  if (quality.invalidLines || quality.invalidEntries) notes.push(`${quality.invalidLines} invalid JSON line(s) and ${quality.invalidEntries} invalid timestamped entry/entries were ignored.`);
  for (const issue of quality.issues) notes.push(`${issue.file}: ${issue.code === 'byteLimit' ? 'read capped at the journal byte budget' : 'could not be read'}.`);
  if (quality.journalError) notes.push(quality.journalError);
  if (quality.inferredCadence) notes.push('Older entries do not record sampling cadence; long-gap detection uses the median retained interval for those entries.');
  byId('quality').append(element('strong', 'Data coverage'), element('p', notes.join(' ')));
  const selector = byId('process-select');
  for (const process of report.series) {
    const option = element('option', `PID ${process.pid} · ${who(process)} · ${date(process.createdAt)}`);
    option.value = process.id; selector.append(option);
  }
  selector.disabled = !report.series.length;
  function draw() {
    const svg = byId('memory-chart');
    svg.replaceChildren();
    const identity = selector.value;
    const selected = report.series.find((item) => item.id === identity);
    const privateSegments = tools.segments(report.entries, identity, 'privateBytes', quality.inferredInterval);
    const residentSegments = tools.segments(report.entries, identity, 'workingSetBytes', quality.inferredInterval);
    const allPoints = [...privateSegments.flat(), ...residentSegments.flat()];
    const empty = byId('chart-empty');
    empty.hidden = !!allPoints.length; svg.hidden = !allPoints.length;
    if (!allPoints.length) {
      empty.textContent = selected ? 'No retained historical measurements for this process. Current values are listed below.' : 'No measured process is available yet. Run this command again after monitoring has collected data.';
      byId('chart-readout').textContent = '';
      byId('chart-note').textContent = 'Unavailable measurements are never represented as zero.';
      svg.onpointermove = null;
      return;
    }
    let first = report.entries[0].at;
    let last = report.entries.at(-1).at;
    if (first === last) { first -= 15000; last += 15000; }
    const showThresholds = byId('thresholds').checked;
    const threshold = (entry, field) => {
      const process = entry.processes.find((item) => item.id === identity) || (entry.sample?.id === identity ? entry.sample : null);
      return process ? process.thresholds?.[field] ?? entry[field] : null;
    };
    const thresholdValues = showThresholds ? report.entries.flatMap((item) => [threshold(item, 'warningPrivateGiB'), threshold(item, 'restartPrivateGiB')]).filter(Number.isFinite).map((value) => value * GiB) : [];
    const peak = allPoints.reduce((top, point) => Math.max(top, point.value), 0);
    const scale = tools.memoryScale(tools.scaleTop(peak, thresholdValues));
    const maximum = scale.ceilingBytes;
    const x = (at) => 80 + (at - first) / (last - first) * 990;
    const y = (value) => 335 - value / maximum * 305;
    for (const tick of scale.ticks) {
      svg.append(svgElement('line', { x1: 80, x2: 1070, y1: y(tick.bytes), y2: y(tick.bytes), class: 'grid' }),
        svgElement('text', { x: 69, y: y(tick.bytes) + 4, 'text-anchor': 'end', class: 'axis' }, tick.label.replace(/ [MG]iB$/, '')));
    }
    svg.append(svgElement('text', { x: 25, y: 18, class: 'axis' }, scale.unit));
    let offScale = false;
    for (let index = 0; index <= 4; index++) {
      const at = first + (last - first) * index / 4;
      const label = last - first > 86400000 ? new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : new Date(at).toLocaleTimeString();
      svg.append(svgElement('text', { x: x(at), y: 365, 'text-anchor': index === 0 ? 'start' : index === 4 ? 'end' : 'middle', class: 'axis' }, label));
    }
    if (showThresholds) {
      for (const [field, className] of [['warningPrivateGiB', 'warning-line'], ['restartPrivateGiB', 'restart-line']]) {
        let previous = null;
        let commands = '';
        for (const entry of report.entries) {
          const value = threshold(entry, field);
          // A segment above the axis would be drawn outside the plot: break it and say so in the note.
          if (Number.isFinite(value) && value * GiB > maximum) offScale = true;
          if (!Number.isFinite(value) || value * GiB > maximum) { previous = null; continue; }
          if (previous === null) commands += `M ${x(entry.at)} ${y(value * GiB)} `;
          else commands += `H ${x(entry.at)} V ${y(value * GiB)} `;
          previous = value;
        }
        if (commands) svg.append(svgElement('path', { d: commands, class: className }));
      }
    }
    let drawn = 0;
    for (const [segments, className] of [[privateSegments, 'private-line'], [residentSegments, 'resident-line']]) {
      const count = segments.reduce((sum, segment) => sum + segment.length, 0);
      for (const segment of segments) {
        const points = tools.thinSegment(segment, Math.max(4, Math.floor(1000 * segment.length / count)));
        drawn += points.length;
        svg.append(svgElement('path', { d: points.map((point, index) => `${index ? 'L' : 'M'} ${x(point.at)} ${y(point.value)}`).join(' '), class: className }));
        if (points.length === 1) svg.append(svgElement('circle', { cx: x(points[0].at), cy: y(points[0].value), r: 3.5, class: className }));
      }
    }
    svg.dataset.privateSegments = String(privateSegments.length);
    svg.dataset.drawnPoints = String(drawn);
    svg.setAttribute('aria-label', `Private and resident memory for PID ${selected.pid}, created ${selected.createdAt}`);
    const cursor = svgElement('line', { x1: 80, x2: 80, y1: 24, y2: 335, class: 'cursor', visibility: 'hidden' });
    svg.append(cursor);
    svg.onpointermove = (event) => {
      const box = svg.getBoundingClientRect();
      const at = first + Math.max(0, Math.min(1, ((event.clientX - box.left) / box.width * 1100 - 80) / 990)) * (last - first);
      let left = 0; let right = report.entries.length - 1;
      while (left < right) { const middle = Math.floor((left + right) / 2); if (report.entries[middle].at < at) left = middle + 1; else right = middle; }
      const entry = left && Math.abs(report.entries[left - 1].at - at) < Math.abs(report.entries[left].at - at) ? report.entries[left - 1] : report.entries[left];
      const process = entry.processes.find((item) => item.id === identity) || (entry.sample?.id === identity ? entry.sample : null);
      cursor.setAttribute('x1', x(entry.at)); cursor.setAttribute('x2', x(entry.at)); cursor.setAttribute('visibility', 'visible');
      byId('chart-readout').textContent = `Nearest retained collection: ${date(entry.at)} · Private: ${number(process?.privateBytes)} · Resident: ${number(process?.workingSetBytes)} · Warning: ${number(Number.isFinite(threshold(entry, 'warningPrivateGiB')) ? threshold(entry, 'warningPrivateGiB') * GiB : null)} · High: ${number(Number.isFinite(threshold(entry, 'restartPrivateGiB')) ? threshold(entry, 'restartPrivateGiB') * GiB : null)}`;
    };
    byId('chart-readout').textContent = `PID ${selected.pid} · Observed private peak ${number(selected.peakPrivateBytes)} · Resident peak ${number(selected.peakResidentBytes)}`;
    byId('chart-note').textContent = `${privateSegments.length} private-memory segment(s). Gaps remain disconnected. ${drawn.toLocaleString()} plotted points; full retained observations remain embedded. Amber: warning threshold. Red: high threshold (automatic restart only where the target allows it).${offScale ? ' Thresholds above twice the observed peak are not drawn so the curves stay readable.' : ''}`;
  }
  selector.addEventListener('change', draw);
  byId('thresholds').addEventListener('change', draw);
  draw();
  const largest = report.series.slice(0, 10);
  const maximum = largest[0]?.peakPrivateBytes || 1;
  if (!largest.length) byId('ranking').append(element('p', 'No observed peaks yet.', 'empty'));
  for (const process of largest) {
    const row = element('div', undefined, 'rank');
    const button = element('button', `PID ${process.pid} · ${who(process)}`, 'process-link');
    button.type = 'button'; button.addEventListener('click', () => { selector.value = process.id; draw(); byId('memory-chart').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    row.append(button, element('span', number(process.peakPrivateBytes)));
    const bar = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    bar.setAttribute('viewBox', '0 0 100 4'); bar.setAttribute('aria-hidden', 'true');
    bar.append(svgElement('rect', { width: 100, height: 4, rx: 2, class: 'bar-track' }), svgElement('rect', { width: Math.min(100, Math.max(0, (process.peakPrivateBytes || 0) / maximum * 100)), height: 4, rx: 2, class: 'bar-value' }));
    row.append(bar); byId('ranking').append(row);
  }
  let eventPage = 0;
  function drawEvents() {
    const events = byId('events'); events.replaceChildren();
    const sorted = [...report.events].reverse();
    for (const event of sorted.slice(eventPage * 10, eventPage * 10 + 10)) {
      const row = element('article', undefined, 'event');
      row.append(element('time', date(event.at)), element('strong', event.state || 'Recorded event'), element('p', event.decision));
      if (event.warnings.length) row.append(element('p', event.warnings.map((item) => `PID ${item.pid}: ${item.state}`).join(' · '), 'muted'));
      events.append(row);
    }
    if (!sorted.length) events.append(element('p', 'No warning, error or state transition has been recorded.', 'empty'));
    byId('events-page').textContent = `${eventPage + 1} / ${Math.max(1, Math.ceil(sorted.length / 10))} · ${sorted.length} events`;
    byId('events-prev').disabled = eventPage === 0;
    byId('events-next').disabled = (eventPage + 1) * 10 >= sorted.length;
  }
  byId('events-prev').addEventListener('click', () => { eventPage--; drawEvents(); });
  byId('events-next').addEventListener('click', () => { eventPage++; drawEvents(); });
  drawEvents();
  byId('inventory-note').textContent = current.available ? `${current.complete ? 'Complete' : 'Partial'} current inventory · ${current.mode} · ${current.detail}` : `Current measurements unavailable · ${current.detail}`;
  for (const process of current.processes) {
    const row = element('tr');
    for (const value of [`${process.pid} / ${date(process.createdAt)}`, who(process), number(process.privateBytes), number(process.workingSetBytes), process.automaticRestart ? 'Automatic restart' : 'Alerts only']) row.append(element('td', value));
    byId('inventory').append(row);
  }
  if (!current.processes.length) { const row = element('tr'); const cell = element('td', current.available && current.complete ? 'No monitored process in this window.' : 'No current process measurement available.'); cell.colSpan = 5; row.append(cell); byId('inventory').append(row); }
  for (const [key, value] of Object.entries(report.environment)) byId('environment').append(element('dt', key), element('dd', value ?? 'Unknown'));
  document.documentElement.dataset.reportReady = 'true';
}

const reportStyles = `
:root{color-scheme:light;--ink:#172b40;--muted:#536779;--blue:#087ca7;--purple:#7855bd;--line:#dbe4ed;--bg:#eef3f7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 "Segoe UI",system-ui,sans-serif}main{max-width:1440px;margin:auto;padding:42px 38px}header{padding:0 0 25px;border-bottom:2px solid var(--ink);margin-bottom:26px}h1{font-size:38px;line-height:1.2;letter-spacing:-1px;margin:8px 0 14px}h2{font-size:21px;margin:0 0 5px;letter-spacing:-.3px}p{margin:6px 0}.eyebrow{font-size:11px;font-weight:750;letter-spacing:1.8px;color:var(--muted)}.badge{display:inline-block;font-size:10px;letter-spacing:1.3px;border:1px solid #93a8b8;border-radius:4px;padding:6px 9px;vertical-align:middle;margin-left:18px}.cards{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:16px}.card,.panel{background:white;border:1px solid var(--line);border-radius:10px;padding:23px}.card strong{display:block;font-size:27px;margin:9px 0;overflow-wrap:anywhere}.muted,.panel>p,#subtitle{color:var(--muted);font-size:13px}.card .muted{font-size:12px}aside{border-left:4px solid #e1a337;background:#fff8e8;padding:16px 20px;margin:22px 0;font-size:13px}aside strong{font-size:14px}.panel{margin-bottom:23px}.section-head{display:flex;justify-content:space-between;gap:20px;align-items:center}.section-head label{font-size:12px;color:var(--muted);min-width:280px;max-width:55%}select{display:block;width:100%;border:1px solid #aebdca;border-radius:5px;padding:9px;background:white;color:var(--ink);font:inherit;margin-top:5px}button{cursor:pointer;font:inherit;border:1px solid #bdcad6;border-radius:5px;background:white;color:var(--ink);padding:5px 11px}button:disabled{cursor:default;opacity:.45}button:focus-visible,select:focus-visible,input:focus-visible{outline:3px solid #55a7d0;outline-offset:3px}.chart-controls{display:flex;gap:24px;flex-wrap:wrap;margin:24px 0 6px;font-size:12px}.legend:before{content:"";display:inline-block;width:21px;height:3px;margin-right:7px;vertical-align:middle}.private:before{background:var(--blue)}.resident:before{background:var(--purple)}#memory-chart{display:block;width:100%;height:auto;touch-action:pan-y}#memory-chart[hidden]{display:none}.grid{stroke:#e4ebf1;stroke-width:1}.axis{fill:var(--muted);font-size:12px}.private-line,.resident-line,.warning-line,.restart-line{fill:none;stroke-width:2;vector-effect:non-scaling-stroke;stroke-linejoin:round}.private-line{stroke:var(--blue)}.resident-line{stroke:var(--purple)}circle.private-line{fill:var(--blue)}circle.resident-line{fill:var(--purple)}.warning-line{stroke:#b87806;stroke-dasharray:6 5;stroke-width:1.5}.restart-line{stroke:#c24a54;stroke-dasharray:3 4;stroke-width:1.5}.cursor{stroke:#718499;stroke-dasharray:3 3}.readout{background:#f0f6fa;border-radius:5px;padding:10px 13px;font-size:12px;min-height:40px}.columns{display:grid;grid-template-columns:1fr 1fr;gap:23px}.rank{display:grid;grid-template-columns:1fr auto;gap:6px 10px;margin:17px 0;font-size:13px}.rank svg{grid-column:1/-1;width:100%;height:6px}.bar-track{fill:#e8eff4}.bar-value{fill:var(--blue)}.process-link{text-align:left;border:0;padding:0;color:#126f97;font-size:13px}.event{padding:10px 0;border-bottom:1px solid var(--line);font-size:12px}.event time{color:var(--muted);display:block}.event strong{display:block;font-size:13px}.pager{display:flex;justify-content:space-between;align-items:center;margin-top:17px;font-size:12px}.table-wrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;margin-top:18px;text-align:left}th{font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);border-bottom:2px solid var(--line)}th,td{padding:12px 10px;vertical-align:top}td{border-bottom:1px solid var(--line)}dl{display:grid;grid-template-columns:190px 1fr;gap:6px 20px;font-size:13px}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}ul{font-size:12px;color:var(--muted);padding-left:20px}.empty{padding:28px;color:var(--muted);font-size:14px}footer{font-size:12px;color:var(--muted);text-align:center;padding:5px 0 20px}
@media(max-width:850px){main{padding:24px 16px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.columns{grid-template-columns:1fr;gap:0}.section-head{display:block}.section-head label{display:block;max-width:100%;margin-top:16px}h1{font-size:29px}.badge{margin:10px 0 0;display:table}}
@media print{body{background:white}main{max-width:none;padding:0}.panel,.card{break-inside:avoid}.pager{display:none}button{border:0}.columns{display:block}header{margin-top:15px}}
`;

module.exports = { reportClient, reportStyles };
