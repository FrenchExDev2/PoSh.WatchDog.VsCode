'use strict';

const GiB = 1024 ** 3;
const defaults = Object.freeze({
  enabled: true, mode: 'automatic', sampleIntervalSeconds: 15,
  warningPrivateGiB: 4, restartPrivateGiB: 8, consecutiveSamples: 3,
  collectTimeoutSeconds: 3, restartTimeoutSeconds: 45, cooldownSeconds: 120,
  maxAutomaticRestartsPerHour: 3, deferWhileDebugging: true,
  profile: 'development', processThresholds: Object.freeze({}), restartGraceSeconds: 30,
  deferWhileRunningCommands: true, requireKnownIdle: false,
  growthWarningMiB: 500, growthWindowSeconds: 300,
  historyRetentionDays: 14, historyMaxMiB: 15, reportRetentionDays: 14, reportMaxMiB: 20,
});

/** Resolve user-machine thresholds for one process kind and the selected workload profile. */
function processPolicy(policy, kind = 'editorServices') {
  const factor = { development: 1, tests: 1.5, build: 2 }[policy.profile] || 1;
  const overrides = policy.processThresholds?.[kind] || {};
  return { ...policy, warningPrivateGiB: overrides.warningPrivateGiB ?? policy.warningPrivateGiB * factor,
    restartPrivateGiB: overrides.restartPrivateGiB ?? policy.restartPrivateGiB * factor };
}

function validatePolicy(policy) {
  const errors = [];
  for (const name of ['sampleIntervalSeconds', 'warningPrivateGiB', 'restartPrivateGiB',
    'collectTimeoutSeconds', 'restartTimeoutSeconds', 'cooldownSeconds',
    'consecutiveSamples', 'maxAutomaticRestartsPerHour']) {
    if (!Number.isFinite(policy[name]) || policy[name] <= 0) errors.push(`${name} must be positive.`);
  }
  for (const name of ['consecutiveSamples', 'maxAutomaticRestartsPerHour']) {
    if (!Number.isSafeInteger(policy[name])) errors.push(`${name} must be an integer.`);
  }
  // Node timers clamp values above the signed 32-bit limit to 1 ms.
  for (const name of ['sampleIntervalSeconds', 'collectTimeoutSeconds', 'restartTimeoutSeconds', 'cooldownSeconds']) {
    if (policy[name] * 1000 > 2 ** 31 - 1) errors.push(`${name} exceeds the timer limit.`);
  }
  if (!(policy.warningPrivateGiB < policy.restartPrivateGiB)) errors.push('Warning must be below restart threshold.');
  if (!['automatic', 'notifyOnly'].includes(policy.mode)) errors.push('Unknown mode.');
  for (const name of ['enabled', 'deferWhileDebugging']) {
    if (typeof policy[name] !== 'boolean') errors.push(`${name} must be boolean.`);
  }
  for (const name of ['deferWhileRunningCommands', 'requireKnownIdle']) {
    if (typeof policy[name] !== 'boolean') errors.push(`${name} must be boolean.`);
  }
  if (!['development', 'tests', 'build'].includes(policy.profile)) errors.push('Unknown workload profile.');
  if (!Number.isFinite(policy.restartGraceSeconds) || policy.restartGraceSeconds < 0 || policy.restartGraceSeconds > 3600) errors.push('restartGraceSeconds must be between 0 and 3600.');
  for (const [name, minimum, maximum] of [['growthWarningMiB', 1, 1048576], ['growthWindowSeconds', 1, 86400],
    ['historyRetentionDays', 1, 365], ['historyMaxMiB', 1, 100], ['reportRetentionDays', 1, 365], ['reportMaxMiB', 1, 500]]) {
    if (!Number.isFinite(policy[name]) || policy[name] < minimum || policy[name] > maximum) errors.push(`${name} must be between ${minimum} and ${maximum}.`);
  }
  if (!policy.processThresholds || typeof policy.processThresholds !== 'object' || Array.isArray(policy.processThresholds)) errors.push('processThresholds must be an object.');
  else for (const [kind, values] of Object.entries(policy.processThresholds)) {
    if (!['editorServices', 'terminal', 'child'].includes(kind) || !values || typeof values !== 'object' || Array.isArray(values) ||
      Object.keys(values).some((key) => !['warningPrivateGiB', 'restartPrivateGiB'].includes(key)) ||
      Object.values(values).some((value) => !Number.isFinite(value) || value <= 0)) { errors.push('Invalid per-process thresholds.'); continue; }
    const effective = processPolicy(policy, kind);
    if (!(effective.warningPrivateGiB < effective.restartPrivateGiB)) errors.push(`${kind}: warning must be below restart threshold.`);
  }
  return errors;
}

const identityKey = (sample) => `${sample.pid}:${sample.createdAt}`;

class PolicyEngine {
  constructor(policy = defaults, persisted = {}) {
    this.policy = { ...policy };
    this.target = null;
    this.count = 0;
    this.lastAt = null;
    this.lastCountedAt = null;
    this.warning = false;
    this.restarts = Array.isArray(persisted.restarts) ? persisted.restarts.filter(Number.isFinite) : [];
    this.cooldownUntil = Number.isFinite(persisted.cooldownUntil) ? persisted.cooldownUntil : 0;
    this.suspendedReason = typeof persisted.suspendedReason === 'string' ? persisted.suspendedReason : null;
    this.awaitingImprovement = !!persisted.awaitingImprovement;
    this.suspendUntil = Number.isFinite(persisted.suspendUntil) ? persisted.suspendUntil : 0;
    this.lastDebugging = false;
  }

  resetSeries() { this.count = 0; this.lastAt = null; this.lastCountedAt = null; }

  configure(policy) {
    this.policy = { ...policy };
    this.resetSeries();
    this.warning = false;
  }

  persist() {
    return { restarts: this.restarts, cooldownUntil: this.cooldownUntil,
      suspendedReason: this.suspendedReason, awaitingImprovement: this.awaitingImprovement,
      suspendUntil: this.suspendUntil };
  }

  suspend(until) { this.suspendUntil = until; this.resetSeries(); }
  /** Acknowledge suspension without bypassing cooldown, quota or fresh-sample requirements. */
  resume() {
    this.suspendUntil = 0;
    this.suspendedReason = null;
    this.awaitingImprovement = false;
    this.resetSeries();
  }

  restartRequested(now, automatic) {
    if (automatic) this.restarts.push(now);
    this.resetSeries();
  }

  restartFinished(now, outcome) {
    this.resetSeries();
    if (outcome === 'succeeded') {
      this.cooldownUntil = now + this.policy.cooldownSeconds * 1000;
      this.awaitingImprovement = true;
    } else {
      this.suspendedReason = `Restart ${outcome}; resume explicitly after checking the session.`;
    }
  }

  evaluate(sample, now, { debugging = false, activity = 'unknown' } = {}) {
    const policy = processPolicy(this.policy, sample?.kind || 'editorServices');
    this.restarts = this.restarts.filter((at) => at > now - 3600_000);
    const result = (state, detail, extra = {}) => ({ state, detail, restart: false, notifyWarning: false, ...extra });
    const invalid = validatePolicy(this.policy);
    if (invalid.length) { this.resetSeries(); return result('error', invalid.join(' ')); }
    if (!policy.enabled) { this.resetSeries(); return result('disabled', 'Monitoring disabled.'); }
    if (this.suspendUntil > now) { this.resetSeries(); return result('suspended', 'Monitoring temporarily suspended.'); }
    if (!sample) { this.resetSeries(); return result('error', 'Memory unknown.'); }
    if (this.target !== identityKey(sample)) {
      this.target = identityKey(sample);
      this.warning = false;
      this.resetSeries();
    }
    // The interval starts after collection completes; allow its full deadline as well as scheduling tolerance.
    const maximumGap = (policy.sampleIntervalSeconds * 2.5 + policy.collectTimeoutSeconds) * 1000;
    if (this.lastAt !== null && (now - this.lastAt > maximumGap || now <= this.lastAt)) this.resetSeries();
    if (this.lastDebugging !== debugging) this.resetSeries();
    this.lastDebugging = debugging;
    this.lastAt = now;
    const high = sample.privateBytes >= policy.restartPrivateGiB * GiB;
    const warning = sample.privateBytes >= policy.warningPrivateGiB * GiB;
    const notifyWarning = warning && !this.warning;
    this.warning = warning;
    if (now < this.cooldownUntil) {
      this.resetSeries();
      return result('cooldown', 'Waiting for session stabilization.', { notifyWarning });
    }
    if (!high && this.awaitingImprovement) this.awaitingImprovement = false;
    if (!high) { this.count = 0; this.lastCountedAt = null; }
    else if (this.lastCountedAt === null || now - this.lastCountedAt >= policy.sampleIntervalSeconds * 1000) {
      this.count = Math.min(this.count + 1, policy.consecutiveSamples);
      this.lastCountedAt = now;
    }
    const base = result(high && this.count >= policy.consecutiveSamples ? 'confirmed' : warning ? 'warning' : 'normal',
      high ? `Restart threshold: ${this.count}/${policy.consecutiveSamples} samples.` : warning ? 'Private memory warning.' : 'Monitoring.', { notifyWarning });
    if (this.suspendedReason) return { ...base, state: 'suspended', detail: this.suspendedReason };
    if (policy.mode !== 'automatic' || !high) return base;
    if (policy.deferWhileDebugging && debugging) {
      this.resetSeries();
      return { ...base, state: 'deferred', detail: 'PowerShell debugging is active.' };
    }
    if ((policy.deferWhileRunningCommands && activity === 'busy') || (policy.requireKnownIdle && activity !== 'idle')) {
      this.resetSeries();
      return { ...base, state: 'deferred', detail: activity === 'busy' ? 'A terminal command is active.' : 'Terminal activity is unknown; verified idle is required.' };
    }
    if (this.count < policy.consecutiveSamples) return base;
    if (this.awaitingImprovement) {
      this.suspendedReason = 'No sustained improvement after restart; automatic restarts suspended.';
      return { ...base, state: 'suspended', detail: this.suspendedReason };
    }
    if (this.restarts.length >= policy.maxAutomaticRestartsPerHour) {
      this.suspendedReason = 'Rolling-hour automatic restart quota reached.';
      return { ...base, state: 'suspended', detail: this.suspendedReason };
    }
    return { ...base, restart: true };
  }
}

module.exports = { GiB, defaults, validatePolicy, identityKey, PolicyEngine, processPolicy };
