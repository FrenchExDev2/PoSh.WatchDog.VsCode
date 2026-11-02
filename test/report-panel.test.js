'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReportPanel } = require('../src/report-panel');
const { buildReportModel, renderReportHtml } = require('../src/diagnostics-report');

function editor() {
  const panels = [];
  const vscode = { ViewColumn: { Active: -1 }, window: {
    createWebviewPanel(viewType, title, column, options) {
      let onDispose;
      const panel = { viewType, title, column, options, webview: {}, reveals: 0, disposed: false,
        onDidDispose(callback) { onDispose = callback; },
        reveal() { this.reveals++; },
        dispose() { this.disposed = true; onDispose(); },
      };
      panels.push(panel);
      return panel;
    },
  } };
  return { panels, view: createReportPanel(vscode) };
}

test('visual diagnostics opens the offline interactive report in an editor webview', () => {
  const { panels, view } = editor();
  const html = renderReportHtml(buildReportModel({ snapshot: { history: [], processes: [] } }));
  assert.equal(view.open(html), true);
  assert.equal(panels.length, 1);
  assert.equal(panels[0].viewType, 'powershellWatchdog.visualDiagnostics');
  assert.equal(panels[0].column, -1);
  assert.equal(panels[0].webview.html, html);
  assert.equal(panels[0].options.enableScripts, true);
  assert.equal(panels[0].options.enableForms, false);
  assert.equal(panels[0].options.enableCommandUris, false);
  assert.deepEqual(panels[0].options.localResourceRoots, []);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
});

test('generating diagnostics again refreshes and reveals the existing tab', () => {
  const { panels, view } = editor();
  view.open('<html>First snapshot</html>');
  view.open('<html>Updated snapshot</html>');
  assert.equal(panels.length, 1);
  assert.equal(panels[0].webview.html, '<html>Updated snapshot</html>');
  assert.equal(panels[0].reveals, 2);
});

test('closing the report allows a later command to create a new tab', () => {
  const { panels, view } = editor();
  view.open('<html>First</html>');
  panels[0].dispose();
  view.open('<html>Second</html>');
  assert.equal(panels.length, 2);
  assert.equal(panels[1].webview.html, '<html>Second</html>');
});

test('extension disposal closes the report and is safe without an open tab', () => {
  const { panels, view } = editor();
  view.dispose();
  view.open('<html>Report</html>');
  view.dispose();
  assert.equal(panels[0].disposed, true);
  view.dispose();
});
