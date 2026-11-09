'use strict';

function createReportPanel(vscode) {
  let panel;
  return {
    open(html) {
      if (!panel) {
        panel = vscode.window.createWebviewPanel('powershellWatchdog.visualDiagnostics',
          'Memory Watchdog · Visual diagnostics', vscode.ViewColumn.Active, {
            enableScripts: true, enableForms: false, enableCommandUris: false, localResourceRoots: [],
          });
        panel.onDidDispose(() => { panel = undefined; });
      }
      panel.webview.html = html;
      panel.reveal();
      return true;
    },
    dispose() { panel?.dispose(); },
  };
}

module.exports = { createReportPanel };
