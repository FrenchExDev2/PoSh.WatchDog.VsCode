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
    assert.deepEqual(await axisLabels(), ['0 Gio', '4 Gio', '8 Gio', '12 Gio', '16 Gio']);
    await assertAxisVisible();
    assert.ok(await evaluate(`(()=>{
      const tick=[...document.querySelectorAll('#chart [data-axis=memory]')].find(el=>el.textContent==='8 Gio');
      const threshold=document.querySelector('#chart [data-profile=development][stroke-dasharray="10 5"]');
      return Number(tick.getAttribute('y'))===Number(threshold.getAttribute('y1'));
    })()`), 'Thresholds and Gio ticks use the same scale.');
    assert.equal(await evaluate('document.querySelectorAll("#inventory tr:not(:has(.group))").length'), 3);
    assert.equal(await evaluate('document.querySelectorAll("#inventory .group").length'), 2);
    assert.equal(await evaluate('document.querySelectorAll("#chart polyline").length'), 4, 'Both memory traces retain explicit collection gaps.');
    assert.deepEqual(await evaluate('Array.from(new Set(Array.from(document.querySelectorAll("#chart [data-profile]"),el=>el.dataset.profile))).sort()'), ['build', 'development', 'tests']);
    assert.ok(await evaluate('document.getElementById("chart-legend").textContent.includes("tests · terminal · high 12 GiB")'));
    await evaluate('document.getElementById("show-profiles").click()');
    assert.equal(await evaluate('document.querySelectorAll("#chart [data-profile]").length'), 0);
    assert.deepEqual(await axisLabels(), ['0 Gio', '0.5 Gio', '1 Gio', '1.5 Gio', '2 Gio']);
    for (const bytes of [0, 0.375 * GiB, 32 * GiB]) {
      await post({ ...snapshot, history: [], processes: [{ ...processes[0], privateBytes: bytes, workingSetBytes: bytes / 2 }] });
      const labels = await axisLabels();
      assert.equal(labels[0], '0 Gio');
      assert.ok(Number.parseFloat(labels.at(-1)) >= bytes / GiB);
      assert.ok(labels.length >= 2 && labels.length <= 6);
      await assertAxisVisible();
    }
    await post({ ...snapshot, processes: [], history: [] });
    assert.deepEqual(await axisLabels(), []);
    await post(snapshot);
    await evaluate('document.getElementById("show-profiles").click();');
    checks.push('Gio axis covers zero, fractional and large memory values, rescales without profiles and aligns thresholds with ticks.');
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
    const adjustedHistory = history.map((entry) => ({ ...entry, warningPrivateGiB: 4, restartPrivateGiB: 8,
      processes: entry.processes.map((p) => ({ ...p, thresholds: p.pid === 1 ? { warningPrivateGiB: 2, restartPrivateGiB: 3 } : p.thresholds })) }));
    const report = path.join(directory, 'report.html');
    await fs.writeFile(report, renderReportHtml(buildReportModel({ snapshot: { ...snapshot, history: adjustedHistory }, retained: { scope: 'workspace' } })), 'utf8');
    await send('Page.navigate', { url: pathToFileURL(report).href });
    await until(() => evaluate('document.documentElement.dataset.reportReady==="true"'), 'offline report');
    await evaluate(`document.getElementById('process-select').value=${JSON.stringify(`1:${processes[0].createdAt}`)};document.getElementById('process-select').dispatchEvent(new Event('change'));`);
    assert.ok(await evaluate('Array.from(document.querySelectorAll("#memory-chart .axis")).some(el=>el.textContent==="3.36")'));
    assert.ok(await evaluate('document.getElementById("quality").textContent.includes("workspace across sessions")'));
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    checks.push('Offline report uses the selected process absolute thresholds and explains workspace history scope.');
  });
  const result = { success: true, directory, checks, screenshots: ['desktop.png', 'sidebar.png'] };
  await fs.mkdir(path.join(root, 'verification'), { recursive: true });
  await fs.writeFile(path.join(root, 'verification/dashboard-browser.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result));
}

main().catch((error) => { console.log(JSON.stringify({ success: false, error: error.message, stack: error.stack })); process.exitCode = 1; });
