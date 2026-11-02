'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

async function until(action, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await action(); if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out: ${label}`);
}

/** Open an owned headless Edge profile, forbid remote page requests and close it on every outcome. */
async function withBrowser(directory, action) {
  const executable = process.env.WATCHDOG_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  await fs.access(executable);
  const profile = path.join(directory, 'browser-profile');
  const child = spawn(executable, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  let launchError; let ws; let send;
  child.on('error', (error) => { launchError = error; });
  const pending = new Map(); const errors = []; const requests = [];
  try {
    const port = await until(async () => {
      if (launchError) throw launchError;
      try { return Number((await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { return null; }
    }, 'owned browser launch');
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(targets.find((target) => target.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
    let sequence = 0;
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data); const waiting = pending.get(message.id);
      if (waiting) { pending.delete(message.id); clearTimeout(waiting.timer); if (message.error) waiting.reject(new Error(message.error.message)); else waiting.resolve(message.result); }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
      if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url)) requests.push(message.params.request.url);
    });
    send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence; const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    await send('Page.enable'); await send('Runtime.enable'); await send('Log.enable'); await send('Network.enable');
    await send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] });
    return await action({ send, evaluate, errors, requests });
  } finally {
    if (send) { try { await send('Browser.close'); } catch { /* Owned browser may already have stopped. */ } }
    ws?.close(); for (const item of pending.values()) clearTimeout(item.timer);
    if (child.exitCode === null) child.kill();
  }
}

module.exports = { until, withBrowser };
