'use strict';

/** Format a byte count in binary units with at most two decimal places. */
function formatMemory(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${Number(value.toFixed(unit === 0 ? 0 : 2))} ${units[unit]}`;
}
const stateLabels = { normal: 'Monitoring', warning: 'Memory warning', confirmed: 'High memory', deferred: 'Editor restart deferred',
  countdown: 'Editor restart scheduled', restarting: 'Restarting editor session', cooldown: 'Editor session stabilizing', disabled: 'Monitoring disabled',
  suspended: 'Monitoring suspended', error: 'Measurement unavailable', ambiguous: 'Editor session ambiguous',
  unsupported: 'Environment unsupported', waiting: 'Waiting for pwsh in this window' };

function describeStatus(snapshot) {
  const processes = snapshot.processes || (snapshot.sample ? [snapshot.sample] : []);
  const count = processes.length;
  const complete = snapshot.inventory ? snapshot.inventory.complete === true : count > 0;
  const knownTotal = processes.reduce((total, sample) => total + sample.privateBytes, 0);
  const label = stateLabels[snapshot.state] || snapshot.state;
  const mode = snapshot.mode === 'automatic' ? 'Editor restart: automatic; other pwsh: alerts only.' : 'All pwsh: alerts only.';
  let text;
  if (snapshot.state === 'disabled' || snapshot.state === 'suspended' && !count) text = `$(pulse) pwsh · ${label}`;
  else if (!count) text = `$(pulse) pwsh · ${snapshot.state === 'waiting' ? complete ? 'No pwsh in this window' : 'Discovering pwsh' : label}`;
  else text = `$(pulse) pwsh ${count} · ${complete ? '' : '≥ '}${formatMemory(knownTotal)} total · ${label}`;
  const sorted = [...processes].sort((left, right) => right.privateBytes - left.privateBytes);
  // An absolute timestamp stays stable between observations; a ticking age replaces the native hover every second.
  const collectedAt = snapshot.inventory?.measuredAt || snapshot.lastInventory?.measuredAt || snapshot.sample?.measuredAt;
  const tooltip = [snapshot.detail, 'Scope: this VS Code window, its terminals and their pwsh children.',
    ...(count || complete ? [`Private committed memory: ${complete ? '' : 'at least '}${formatMemory(knownTotal)} across ${count} measured process(es).`] : ['Current process memory measurement is unavailable.']),
    'Thresholds apply to each process separately; resident memory is not added to private memory.', mode,
    ...sorted.slice(0, 10).map((sample) => `PID ${sample.pid} (${sample.kind || 'editorServices'}): private ${formatMemory(sample.privateBytes)}, resident ${formatMemory(sample.workingSetBytes)}; created ${sample.createdAt}`),
    ...(count > 10 ? [`${count - 10} more process(es) in diagnostics.`] : []),
    ...(!complete ? ['Some processes could not be measured; the total is incomplete.'] : []),
    ...(snapshot.inventory?.editorIssue ? ['Editor Services restart association is unavailable; other pwsh monitoring continues.'] : []),
    `Last successful process collection: ${collectedAt || 'none'}.`,
    'An Editor Services restart discards session state and may interrupt a running command.',
    snapshot.journalError || '', 'Click for processes, diagnostics and actions.'].filter(Boolean).join('\n');
  return { text, tooltip };
}

module.exports = { describeStatus, formatMemory, stateLabels };
