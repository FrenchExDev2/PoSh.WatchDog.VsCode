'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { dashboardModel, renderDashboardHtml } = require('../src/dashboard');
const { buildReportModel, renderReportHtml } = require('../src/diagnostics-report');
const { until, withBrowser } = require('./browser-harness');
const root = path.resolve(__dirname, '..');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'watchdog-dashboard-browser-'));
  const file = path.join(directory, 'dashboard.html'); await fs.writeFile(file, renderDashboardHtml(), 'utf8');
  const now = Date.now(); const GiB = 1024 ** 3;
  const sample = (pid, kind, parentPid, rootPid, bytes) => ({ pid, kind, parentPid, rootPid,
    createdAt: new Date(now - pid * 1000).toISOString(), measuredAt: new Date(now).toISOString(),
    privateBytes: bytes, workingSetBytes: bytes / 2, cpuPercent: pid * 2, threadCount: 12, handleCount: 80,
    terminalName: kind === 'editorServices' ? '' : 'PowerShell </script><img src=x onerror=globalThis.attacked=true>',
    growth: { deltaMiB: 600, rateMiBPerMinute: 120, observedSeconds: 300, warning: true },
    thresholds: { warningPrivateGiB: 4, restartPrivateGiB: 8 }, activity: { state: 'unknown' } });
  const processes = [sample(1, 'terminal', 99, 1, 2 * GiB), sample(2, 'child', 1, 1, 3 * GiB), sample(3, 'editorServices', 99, 99, 9 * GiB)];
  const history = Array.from({ length: 20 }, (_, i) => ({ at: new Date(now - (19 - i) * 15000).toISOString(), state: 'warning',
    decision: 'Retained growth alert </script><img src=x>', sessionId: i < 10 ? 'previous-session' : 'current-session',
    processes: i === 10 ? [] : processes.map((p) => ({ ...p, privateBytes: p.privateBytes * (i + 1) / 20 })) }));
  const snapshot = { state: 'countdown', detail: 'Synthetic UI qualification fixture.', processes, history, profile: 'development', mode: 'automatic',
    processSampleAgeSeconds: 2, restartCountdown: { deadline: now + 30000, remainingSeconds: 30 },
    health: { lastStartedAt: now - 500, lastCompletedAt: now, durationMs: 500, nextCollectionAt: now + 15000,
      consecutiveErrors: 0, inventoryComplete: true, activity: { state: 'unknown', source: 'unavailable' }, editorAssociation: 'verified', automaticRestartBlockedBy: [] } };
  const checks = [];
  await withBrowser(directory, async ({ send, evaluate, errors, requests }) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.sent=[];window.acquireVsCodeApi=()=>({postMessage:message=>window.sent.push(message)});' });
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: pathToFileURL(file).href });
    await until(() => { if (errors.length) throw new Error(errors.join('\n')); return evaluate('window.sent?.some(m=>m.action==="ready")'); }, 'dashboard ready');
    const post = async (value) => evaluate(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify({ type: 'snapshot', model: dashboardModel(value) })}}))`);
    const axisLabels = () => evaluate('Array.from(document.querySelectorAll("#chart [data-axis=memory]"),el=>el.textContent)');
    const assertAxisVisible = async () => {
      assert.ok(await evaluate(`(()=>{
        const svg=document.getElementById('chart'), bounds=svg.getBoundingClientRect();
        const labels=[...svg.querySelectorAll('[data-axis=memory]')];
        return labels.length>=2 && labels.every(el=>{
          const r=el.getBoundingClientRect();
          return r.left>=bounds.left && r.right<=bounds.right && r.top>=bounds.top && r.bottom<=bounds.bottom && r.height>=10;
        }) && labels.every((el,i)=>i===0 || el.getBoundingClientRect().bottom<labels[i-1].getBoundingClientRect().top);
      })()`), 'Gio labels stay readable, inside the chart and separate from one another.');
    };
    await post(snapshot);
    assert.equal(await evaluate('document.getElementById("show-profiles").checked'), false, 'Only the active workload is drawn by default.');
    assert.deepEqual(await axisLabels(), ['0 GiB', '1 GiB', '2 GiB', '3 GiB', '4 GiB'], 'The scale follows the 2 GiB data and the near 4 GiB threshold, not 16 GiB.');
    await assertAxisVisible();
    assert.ok(await evaluate(`(()=>{
      const tick=[...document.querySelectorAll('#chart [data-axis=memory]')].find(el=>el.textContent==='4 GiB');
      const threshold=document.querySelector('#chart [data-profile=development][stroke-dasharray="3 5"]');
      return Number(tick.getAttribute('y'))===Number(threshold.getAttribute('y1'));
    })()`), 'Thresholds and ticks use the same scale.');
    assert.ok(await evaluate('document.getElementById("chart-legend").textContent.includes("development · terminal · high 8 GiB · active · above scale")'), 'A threshold far above the data is listed, not drawn.');
    assert.equal(await evaluate('document.querySelectorAll("#chart [data-profile]").length'), 1);
    assert.equal(await evaluate('document.querySelectorAll("#inventory tr:not(:has(.group))").length'), 3);
    assert.equal(await evaluate('document.querySelectorAll("#inventory .group").length'), 2);
    assert.equal(await evaluate('document.querySelectorAll("#chart polyline").length'), 4, 'Both memory traces retain explicit collection gaps.');
    await evaluate('document.getElementById("show-profiles").click()');
    assert.deepEqual(await axisLabels(), ['0 GiB', '1 GiB', '2 GiB', '3 GiB', '4 GiB'], 'Other workloads do not flatten the traces.');
    assert.ok(await evaluate('document.getElementById("chart-legend").textContent.includes("tests · terminal · high 12 GiB · above scale")'));
    assert.equal(await evaluate('document.querySelectorAll("#chart-legend li").length'), 6);
    for (const bytes of [0, 0.375 * GiB, 32 * GiB]) {
      await post({ ...snapshot, history: [], processes: [{ ...processes[0], privateBytes: bytes, workingSetBytes: bytes / 2 }] });
      const labels = await axisLabels();
      assert.match(labels[0], /^0 [MG]iB$/);
      assert.ok(Number.parseFloat(labels.at(-1)) * (labels.at(-1).endsWith('GiB') ? GiB : 1024 ** 2) >= bytes);
      assert.ok(labels.length >= 2 && labels.length <= 6);
      await assertAxisVisible();
    }
    await post({ ...snapshot, processes: [], history: [] });
    assert.deepEqual(await axisLabels(), []);
    await post(snapshot);
    checks.push('Memory axis covers zero, MiB-scale and large values, keeps distant thresholds off-scale and aligns drawn thresholds with ticks.');
    assert.deepEqual(await evaluate('Array.from(document.getElementById("live-interval").options,o=>Number(o.value))'), [0, 2000, 5000]);
    assert.equal(await evaluate('document.querySelector("#live-controls label[for=live-interval]").textContent'), 'Refresh interval');
    assert.ok(await evaluate('document.getElementById("live-status").textContent.includes("off")'));
    for (const milliseconds of [2000, 5000, 0]) {
      await evaluate(`document.getElementById('live-interval').value='${milliseconds}';document.getElementById('live-interval').dispatchEvent(new Event('change'));`);
      assert.deepEqual(await evaluate('window.sent.at(-1)'), { action: 'liveInterval', milliseconds });
    }
    await evaluate(`window.dispatchEvent(new MessageEvent('message',{data:${JSON.stringify({ type: 'snapshot', model: { ...dashboardModel(snapshot), liveIntervalMs: 2000 } })}}))`);
    assert.equal(await evaluate('document.getElementById("live-interval").value'), '2000');
    assert.ok(await evaluate('document.getElementById("live-status").textContent.includes("2 s")'));
    assert.equal(await evaluate('typeof window.attacked'), 'undefined'); assert.equal(await evaluate('document.querySelectorAll("img[src=x]").length'), 0);
    checks.push('Development/tests/build thresholds share the selected process chart; profile visibility, collection gaps, hostile text and all three live delays work.');
    await evaluate('document.getElementById("sort").value="tree";document.getElementById("sort").dispatchEvent(new Event("change"));');
    assert.ok(await evaluate('document.getElementById("inventory").textContent.includes("↳ 2")'));
    await evaluate('document.getElementById("kind").value="child";document.getElementById("kind").dispatchEvent(new Event("change"));');
    assert.equal(await evaluate('document.querySelectorAll("#inventory tr:not(:has(.group))").length'), 1);
    await evaluate('document.querySelector("#inventory td:last-child button").click();document.getElementById("profile").value="tests";document.getElementById("profile").dispatchEvent(new Event("change"));');
    for (const action of ['refresh', 'cancelRestart', 'postponeRestart', 'restartNow', 'visualDiagnostics', 'diagnostics']) await evaluate(`document.getElementById(${JSON.stringify(action)}).click()`);
    const messages = await evaluate('window.sent');
    for (const action of ['showTerminal', 'profile', 'refresh', 'cancelRestart', 'postponeRestart', 'restartNow', 'visualDiagnostics', 'diagnostics']) assert.ok(messages.some((m) => m.action === action));
    checks.push('Process tree, kind filter, terminal navigation, profiles and every restart/report action emit the intended message.');
    await evaluate('document.getElementById("kind").value="";document.getElementById("kind").dispatchEvent(new Event("change"));');
    await fs.writeFile(path.join(directory, 'desktop.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate('Math.abs(document.getElementById("chart").viewBox.baseVal.width-document.getElementById("chart").clientWidth)<1'), 'responsive chart scale');
    await assertAxisVisible();
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    assert.ok(await evaluate('(()=>{const r=document.getElementById("live-interval").getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()'), 'Refresh interval is visible in the initial 340px sidebar viewport.');
    await fs.writeFile(path.join(directory, 'sidebar.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
    await post({ ...snapshot, state: 'error', detail: 'Measurement failed.', processes: [], restartCountdown: null,
      health: { ...snapshot.health, consecutiveErrors: 2, lastError: 'collection', inventoryComplete: false, stale: true, automaticRestartBlockedBy: ['measurementStaleOrMissing'] } });
    assert.equal(await evaluate('document.getElementById("countdown").hidden'), true);
    assert.equal(await evaluate('document.getElementById("empty").hidden'), false);
    assert.ok(await evaluate('document.getElementById("health").textContent.includes("measurementStaleOrMissing")'));
    assert.ok(await evaluate('document.querySelectorAll("#chart polyline").length>0'));
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    checks.push('340px sidebar has no page overflow; failed collection clears current inventory while retaining history and health evidence; no script/CSP error or remote request.');
    const MiB = 1024 ** 2;
    const tagged = (pid, targetId, targetLabel, bytes, kind = 'child') => ({ ...sample(pid, kind, 99, 99, bytes), terminalName: '', targetId, targetLabel });
    const multi = [tagged(11, 'pwsh-terminals', 'PowerShell terminals', 53 * MiB, 'terminal'), tagged(12, 'tsserver', 'TypeScript server', 410 * MiB),
      tagged(13, 'csharp', 'C# <b>server</b>', 900 * MiB), tagged(14, 'fixed', 'Fixed', 120 * MiB)];
    const multiHistory = Array.from({ length: 12 }, (_, i) => ({ at: new Date(now - (11 - i) * 15000).toISOString(), state: 'normal', decision: 'ok',
      processes: multi.map((p) => ({ ...p, privateBytes: Math.round(p.privateBytes * (0.5 + i / 22)) })) }));
    const configStatus = { profile: 'default', fallback: false, configs: [
      { name: 'pwsh-terminals', label: 'PowerShell terminals', active: true, builtin: true, mode: 'notifyOnly', warningPrivateGiB: 4, actionPrivateGiB: 8, scaleWithWorkload: true, blockedBy: ['config is notify only'] },
      { name: 'tsserver', label: 'TypeScript server', active: true, builtin: true, automatic: true, mode: 'automatic', restartCommand: 'typescript.restartTsServer', warningPrivateGiB: 2, actionPrivateGiB: 4, scaleWithWorkload: true },
      { name: 'csharp', label: 'C# <img src=x onerror=globalThis.attacked=true>', active: true, needsApproval: true, mode: 'automatic', restartCommand: 'csharp.restart',
        file: 'C:\\Users\\jean\\.frenchexdev\\memory-watchdog\\a-very-long-directory-name-that-must-wrap-inside-the-sidebar\\csharp.watchdog.json', overrides: 'built-in csharp', warningPrivateGiB: 4, actionPrivateGiB: 8 },
      { name: 'fixed', label: 'Fixed', active: true, mode: 'notifyOnly', file: '/home/jean/.frenchexdev/memory-watchdog/fixed.watchdog.json', warningPrivateGiB: 0.1, actionPrivateGiB: 0.2, scaleWithWorkload: false },
      { name: 'rust-analyzer', label: 'rust-analyzer', active: false, builtin: true }],
    issues: [{ severity: 'error', file: '/home/jean/broken.watchdog.json', message: 'Invalid JSON </script><img src=x>' }], warnings: ['Profile "web" lists unknown config "nope".'] };
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false });
    await post({ ...snapshot, state: 'normal', restartCountdown: null, processes: multi, history: multiHistory, profile: 'tests', configs: configStatus });
    assert.equal(await evaluate('document.getElementById("profile").value'), 'tests');
    assert.equal(await evaluate('document.getElementById("configs-section").hidden'), false);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#configs tr"),r=>r.dataset.config)'), ['csharp', 'fixed', 'pwsh-terminals', 'tsserver', 'rust-analyzer']);
    const status = (name) => evaluate(`document.querySelector('#configs [data-config="${name}"] td:nth-child(3)').textContent`);
    assert.equal(await status('csharp'), 'active · needs approval');
    assert.equal(await status('tsserver'), 'active · automatic');
    assert.equal(await status('fixed'), 'active · notify only');
    assert.equal(await status('pwsh-terminals'), 'active · notify only (config is notify only)');
    assert.equal(await status('rust-analyzer'), 'available');
    assert.ok(await evaluate('document.querySelector(\'#configs [data-config="csharp"] td:nth-child(5)\').textContent.endsWith("(overrides built-in csharp)")'));
    assert.deepEqual(await evaluate('(()=>{const c=getComputedStyle(document.querySelector(\'#configs [data-config="csharp"] td:nth-child(5)\'));const r=getComputedStyle(document.querySelector(\'#configs [data-config="csharp"] td:nth-child(4)\'));return [c.textAlign,c.whiteSpace,r.textAlign]})()'), ['left', 'normal', 'left'], 'Configs are left aligned and long sources wrap.');
    assert.ok(await evaluate('document.getElementById("config-issues").textContent.includes("error · /home/jean/broken.watchdog.json: Invalid JSON </script><img src=x>")'));
    assert.ok(await evaluate('document.getElementById("config-issues").textContent.includes(\'warning · Profile "web" lists unknown config "nope".\')'));
    assert.equal(await evaluate('typeof window.attacked'), 'undefined'); assert.equal(await evaluate('document.querySelectorAll("img").length'), 0);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#inventory tr:not(:has(.group)) td:nth-child(2)"),td=>td.textContent).sort()'), ['C# <b>server</b>', 'Fixed', 'PowerShell terminals', 'TypeScript server']);
    assert.deepEqual(await evaluate('Array.from(document.getElementById("kind").options,o=>o.value).filter(v=>v.startsWith("target:"))'), ['target:csharp', 'target:fixed', 'target:pwsh-terminals', 'target:tsserver']);
    await evaluate('document.getElementById("kind").value="target:tsserver";document.getElementById("kind").dispatchEvent(new Event("change"));');
    assert.equal(await evaluate('document.querySelectorAll("#inventory tr:not(:has(.group))").length'), 1);
    await evaluate('document.getElementById("kind").value="";document.getElementById("kind").dispatchEvent(new Event("change"));');
    if (!await evaluate('document.getElementById("show-profiles").checked')) await evaluate('document.getElementById("show-profiles").click()');
    const choose = async (pid) => evaluate(`(()=>{const s=document.getElementById('process-select');s.value=[...s.options].find(o=>o.textContent.startsWith('PID ${pid} ·')).value;s.dispatchEvent(new Event('change'));return s.selectedOptions[0].textContent})()`);
    assert.match(await choose(14), /^PID 14 · Fixed · /, 'The selector names the target.');
    assert.equal((await axisLabels()).at(-1).endsWith('MiB'), true);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#chart [data-profiles]"),el=>el.dataset.profiles)'), ['development tests build', 'development tests build'], 'Identical absolute thresholds are drawn once, not three times.');
    assert.equal(await evaluate('document.querySelectorAll("#chart-legend li").length'), 2);
    await choose(11);
    assert.deepEqual(await axisLabels(), ['0 MiB', '20 MiB', '40 MiB', '60 MiB'], 'A 53 MiB shell gets a MiB scale.');
    assert.equal(await evaluate('document.querySelectorAll("#chart [data-profile]").length'), 0);
    assert.equal(await evaluate('document.querySelectorAll("#chart-legend li[data-offscale]").length'), 6);
    assert.ok(await evaluate(`(()=>{const ys=[...document.querySelectorAll('#chart polyline[data-metric=privateBytes]')].flatMap(p=>p.getAttribute('points').split(' ').map(v=>Number(v.split(',')[1])));return Math.max(...ys)-Math.min(...ys)>50})()`), 'The private trace uses the plot height instead of lying on the axis.');
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'));
    await fs.writeFile(path.join(directory, 'multi-desktop.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
    await send('Emulation.setDeviceMetricsOverride', { width: 340, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until(() => evaluate('Math.abs(document.getElementById("chart").viewBox.baseVal.width-document.getElementById("chart").clientWidth)<1'), 'responsive multi-target chart');
    await assertAxisVisible();
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Configs and Target columns stay inside their scroll areas at 340px.');
    await fs.writeFile(path.join(directory, 'multi-sidebar.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })).data, 'base64'));
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    checks.push('Multi-target fixture: Configs section statuses, sources, issues and alignment, Target column and filter, target-named selector, deduplicated absolute thresholds, MiB scale with off-scale thresholds, hostile labels inert, no overflow at 1440px and 340px.');
    const adjustedHistory = history.map((entry) => ({ ...entry, warningPrivateGiB: 4, restartPrivateGiB: 8,
      processes: entry.processes.map((p) => ({ ...p, thresholds: p.pid === 1 ? { warningPrivateGiB: 2, restartPrivateGiB: 3 } : p.thresholds })) }));
    const report = path.join(directory, 'report.html');
    await fs.writeFile(report, renderReportHtml(buildReportModel({ snapshot: { ...snapshot, history: adjustedHistory }, retained: { scope: 'workspace' } })), 'utf8');
    await send('Page.navigate', { url: pathToFileURL(report).href });
    await until(() => evaluate('document.documentElement.dataset.reportReady==="true"'), 'offline report');
    await evaluate(`document.getElementById('process-select').value=${JSON.stringify(`1:${processes[0].createdAt}`)};document.getElementById('process-select').dispatchEvent(new Event('change'));`);
    assert.deepEqual(await evaluate('Array.from(document.querySelectorAll("#memory-chart .axis"),el=>el.textContent).slice(0,5)'), ['0', '1', '2', '3', 'GiB'], 'Report axis: round ticks up to the process own 3 GiB high threshold.');
    assert.ok(await evaluate('document.querySelector("#memory-chart .restart-line")?.getAttribute("d").includes("M ")'));
    assert.ok(await evaluate('document.getElementById("quality").textContent.includes("workspace across sessions")'));
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    checks.push('Offline report uses the selected process absolute thresholds and explains workspace history scope.');
    // 23:58 → 00:02 in Paris (22:58Z → 23:02Z in winter): time-of-day labels alone would be ambiguous, so they carry the date.
    await send('Emulation.setTimezoneOverride', { timezoneId: 'Europe/Paris' });
    const midnight = Date.parse('2026-11-09T22:58:00Z');
    const crossing = Array.from({ length: 17 }, (_, i) => ({ at: new Date(midnight + i * 15000).toISOString(), state: 'normal', decision: 'ok', sampleIntervalSeconds: 15,
      processes: [{ ...processes[0], privateBytes: GiB }] }));
    const midnightReport = path.join(directory, 'report-midnight.html');
    await fs.writeFile(midnightReport, renderReportHtml(buildReportModel({ snapshot: { ...snapshot, processes: [], history: crossing } })), 'utf8');
    await send('Page.navigate', { url: pathToFileURL(midnightReport).href });
    await until(() => evaluate('document.documentElement.dataset.reportReady==="true"'), 'midnight report');
    assert.ok(await evaluate('document.getElementById("subtitle").textContent.startsWith("Times in Europe/Paris · ")'));
    assert.ok(await evaluate(`(()=>{const labels=[...document.querySelectorAll('#memory-chart text[y="365"]')].map(el=>el.textContent);
      const withDate=new Date(${midnight}).toLocaleString(undefined,{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
      return labels.length===5 && labels[0]===withDate && labels[0]!==new Date(${midnight}).toLocaleTimeString();})()`), 'Labels crossing local midnight include the date.');
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    checks.push('Offline report names its time zone and dates time labels when the range crosses local midnight (Europe/Paris).');
  });
  const result = { success: true, directory, checks, screenshots: ['desktop.png', 'sidebar.png', 'multi-desktop.png', 'multi-sidebar.png'] };
  await fs.mkdir(path.join(root, 'verification'), { recursive: true });
  await fs.writeFile(path.join(root, 'verification/dashboard-browser.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
}

main().catch((error) => { console.log(JSON.stringify({ success: false, error: error.message, stack: error.stack })); process.exitCode = 1; });
