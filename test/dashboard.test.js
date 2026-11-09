'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dashboardModel, createDashboard } = require('../src/dashboard');
const { defaults } = require('../src/policy');

/** Model two independently visible dashboard surfaces and a deterministic timer queue. */
function fixture(onAction = async () => {}) {
  let provider; let next = 0;
  const pending = new Map(); const errors = [];
  const dashboard = createDashboard({ window: {
    registerWebviewViewProvider(_id, value) { provider = value; return { dispose() {} }; },
    showErrorMessage(message) { errors.push(message); },
  } }, { getSnapshot: () => ({}), onAction, timers: {
    setTimeout(callback, milliseconds) { const id = ++next; pending.set(id, { callback, milliseconds }); return id; },
    clearTimeout(id) { pending.delete(id); },
  } });
  const attach = () => {
    let receive; let visibility; let dispose;
    const messages = [];
    const view = { visible: true, webview: {
      onDidReceiveMessage(callback) { receive = callback; return { dispose() {} }; },
      async postMessage(message) { messages.push(message); return true; },
    }, onDidChangeVisibility(callback) { visibility = callback; return { dispose() {} }; },
    onDidDispose(callback) { dispose = callback; }, dispose() { dispose(); } };
    provider.resolveWebviewView(view);
    return { view, messages, receive: (message) => receive(message),
      visible(value) { view.visible = value; visibility(); } };
  };
  const fire = () => { assert.equal(pending.size, 1); const [id, timer] = pending.entries().next().value; pending.delete(id); return timer.callback(); };
  return { dashboard, attach, pending, errors, fire };
}

test('all three profile thresholds reflect custom settings and absolute per-kind overrides', () => {
  const model = dashboardModel({ policy: { ...defaults, warningPrivateGiB: 2, restartPrivateGiB: 5,
    processThresholds: { terminal: { warningPrivateGiB: 1, restartPrivateGiB: 3 } } } });
  assert.deepEqual(model.profileThresholds.filter((p) => p.kind === 'editorServices').map((p) =>
    [p.profile, p.warningPrivateGiB, p.restartPrivateGiB]), [['development', 2, 5], ['tests', 3, 7.5], ['build', 4, 10]]);
  assert.ok(model.profileThresholds.filter((p) => p.kind === 'terminal').every((p) => p.warningPrivateGiB === 1 && p.restartPrivateGiB === 3));
  assert.ok(dashboardModel({ policy: { warningPrivateGiB: Infinity, restartPrivateGiB: -1 } }).profileThresholds.every((p) => p.warningPrivateGiB === null && p.restartPrivateGiB === null));
});

test('live monitoring accepts exactly the requested delays, shares views and stops at zero', async (t) => {
  const calls = []; const f = fixture(async (action) => calls.push(action)); t.after(() => f.dashboard.dispose());
  const first = f.attach(); const second = f.attach();
  assert.equal(f.pending.size, 0);
  for (const milliseconds of [-1, 1, 100, 250, 500, 1000, 15000, '2000', null, NaN]) await first.receive({ action: 'liveInterval', milliseconds });
  assert.equal(f.pending.size, 0);
  for (const milliseconds of [2000, 5000]) {
    await first.receive({ action: 'liveInterval', milliseconds });
    assert.equal(f.pending.size, 1);
    assert.equal(f.pending.values().next().value.milliseconds, milliseconds);
    assert.equal(second.messages.at(-1).model.liveIntervalMs, milliseconds);
    await f.fire(); assert.equal(calls.at(-1), 'refresh');
    assert.equal(f.pending.values().next().value.milliseconds, milliseconds);
  }
  await second.receive({ action: 'liveInterval', milliseconds: 0 });
  assert.equal(f.pending.size, 0); assert.equal(first.messages.at(-1).model.liveIntervalMs, 0);
});

test('live collection waits for completion, pauses when all views hide and cleans up on disposal', async () => {
  let finish; let calls = 0;
  const f = fixture(() => { calls++; return new Promise((resolve) => { finish = resolve; }); });
  const first = f.attach(); const second = f.attach();
  try {
    await first.receive({ action: 'liveInterval', milliseconds: 2000 });
    const collecting = f.fire(); assert.equal(calls, 1); assert.equal(f.pending.size, 0);
    await second.receive({ action: 'liveInterval', milliseconds: 5000 }); assert.equal(f.pending.size, 0);
    finish(); await collecting; assert.equal(f.pending.values().next().value.milliseconds, 5000);
    first.visible(false); assert.equal(f.pending.size, 1);
    second.visible(false); assert.equal(f.pending.size, 0);
    first.visible(true); assert.equal(f.pending.size, 1);
    first.view.dispose(); assert.equal(f.pending.size, 0);
    second.visible(true); const last = f.fire();
    f.dashboard.dispose(); finish(); await last; assert.equal(f.pending.size, 0);
  } finally { f.dashboard.dispose(); }
});

test('failed live collection reports an outcome and continues; disabling during a collection prevents rescheduling', async (t) => {
  let finish; let fail = true;
  const f = fixture(async () => { if (fail) throw new Error('fixture'); await new Promise((resolve) => { finish = resolve; }); });
  t.after(() => f.dashboard.dispose()); const view = f.attach();
  await view.receive({ action: 'liveInterval', milliseconds: 2000 }); await f.fire();
  assert.equal(f.errors.length, 1); assert.equal(f.pending.size, 1);
  fail = false; const collecting = f.fire();
  await view.receive({ action: 'liveInterval', milliseconds: 0 }); finish(); await collecting;
  assert.equal(f.pending.size, 0);
});
