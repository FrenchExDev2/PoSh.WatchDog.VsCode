'use strict';

/** Observe shell lifecycle signals without reading command lines, output or working directories. */
class ActivityTracker {
  constructor(window, onChange = () => {}) {
    this.entries = new Map();
    this.subscriptions = [];
    const listen = (name, callback) => {
      if (typeof window[name] === 'function') this.subscriptions.push(window[name](callback));
    };
    listen('onDidStartTerminalShellExecution', ({ terminal, execution }) => {
      const entry = this.entries.get(terminal) || { executions: new Set(), observedEnd: false };
      entry.executions.add(execution); this.entries.set(terminal, entry);
      onChange(terminal);
    });
    listen('onDidEndTerminalShellExecution', ({ terminal, execution }) => {
      const entry = this.entries.get(terminal) || { executions: new Set(), observedEnd: false };
      entry.executions.delete(execution); entry.observedEnd = true; this.entries.set(terminal, entry);
      onChange(terminal);
    });
    listen('onDidCloseTerminal', (terminal) => { this.entries.delete(terminal); onChange(terminal); });
  }

  get(terminal) {
    const entry = this.entries.get(terminal);
    if (entry?.executions.size) return { state: 'busy', source: 'shellIntegration' };
    if (terminal?.shellIntegration && entry?.observedEnd) return { state: 'idle', source: 'shellIntegration' };
    return { state: 'unknown', source: 'unavailable' };
  }

  dispose() { for (const subscription of this.subscriptions) subscription.dispose(); this.entries.clear(); }
}

module.exports = { ActivityTracker };
