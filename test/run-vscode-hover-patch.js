'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { withBrowser } = require('./browser-harness');

const root = path.resolve(__dirname, '..');
const files = ['src/vs/platform/hover/browser/updatableHoverWidget.ts',
  'src/vs/platform/hover/browser/hoverWidget.ts', 'src/vs/base/browser/ui/hover/hover.ts',
  'src/vs/platform/hover/test/browser/hoverService.test.ts'];

/** Locate an existing compiler; this verification never installs packages or changes VS Code. */
async function compiler() {
  if (process.env.WATCHDOG_TEST_TYPESCRIPT) return require(path.resolve(process.env.WATCHDOG_TEST_TYPESCRIPT));
  const candidates = [path.join(root, 'node_modules/typescript/lib/typescript.js')];
  const install = path.join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code Insiders');
  for (const entry of await fs.readdir(install, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) candidates.push(path.join(install, entry.name, 'resources/app/extensions/node_modules/typescript/lib/typescript.js'));
  }
  for (const candidate of candidates) { try { await fs.access(candidate); return require(candidate); } catch { /* Try the next compiler. */ } }
  throw new Error('Set WATCHDOG_TEST_TYPESCRIPT to an existing TypeScript compiler.');
}

/** Run the real source methods against a controlled native-hover delegate in an actual browser DOM. */
async function browserChecks() {
  const sources = window.hoverSources;
  class Disposable { _register(value) { return value; } dispose() {} }
  class CancellationTokenSource {
    constructor() { this.token = { isCancellationRequested: false }; }
    dispose(cancel) { if (cancel) this.token.isCancellationRequested = true; }
  }
  const noops = new Proxy({}, { get: () => () => {} });
  function load(source) {
    const module = { exports: {} };
    const require = (name) => {
      if (name.endsWith('/dom.js')) return { isHTMLElement: (value) => value instanceof HTMLElement };
      if (name.endsWith('/widget.js')) return { Widget: Disposable };
      if (name.endsWith('/lifecycle.js')) return { Disposable, DisposableStore: Disposable, MutableDisposable: Disposable };
      if (name.endsWith('/cancellation.js')) return { CancellationTokenSource };
      if (name.endsWith('/htmlContent.js')) return { isMarkdownString: (value) => typeof value?.value === 'string' };
      if (name.endsWith('/types.js')) return { isFunction: (value) => typeof value === 'function', isString: (value) => typeof value === 'string' };
      if (name.endsWith('/ui/hover/hover.js')) return { isManagedHoverTooltipHTMLElement: (value) => typeof value?.element === 'function',
        isManagedHoverTooltipMarkdownString: (value) => !!value && 'markdown' in value };
      if (name.endsWith('/ui/hover/hoverWidget.js')) return { HoverPosition: { BELOW: 2 } };
      if (name.endsWith('/nls.js')) return { localize: (_key, fallback) => fallback };
      return noops;
    };
    new Function('require', 'module', 'exports', source)(require, module, module.exports);
    return module.exports;
  }
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const checks = [];
  function fixture(tree, legacy = false) {
    const { ManagedHoverWidget } = load(sources[tree].managed);
    const { HoverWidget } = load(sources[tree].widget);
    const parent = document.createElement('section'); document.body.append(parent);
    const target = document.createElement('button'); target.textContent = 'pwsh · fixture'; parent.append(target);
    const state = { created: 0, disposed: 0, layouts: 0, layoutRequests: 0, widgets: [] };
    const delegate = { placement: 'element', showHover(options, focus) {
      const element = document.createElement('div'); element.className = 'monaco-hover'; element.tabIndex = 0;
      const viewport = document.createElement('div'); viewport.className = 'viewport';
      const contents = document.createElement('pre'); contents.className = 'hover-contents';
      contents.textContent = typeof options.content === 'string' ? options.content : options.content?.value || 'HTML';
      viewport.append(contents); element.append(viewport); parent.append(element);
      const widget = Object.create(HoverWidget.prototype);
      Object.assign(widget, { _isDisposed: false, _plainTextContent: typeof options.content === 'string' ? contents : undefined,
        _options: options, _hover: { containerDomNode: element, contentsDomNode: viewport },
        _onRequestLayout: { fire() { state.layoutRequests++; } }, layout() { state.layouts++; },
        dispose() { if (!widget._isDisposed) { state.disposed++; widget._isDisposed = true; element.remove(); options.target.dispose(); } } });
      if (legacy) widget.updateContent = undefined;
      state.created++; state.widgets.push(widget);
      if (focus) element.focus();
      return widget;
    } };
    const manager = new ManagedHoverWidget(delegate, target, false);
    return { manager, state, parent, target, cleanup() { manager.dispose(); parent.remove(); } };
  }

  const baseline = fixture('base');
  await baseline.manager.update('Initial'); const old = baseline.state.widgets[0].domNode;
  await baseline.manager.update('Updated');
  const reproduced = { created: baseline.state.created, disposed: baseline.state.disposed,
    sameNode: baseline.state.widgets.at(-1).domNode === old };
  check(reproduced.created === 2 && reproduced.disposed === 1 && !reproduced.sameNode, 'Baseline must reproduce native-hover replacement.');
  baseline.cleanup(); checks.push('Unpatched upstream source reproduces disposal and DOM replacement.');

  const live = fixture('candidate');
  const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}`).join('\n');
  await live.manager.update(lines, true);
  const widget = live.state.widgets[0], element = widget.domNode, viewport = widget._hover.contentsDomNode;
  viewport.scrollTop = 80; const scrollTop = viewport.scrollTop;
  let removed = 0;
  const observer = new MutationObserver((records) => { for (const record of records) for (const node of record.removedNodes) if (node === element) removed++; });
  observer.observe(live.parent, { childList: true });
  for (let i = 1; i <= 20; i++) {
    await live.manager.update(`${lines}\nMeasurement ${i}`);
    await nextFrame();
    check(element.isConnected && live.state.widgets.at(-1).domNode === element, 'A visible frame lost the original hover node.');
    check(element.textContent.endsWith(`Measurement ${i}`), 'A measurement did not reach the existing hover.');
    check(document.activeElement === element, 'An update lost keyboard focus.');
    check(viewport.scrollTop === scrollTop, 'An update reset scrolling.');
  }
  observer.disconnect();
  check(live.state.created === 1 && live.state.disposed === 0 && removed === 0, 'Updated text recreated or removed the hover.');
  check(live.state.layouts === 20 && live.state.layoutRequests === 20, 'Text updates must request native layout.');
  const stable = { updates: 20, created: live.state.created, disposed: live.state.disposed, removed,
    sameNode: true, focusPreserved: true, scrollPreserved: true, layoutRequests: live.state.layoutRequests };
  checks.push('Twenty updates retain one DOM node across animation frames, preserve focus/scroll, and request layout.');
  const layouts = live.state.layouts;
  await live.manager.update(`${lines}\nMeasurement 20`);
  check(live.state.layouts === layouts && live.state.created === 1, 'Identical text must be a no-op.');
  checks.push('Identical content does not recreate or relayout the hover.');
  await live.manager.update('<img src=x onerror="window.attacked=true">');
  check(element.querySelector('img') === null && !window.attacked, 'Plain text became executable HTML.');
  check(widget._options.content.includes('<img'), 'The retained native options still contain old text.');
  checks.push('Text stays literal and retained native options contain the latest content.');
  await live.manager.update('');
  check(!element.isConnected && live.state.disposed === 1, 'Empty content must close the hover.');
  live.cleanup(); checks.push('Empty content still dismisses the hover.');

  for (const [name, options, focus, content, legacy] of [
    ['changed actions', { actions: [{ commandId: 'changed' }] }, undefined, 'Changed', false],
    ['changed focus', undefined, true, 'Changed', false],
    ['Markdown content', undefined, undefined, { markdown: { value: 'Markdown' } }, false],
    ['legacy hover delegates', undefined, undefined, 'Changed', true],
  ]) {
    const f = fixture('candidate', legacy);
    await f.manager.update('Initial'); const first = f.state.widgets[0].domNode;
    await f.manager.update(content, focus, options);
    check(f.state.created === 2 && f.state.disposed === 1 && !first.isConnected, `${name} did not retain the safe replacement path.`);
    f.cleanup(); checks.push(`${name} retain the existing replacement path.`);
  }
  const disposed = fixture('candidate'); await disposed.manager.update('Initial'); disposed.manager.dispose();
  await disposed.manager.update('Do not reopen');
  check(disposed.state.created === 1 && disposed.state.disposed === 1, 'An update resurrected a closed hover.');
  disposed.cleanup(); checks.push('A dismissed hover is not reopened by later data.');
  return { reproduced, stable, checks };
}

async function main() {
  const fixtureRoot = path.resolve(process.env.WATCHDOG_VSCODE_HOVER_FIXTURE || path.join(root, '.sandbox/vscode-hover-fix'));
  const typescript = await compiler();
  const sources = {}, hashes = {};
  for (const tree of ['base', 'candidate']) {
    sources[tree] = {}; hashes[tree] = {};
    for (const file of files) {
      const source = await fs.readFile(path.join(fixtureRoot, tree, file), 'utf8');
      hashes[tree][file] = createHash('sha256').update(source).digest('hex');
      const result = typescript.transpileModule(source, { reportDiagnostics: true, compilerOptions: {
        target: typescript.ScriptTarget.ES2022, module: typescript.ModuleKind.CommonJS, experimentalDecorators: true,
      } });
      const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === typescript.DiagnosticCategory.Error) || [];
      assert.equal(errors.length, 0, errors.map((error) => typescript.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'));
      if (file.endsWith('/updatableHoverWidget.ts')) sources[tree].managed = result.outputText;
      if (file.endsWith('/hoverWidget.ts')) sources[tree].widget = result.outputText;
    }
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vscode-hover-patch-'));
  const file = path.join(directory, 'hover.html');
  const html = `<!doctype html><meta charset="utf-8"><style>body{font:14px sans-serif;background:#181818;color:#ddd}section{padding:8px}.monaco-hover{width:520px;border:1px solid #777;background:#222;padding:8px}.viewport{overflow:auto;max-height:120px}pre{margin:0;white-space:pre-wrap}</style><script>window.hoverSources=${JSON.stringify(sources).replace(/</g, '\\u003c')};window.runChecks=(${browserChecks.toString()});</script>`;
  await fs.writeFile(file, html, 'utf8');
  const result = await withBrowser(directory, async ({ send, evaluate, errors, requests }) => {
    await send('Page.navigate', { url: pathToFileURL(file).href });
    let ready = false; for (let i = 0; i < 100 && !ready; i++) {
      ready = await evaluate('typeof window.runChecks === "function"');
      if (!ready) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(ready, 'Browser fixture did not load.');
    const data = await evaluate('window.runChecks()');
    assert.deepEqual(errors, []); assert.deepEqual(requests, []);
    return data;
  });
  const report = { success: true, at: new Date().toISOString(), upstreamCommit: 'e2ce8e1b6b05d4522d3a1d4d863665c9cc8e8f02',
    typescript: typescript.version, directory, hashes, ...result,
    limitation: 'Actual upstream methods and browser DOM with a controlled delegate; full VS Code browser suite and installed Electron workbench have not been run.' };
  await fs.writeFile(path.join(fixtureRoot, 'validation.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ success: true, checksPassed: result.checks.length, ...result, report: path.join(fixtureRoot, 'validation.json') }));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
