'use strict';

const { PolicyEngine, defaults, validatePolicy, identityKey, processPolicy } = require('./policy');
const { withDeadline } = require('./collector');
const { TrendTracker } = require('./trends');

const GiB = 1024 ** 3;
const PRIMARY = 'pwsh-editor-services';
const PRIMARY_COMMAND = 'PowerShell.RestartSession';
const SEVERITY = Object.freeze({ restarting: 6, countdown: 5, confirmed: 4, suspended: 3, warning: 2 });

/** Restart state of one target. The primary slot is the verified PowerShell Editor Services session. */
class TargetSlot {
  constructor({ name, label, command, debugTypes = null, primary = false }, policy, persisted = {}) {
    this.name = name; this.label = label; this.command = command; this.debugTypes = debugTypes; this.primary = primary;
    this.engine = new PolicyEngine(policy, persisted);
    this.sample = null; this.lastValid = null; this.target = null; this.restartIntent = null;
    this.cancelledIdentity = typeof persisted.cancelledIdentity === 'string' ? persisted.cancelledIdentity : null;
    this.postponeUntil = Number.isFinite(persisted.postponeUntil) ? persisted.postponeUntil : 0;
    this.pendingCommand = false; this.restartOutcome = null; this.state = 'waiting'; this.detail = 'Waiting for a unique process.';
    this.signature = null;
  }

  persist() { return { ...this.engine.persist(), cancelledIdentity: this.cancelledIdentity, postponeUntil: this.postponeUntil }; }

  reset() { this.sample = null; this.target = null; this.restartIntent = null; this.engine.resetSeries(); }

  summary(now) {
    return { name: this.name, label: this.label, command: this.command, primary: this.primary, state: this.state, detail: this.detail,
      mode: this.engine.policy.mode, sample: this.sample, lastValid: this.lastValid, consecutiveSamples: this.engine.count,
      thresholds: this.engine.policy.warningPrivateGiB === undefined ? null : { warningPrivateGiB: processPolicy(this.engine.policy, this.sample?.kind).warningPrivateGiB,
        restartPrivateGiB: processPolicy(this.engine.policy, this.sample?.kind).restartPrivateGiB },
      restartOutcome: this.restartOutcome, automaticRestarts: this.engine.restarts.length, cooldownUntil: this.engine.cooldownUntil,
      suspendedReason: this.engine.suspendedReason, postponeUntil: this.postponeUntil, pendingCommand: this.pendingCommand,
      restartCountdown: this.restartIntent ? { identity: this.restartIntent.identity, deadline: this.restartIntent.deadline,
        remainingSeconds: Math.max(0, Math.ceil((this.restartIntent.deadline - now) / 1000)) } : null };
  }
}

const slotAccessor = (name) => ({ get() { return this.primary[name]; }, set(value) { this.primary[name] = value; }, configurable: true });

class WatchdogController {
  constructor(dependencies, policy = defaults, persisted = {}) {
    this.dependencies = dependencies;
    this.now = dependencies.now || Date.now;
    this.primary = new TargetSlot({ name: PRIMARY, label: 'Editor Services', command: PRIMARY_COMMAND, primary: true }, policy, persisted);
    this.slots = new Map([[PRIMARY, this.primary]]);
    this.persistedTargets = persisted.targets && typeof persisted.targets === 'object' ? persisted.targets : {};
    this.targetPolicies = new Map();
    this.configStatus = null;
    this.state = 'waiting';
    this.detail = 'Waiting for a session.';
    this.rawState = this.state; this.rawDetail = this.detail;
    this.inventory = null;
    this.lastInventory = null;
    this.processEngines = new Map();
    this.processState = 'normal';
    this.busy = false;
    this.disposed = false;
    this.revision = 0;
    this.timer = null;
    this.abort = new AbortController();
    this.trends = new TrendTracker();
    this.health = { lastStartedAt: null, lastCompletedAt: null, lastSuccessAt: null, durationMs: null,
      nextCollectionAt: null, consecutiveErrors: 0, lastError: null, collecting: false };
  }

  /** Secondary slots: generic targets that own a restart command. */
  secondary() { return [...this.slots.values()].filter((slot) => !slot.primary); }

  slot(name) { return name === undefined ? this.primary : this.slots.get(name) || null; }

  policyFor(sample) { return (sample?.targetId && this.targetPolicies.get(sample.targetId)) || this.engine.policy; }

  snapshot() {
    const now = this.now();
    return {
      state: this.state, detail: this.detail, mode: this.engine.policy.mode,
      sample: this.sample, lastValid: this.lastValid,
      processes: this.inventory?.processes || [], inventory: this.inventory,
      lastInventory: this.lastInventory,
      sampleAgeSeconds: this.lastValid ? Math.max(0, (now - Date.parse(this.lastValid.measuredAt)) / 1000) : null,
      processSampleAgeSeconds: this.lastInventory?.measuredAt ? Math.max(0, (now - Date.parse(this.lastInventory.measuredAt)) / 1000) : null,
      consecutiveSamples: this.engine.count, policy: { ...this.engine.policy },
      restartOutcome: this.restartOutcome, automaticRestarts: this.engine.restarts.length,
      cooldownUntil: this.engine.cooldownUntil, suspendUntil: this.engine.suspendUntil,
      pendingCommand: [...this.slots.values()].some((slot) => slot.pendingCommand), journalError: this.dependencies.journal.error,
      history: this.dependencies.journal.history.filter((entry) => Date.parse(entry.at) >= now - this.engine.policy.historyRetentionDays * 86400_000),
      profile: this.engine.policy.workload || this.engine.policy.profile, postponeUntil: this.postponeUntil,
      restartCountdown: this.restartIntent ? { identity: this.restartIntent.identity, deadline: this.restartIntent.deadline,
        remainingSeconds: Math.max(0, Math.ceil((this.restartIntent.deadline - now) / 1000)) } : null,
      health: this.healthSnapshot(),
      targets: [...this.slots.values()].map((slot) => slot.summary(now)),
      targetPolicies: Object.fromEntries([...this.targetPolicies].map(([name, policy]) => [name, {
        warningPrivateGiB: processPolicy(policy).warningPrivateGiB, restartPrivateGiB: processPolicy(policy).restartPrivateGiB, mode: policy.mode }])),
      configs: this.configStatus,
    };
  }

  /** Explain collection health and every currently known automatic restart blocker of the primary target. */
  healthSnapshot() {
    const now = this.now();
    const policy = this.engine.policy;
    const activity = this.activity(this.target);
    const reasons = [];
    if (validatePolicy(policy).length) reasons.push('invalidPolicy');
    if (!policy.enabled) reasons.push('disabled');
    if (policy.mode !== 'automatic') reasons.push('notifyOnly');
    if (!this.sample) reasons.push('noVerifiedEditorSession');
    if (this.engine.suspendUntil > now) reasons.push('monitoringSuspended');
    if (this.engine.suspendedReason) reasons.push(this.engine.suspendedReason);
    if (this.engine.cooldownUntil > now) reasons.push('cooldown');
    if (this.postponeUntil > now) reasons.push('restartPostponed');
    if (this.sample && this.cancelledIdentity === identityKey(this.sample)) reasons.push('restartCancelledForThisEpisode');
    if (policy.deferWhileDebugging && this.debugging(this.primary)) reasons.push('powerShellDebugging');
    if (policy.deferWhileRunningCommands && activity.state === 'busy') reasons.push('commandRunning');
    if (policy.requireKnownIdle && activity.state !== 'idle') reasons.push('verifiedIdleRequired');
    if (this.pendingCommand) reasons.push('restartCommandPending');
    const stale = this.health.lastSuccessAt === null || now - this.health.lastSuccessAt >
      (policy.sampleIntervalSeconds + policy.collectTimeoutSeconds) * 2500;
    if (stale) reasons.push('measurementStaleOrMissing');
    return { ...this.health, stale, activity, automaticRestartBlockedBy: reasons,
      inventoryComplete: this.inventory?.complete ?? false, editorAssociation: this.inventory?.editorIssue || (this.sample ? 'verified' : 'unavailable'),
      historyError: this.dependencies.journal.error || null };
  }

  /** Debug sessions only defer the targets whose config names their debug types. */
  debugging(slot = this.primary) {
    if (!this.dependencies.debugging) return false;
    return slot.debugTypes ? slot.debugTypes.length > 0 && !!this.dependencies.debugging(slot.debugTypes) : !!this.dependencies.debugging();
  }

  activity(target) { return this.dependencies.activity?.(target) || { state: 'unknown', source: 'unavailable' }; }

  activityBlocks(target, slot = this.primary) {
    const state = this.activity(target).state;
    return (slot.engine.policy.deferWhileRunningCommands && state === 'busy') || (slot.engine.policy.requireKnownIdle && state !== 'idle');
  }

  /** Cancel stale countdowns and evidence when a known terminal activity signal changes. */
  activityChanged(terminal) {
    if (terminal && terminal !== this.target?.terminal) return;
    this.revision++;
    for (const slot of this.slots.values()) { slot.restartIntent = null; slot.engine.resetSeries(); }
    this.publish('deferred', 'Activity changed; fresh measurements are required before automatic restart.');
    void this.record(this.detail).catch(() => {});
  }

  countdownSlot(name) {
    if (name !== undefined) return this.slot(name);
    return this.primary.restartIntent ? this.primary : this.secondary().find((slot) => slot.restartIntent) || this.primary;
  }

  async cancelRestart(name) {
    const slot = this.countdownSlot(name);
    if (!slot?.restartIntent) return false;
    slot.cancelledIdentity = slot.restartIntent.identity; slot.restartIntent = null; this.revision++;
    slot.engine.resetSeries();
    this.publish('deferred', 'Automatic restart cancelled for this high-memory episode.', slot);
    await this.persist(); await this.record(slot.detail); return true;
  }

  async postponeRestart(minutes = 5, name) {
    if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 10080) throw new Error('Invalid postponement.');
    const slot = this.countdownSlot(name);
    if (!slot) return;
    slot.postponeUntil = this.now() + minutes * 60_000;
    slot.restartIntent = null; this.revision++; slot.engine.resetSeries();
    this.publish('deferred', `Automatic restart postponed for ${minutes} minutes; monitoring continues.`, slot);
    await this.persist(); await this.record(slot.detail);
  }

  async restartNow(name) {
    const slot = this.countdownSlot(name);
    if (!slot?.restartIntent) return false;
    slot.restartIntent.deadline = this.now();
    await this.tick(); return true;
  }

  async automaticRestart(measured, slot = this.primary) {
    const identity = identityKey(measured.sample);
    const policy = slot.engine.policy;
    if (identity === slot.cancelledIdentity || slot.postponeUntil > this.now()) {
      this.publish('deferred', identity === slot.cancelledIdentity ? 'Automatic restart cancelled for this episode.' : 'Automatic restart postponed; monitoring continues.', slot); return;
    }
    if (!policy.restartGraceSeconds) return this.restart(measured, true, slot);
    if (!slot.restartIntent || slot.restartIntent.identity !== identity || slot.restartIntent.revision !== this.revision) {
      slot.restartIntent = { identity, revision: this.revision, deadline: this.now() + policy.restartGraceSeconds * 1000 };
      this.dependencies.notice?.('countdown', slot.primary ? `Editor Services restart in ${policy.restartGraceSeconds} seconds. Session state will be lost.` :
        `${slot.label} restart in ${policy.restartGraceSeconds} seconds through ${slot.command}.`, slot.name);
    }
    if (slot.restartIntent.deadline <= this.now()) {
      const intent = slot.restartIntent;
      try { return await this.restart(measured, true, slot); }
      finally { if (slot.restartIntent === intent) slot.restartIntent = null; }
    }
    this.publish('countdown', `${slot.label} restart in ${Math.ceil((slot.restartIntent.deadline - this.now()) / 1000)} seconds; cancel or postpone from Watchdog.`, slot);
    await this.record(slot.detail);
  }

  /** Primary transitions set the window state; secondary transitions update their slot and escalate when more severe. */
  publish(state, detail, slot = this.primary) {
    if (this.disposed) return;
    if (slot !== this.primary) { slot.state = state; slot.detail = detail; state = this.rawState; detail = this.rawDetail; }
    else { this.rawState = state; this.rawDetail = detail; }
    if (this.inventory?.processes.length && ['normal', 'waiting'].includes(state)) {
      state = this.processState;
      detail = `${this.inventory.processes.length} process(es) measured in this window. ${detail}`;
    }
    if (['cooldown', 'deferred'].includes(state) && ['warning', 'confirmed'].includes(this.processState)) {
      state = this.processState;
      detail = `Another process exceeds its memory threshold. ${detail}`;
    }
    for (const other of this.secondary()) {
      if ((SEVERITY[other.state] || 0) > (SEVERITY[state] || 0)) { state = other.state; detail = `${other.label}: ${other.detail}`; }
    }
    this.state = state;
    this.detail = detail;
    this.dependencies.onChange?.(this.snapshot());
  }

  async persist() {
    const targets = {};
    for (const slot of this.secondary()) targets[slot.name] = slot.persist();
    await this.dependencies.store?.({ ...this.primary.persist(), ...(Object.keys(targets).length ? { targets } : {}) });
  }

  async record(decision) {
    // Only allowlisted product data enters history or disk logs.
    const secondary = this.secondary();
    await this.dependencies.journal.append({
      at: new Date(this.now()).toISOString(), state: this.state, decision,
      sample: this.sample, warningPrivateGiB: processPolicy(this.engine.policy).warningPrivateGiB,
      restartPrivateGiB: processPolicy(this.engine.policy).restartPrivateGiB,
      profile: this.engine.policy.workload || this.engine.policy.profile,
      mode: this.engine.policy.mode, consecutiveSamples: this.engine.count,
      sampleIntervalSeconds: this.engine.policy.sampleIntervalSeconds,
      ...(this.inventory ? { processCount: this.inventory.processes.length, complete: this.inventory.complete,
        processes: [...this.inventory.processes].sort((left, right) => right.privateBytes - left.privateBytes).slice(0, 20),
        omittedProcesses: Math.max(0, this.inventory.processes.length - 20),
        collectionErrors: this.inventory.errors.length } : {}),
      ...(secondary.length ? { targets: secondary.map((slot) => ({ targetId: slot.name, state: slot.state, pid: slot.sample?.pid ?? null,
        privateBytes: slot.sample?.privateBytes ?? null })) } : {}),
    });
  }

  clearMeasurements() {
    this.inventory = null;
    this.processEngines.clear();
    for (const slot of this.slots.values()) slot.reset();
  }

  configure(policy) {
    this.trends.clear();
    this.revision++;
    this.primary.restartIntent = null;
    this.engine.configure(policy);
    this.sample = null;
    this.inventory = null;
    this.processEngines.clear();
    const errors = validatePolicy(policy);
    this.publish(errors.length ? 'error' : policy.enabled ? 'waiting' : 'disabled',
      errors.length ? errors.join(' ') : policy.enabled ? 'Policy changed; fresh measurement required.' : 'Monitoring disabled.');
    // Configuration events are synchronous; surface storage failures without an unhandled rejection.
    void this.record(this.detail).catch(() => {
      this.dependencies.journal.error = 'Policy change could not be recorded.';
    });
  }

  /**
   * Apply the active profile. `primaryPolicy` drives globals and the Editor Services slot; `targets` lists every
   * monitored config `{ name, label, policy, command, debugTypes, adapter }`. Only changed targets lose their state.
   */
  configureTargets(primaryPolicy, targets, configStatus = null) {
    this.configStatus = configStatus;
    this.targetPolicies = new Map(targets.map((target) => [target.name, target.policy]));
    const primarySpec = targets.find((target) => target.adapter === 'powershellEditorServices');
    const primarySignature = JSON.stringify([primaryPolicy, primarySpec?.debugTypes ?? null, primarySpec?.label ?? null]);
    const globalsChanged = primarySignature !== this.primary.signature;
    this.primary.debugTypes = primarySpec ? primarySpec.debugTypes : this.primary.debugTypes;
    const wanted = new Map(targets.filter((target) => !target.adapter && target.command).map((target) => [target.name, target]));
    for (const name of [...this.slots.keys()]) if (name !== PRIMARY && !wanted.has(name)) this.slots.delete(name);
    for (const [name, target] of wanted) {
      const signature = JSON.stringify([target.policy, target.command, target.debugTypes, target.label]);
      let slot = this.slots.get(name);
      if (!slot) {
        slot = new TargetSlot({ name, label: target.label, command: target.command, debugTypes: target.debugTypes }, target.policy, this.persistedTargets[name]);
        this.slots.set(name, slot);
      } else if (slot.signature !== signature) {
        slot.label = target.label; slot.command = target.command; slot.debugTypes = target.debugTypes;
        slot.engine.configure(target.policy); slot.reset();
      }
      slot.signature = signature;
    }
    if (globalsChanged) { this.primary.signature = primarySignature; this.configure(primaryPolicy); }
    else {
      // Only per-process alert engines of changed configs restart their evidence.
      for (const [key, engine] of this.processEngines) {
        const targetId = key.split('|')[0];
        if (JSON.stringify(engine.policy) !== JSON.stringify({ ...this.targetPolicies.get(targetId), mode: 'notifyOnly' })) this.processEngines.delete(key);
      }
      this.publish(this.rawState, this.rawDetail);
    }
  }

  async suspend(minutes) {
    this.trends.clear();
    this.revision++;
    this.engine.suspend(this.now() + minutes * 60_000);
    for (const slot of this.secondary()) slot.engine.suspend(this.now() + minutes * 60_000);
    this.clearMeasurements();
    this.publish('suspended', `Monitoring suspended for ${minutes} minutes.`);
    await this.record(this.detail);
    await this.persist();
  }

  async resume() {
    this.trends.clear();
    this.revision++;
    for (const slot of this.slots.values()) { slot.cancelledIdentity = null; slot.postponeUntil = 0; slot.engine.resume(); }
    this.clearMeasurements();
    for (const slot of this.secondary()) { slot.state = 'waiting'; slot.detail = 'Resumed.'; }
    this.publish('waiting', 'Resumed; fresh measurements required.');
    await this.record(this.detail);
    await this.persist();
  }

  async measure() {
    this.health.lastStartedAt = this.now(); this.health.collecting = true;
    this.dependencies.onChange?.(this.snapshot());
    try {
      const result = await this.collectMeasurement();
      this.health.lastSuccessAt = this.now(); this.health.consecutiveErrors = 0; this.health.lastError = null;
      return result;
    } catch (error) {
      this.health.consecutiveErrors++; this.health.lastError = ['timeout', 'cancelled', 'unsupported', 'ambiguous'].includes(error.code) ? error.code : 'collection';
      throw error;
    } finally {
      this.health.lastCompletedAt = this.now(); this.health.durationMs = Math.max(0, this.now() - this.health.lastStartedAt);
      this.health.collecting = false;
    }
  }

  async collectMeasurement() {
    const milliseconds = this.engine.policy.collectTimeoutSeconds * 1000;
    if (this.dependencies.observe) return withDeadline(() => this.dependencies.observe(milliseconds, this.abort.signal), milliseconds, this.abort.signal);
    // Legacy dependency adapter retained for isolated policy tests only; activation always injects observe.
    const started = this.now();
    const target = await withDeadline(() => this.dependencies.resolve(), milliseconds, this.abort.signal);
    if (!target?.pid) return { target, sample: null };
    const remaining = milliseconds - (this.now() - started);
    if (remaining <= 0) throw new Error('Collection deadline exceeded.');
    const sample = await this.dependencies.collect(target, remaining, this.abort.signal);
    return { target, sample };
  }

  /** The target and sample of one slot in a measurement; the primary keeps the original top-level fields. */
  pick(measured, slot) {
    if (slot.primary) return { target: measured?.target ?? null, sample: measured?.sample ?? null, inventory: measured?.inventory };
    const picked = measured?.targets?.[slot.name];
    return { target: picked?.target ?? null, sample: picked?.sample ?? null, inventory: measured?.inventory };
  }

  updateInventory(inventory) {
    if (!inventory) return;
    const live = new Set();
    const warnings = [];
    this.processState = 'normal';
    this.trends.update(inventory.processes, (sample) => this.policyFor(sample), this.now());
    for (const sample of inventory.processes) {
      const targetPolicy = this.policyFor(sample);
      const effective = processPolicy(targetPolicy, sample.kind);
      sample.thresholds = { warningPrivateGiB: effective.warningPrivateGiB, restartPrivateGiB: effective.restartPrivateGiB };
      if (sample.growth?.notify) this.dependencies.notice?.('warning', `${sample.targetLabel || 'Process'} PID ${sample.pid} grew by ${sample.growth.deltaMiB.toFixed(0)} MiB in ${sample.growth.observedSeconds.toFixed(0)} seconds. This is a growth alert, not proof of a leak.`);
      if (sample.automaticRestart) continue;
      const key = `${sample.targetId || ''}|${identityKey(sample)}`;
      live.add(key);
      let policy = this.processEngines.get(key);
      if (!policy) {
        policy = new PolicyEngine({ ...targetPolicy, mode: 'notifyOnly' });
        this.processEngines.set(key, policy);
      }
      const decision = policy.evaluate(sample, this.now());
      sample.state = decision.state;
      sample.consecutiveSamples = policy.count;
      if (decision.notifyWarning) warnings.push(sample.pid);
      if (decision.state === 'confirmed') this.processState = 'confirmed';
      else if (decision.state === 'warning' && this.processState !== 'confirmed') this.processState = 'warning';
    }
    for (const key of this.processEngines.keys()) if (!live.has(key)) this.processEngines.delete(key);
    this.inventory = inventory;
    if (inventory.complete || inventory.processes.length) this.lastInventory = inventory;
    if (warnings.length) this.dependencies.notice?.('warning',
      `Private memory warning for PID ${warnings.slice(0, 8).join(', ')}${warnings.length > 8 ? ` and ${warnings.length - 8} more` : ''}. Processes without an automatic action are monitored with alerts only.`);
  }

  /** Evaluate generic restartable targets after the primary; each one restarts only through its own command. */
  async evaluateSecondary(measured, revision) {
    for (const slot of this.secondary()) {
      if (this.disposed || revision !== this.revision) return;
      const picked = this.pick(measured, slot);
      slot.target = picked.target; slot.sample = picked.sample;
      if (!picked.sample) {
        slot.restartIntent = null; slot.engine.resetSeries();
        slot.state = 'waiting'; slot.detail = picked.target?.detail || 'No unique process matches; alerts only.';
        continue;
      }
      slot.lastValid = picked.sample;
      if (picked.sample.privateBytes < processPolicy(slot.engine.policy, picked.sample.kind).restartPrivateGiB * GiB) slot.cancelledIdentity = null;
      const decision = slot.engine.evaluate(picked.sample, this.now(), { debugging: this.debugging(slot), activity: this.activity(picked.target).state });
      if (!decision.restart) slot.restartIntent = null;
      const prior = slot.state;
      slot.state = decision.state; slot.detail = decision.detail;
      if (decision.notifyWarning) this.dependencies.notice?.('warning', `${slot.label} PID ${picked.sample.pid} exceeds the private memory warning threshold.`, slot.name);
      if (decision.state === 'suspended' && prior !== 'suspended') this.dependencies.notice?.('warning', `${slot.label}: ${decision.detail}`, slot.name);
      if (decision.restart && revision === this.revision) await this.automaticRestart(picked, slot);
    }
    if (this.secondary().length) { this.publish(this.rawState, this.rawDetail); await this.persist(); }
  }

  async tick() {
    if (this.busy || this.disposed) return this.snapshot();
    this.busy = true;
    const revision = this.revision;
    try {
      const invalid = validatePolicy(this.engine.policy);
      if (invalid.length || !this.engine.policy.enabled || this.engine.suspendUntil > this.now()) {
        const decision = this.engine.evaluate(null, this.now());
        this.clearMeasurements();
        const changed = this.state !== decision.state;
        this.publish(decision.state, decision.detail);
        if (changed) await this.record(decision.detail);
        return this.snapshot();
      }
      const measured = await this.measure();
      if (this.disposed || revision !== this.revision) return this.snapshot();
      this.updateInventory(measured.inventory);
      this.target = measured.target;
      this.sample = measured.sample;
      if (!measured.sample) {
        this.restartIntent = null;
        this.engine.resetSeries();
        this.publish(measured.target?.state || 'waiting', measured.inventory?.processes.length ?
          'Processes are monitored with alerts; no Editor Services restart target is active.' :
          measured.target?.detail || 'Waiting for a session.');
        await this.evaluateSecondary(measured, revision);
        await this.record(measured.inventory ? 'Window processes measured; no verified Editor Services restart target.' : 'No associated session.');
        return this.snapshot();
      }
      this.lastValid = measured.sample;
      const effective = processPolicy(this.engine.policy, measured.sample.kind);
      if (measured.sample.privateBytes < effective.restartPrivateGiB * GiB) this.cancelledIdentity = null;
      const decision = this.engine.evaluate(measured.sample, this.now(), { debugging: this.debugging(this.primary), activity: this.activity(measured.target).state });
      if (!decision.restart) this.restartIntent = null;
      const priorState = this.state;
      this.publish(decision.state, decision.detail);
      await this.persist();
      await this.record(decision.detail);
      if (decision.notifyWarning) this.dependencies.notice?.('warning', `Editor Services pwsh PID ${measured.sample.pid} exceeds the private memory warning threshold.`);
      if (decision.state === 'suspended' && priorState !== 'suspended') this.dependencies.notice?.('warning', decision.detail);
      if (decision.restart && revision === this.revision) await this.automaticRestart(measured);
      await this.evaluateSecondary(measured, revision);
    } catch (error) {
      if (this.disposed || revision !== this.revision) return this.snapshot();
      this.trends.clear();
      this.clearMeasurements();
      const state = ['ambiguous', 'unsupported'].includes(error.code) ? error.code : 'error';
      const safeMessage = { ambiguous: 'Session association is ambiguous; no action allowed.',
        unsupported: 'Environment or PowerShell version is unsupported; no action allowed.',
        timeout: 'Collection timed out; memory unknown.' }[error.code] || 'Collection failed; memory unknown. Check process access and session identity.';
      this.publish(state, safeMessage);
      await this.record(safeMessage);
    } finally {
      this.busy = false;
    }
    return this.snapshot();
  }

  async manualRestart(name) {
    const slot = this.slot(name);
    if (!slot || this.busy || this.disposed || slot.pendingCommand) return false;
    if (validatePolicy(this.engine.policy).length) return false;
    slot.restartIntent = null; this.revision++;
    this.busy = true;
    try {
      const measured = await this.measure();
      this.updateInventory(measured.inventory);
      const picked = this.pick(measured, slot);
      if (!picked.sample) return false;
      return await this.restart(picked, false, slot);
    } catch {
      this.publish('error', 'Cannot safely identify a process to restart.', slot);
      return false;
    } finally { this.busy = false; }
  }

  async restart(previous, automatic, slot = this.primary) {
    if (slot.pendingCommand || this.disposed) return false;
    const revision = this.revision;
    const engine = slot.engine;
    const debugging = () => engine.policy.deferWhileDebugging && this.debugging(slot);
    // Re-resolve immediately before dispatch; a stale PID must never authorize a new session's restart.
    const fresh = this.pick(await this.measure(), slot);
    if (!fresh.sample || identityKey(fresh.sample) !== identityKey(previous.sample) || fresh.target?.terminal !== previous.target?.terminal) {
      engine.resetSeries();
      this.publish('waiting', slot.primary ? 'Session changed before restart; collecting fresh evidence.' : 'Process changed before restart; collecting fresh evidence.', slot);
      return false;
    }
    if (revision !== this.revision || (automatic && (!engine.policy.enabled || engine.policy.mode !== 'automatic' ||
      fresh.sample.privateBytes < processPolicy(engine.policy, fresh.sample.kind).restartPrivateGiB * GiB ||
      engine.suspendUntil > this.now() || engine.suspendedReason ||
      this.activityBlocks(fresh.target, slot) || debugging()))) {
      engine.resetSeries();
      this.publish('deferred', 'Restart deferred after the final activity check.', slot);
      return false;
    }
    const commands = await this.dependencies.commands();
    if (revision !== this.revision || this.disposed || (automatic && (this.activityBlocks(fresh.target, slot) || debugging()))) {
      engine.resetSeries();
      return false;
    }
    if (!commands.includes(slot.command)) {
      slot.restartOutcome = 'failed';
      engine.restartFinished(this.now(), 'failed');
      await this.persist();
      this.publish('suspended', `${slot.command} is unavailable.`, slot);
      await this.record('Restart command unavailable.');
      return false;
    }
    this.publish('restarting', slot.primary ? 'Requesting a replacement PowerShell session.' : `Requesting a restart through ${slot.command}.`, slot);
    const requestedAt = this.now();
    const requestIndex = engine.restarts.length;
    const previousReason = engine.suspendedReason;
    const pendingReason = 'Restart interrupted or pending; inspect the session and resume.';
    engine.restartRequested(requestedAt, automatic);
    // Persist the attempt before dispatch. A reload during restart must not bypass quota or unlock another request.
    engine.suspendedReason = pendingReason;
    await this.persist();
    // User choices and debugger activity can change while storage is pending.
    if (revision !== this.revision || this.disposed || (automatic && (!engine.policy.enabled ||
      engine.policy.mode !== 'automatic' || engine.suspendUntil > this.now() ||
      this.activityBlocks(fresh.target, slot) || debugging()))) {
      if (automatic && engine.restarts[requestIndex] === requestedAt) engine.restarts.splice(requestIndex, 1);
      if (engine.suspendedReason === pendingReason) engine.suspendedReason = previousReason;
      engine.resetSeries();
      if (!this.disposed && revision === this.revision) this.publish('deferred', 'Restart cancelled before dispatch; fresh measurements required.', slot);
      await this.persist();
      if (!this.disposed) await this.record('Restart cancelled before dispatch.');
      return false;
    }
    slot.pendingCommand = true;
    const deadline = this.now() + engine.policy.restartTimeoutSeconds * 1000;
    let outcome = 'expired';
    try {
      let request;
      // Dispatch synchronously after the final guard; a queued microtask would reopen the race.
      try { request = Promise.resolve(this.dependencies.restart(slot.command, slot.name)); }
      catch (error) { slot.pendingCommand = false; throw error; }
      request.then(() => { slot.pendingCommand = false; }, () => { slot.pendingCommand = false; });
      await withDeadline(() => request, Math.max(1, deadline - this.now()), this.abort.signal);
      while (!this.disposed && this.now() < deadline) {
        try {
          const measured = await withDeadline(() => this.measure(), Math.max(1, deadline - this.now()), this.abort.signal);
          const next = this.pick(measured, slot);
          if (next.sample && identityKey(next.sample) !== identityKey(previous.sample)) {
            this.updateInventory(measured.inventory);
            slot.sample = next.sample;
            slot.lastValid = next.sample;
            outcome = 'succeeded';
            break;
          }
        } catch { /* A restarting process is temporarily absent; retain the overall deadline. */ }
        await withDeadline(() => new Promise((resolve) => setTimeout(resolve, Math.min(500, Math.max(1, deadline - this.now())))),
          Math.max(1, deadline - this.now()), this.abort.signal);
      }
    } catch (error) {
      outcome = error.code === 'timeout' ? 'expired' : this.disposed ? 'indeterminate' : 'failed';
    }
    slot.restartOutcome = outcome;
    if (outcome === 'succeeded') engine.suspendedReason = null;
    else slot.sample = null;
    engine.restartFinished(this.now(), outcome);
    await this.persist();
    this.publish(outcome === 'succeeded' ? 'cooldown' : 'suspended',
      outcome === 'succeeded' ? (slot.primary ? 'Replacement session measured; stabilizing.' : 'Replacement process measured; stabilizing.') : `Restart ${outcome}; automatic restarts suspended.`, slot);
    await this.record(`Restart ${outcome}.`);
    if (outcome !== 'succeeded') this.dependencies.notice?.('warning', slot.primary ? `PowerShell restart ${outcome}. Check the session and resume explicitly.` :
      `${slot.label} restart ${outcome}. Check the process and resume explicitly.`, slot.name);
    return outcome === 'succeeded';
  }

  start() {
    const cycle = async () => {
      try { await this.tick(); } catch { this.publish('error', 'Watchdog storage or orchestration error.'); }
      if (!this.disposed) {
        const seconds = this.engine.policy.sampleIntervalSeconds;
        let delay = Number.isFinite(seconds) && seconds > 0 && seconds * 1000 <= 2 ** 31 - 1 ? seconds * 1000 : 15_000;
        for (const slot of this.slots.values()) if (slot.restartIntent) delay = Math.min(delay, Math.max(1, slot.restartIntent.deadline - this.now()));
        this.health.nextCollectionAt = this.now() + delay;
        this.dependencies.onChange?.(this.snapshot());
        this.timer = setTimeout(cycle, delay);
      }
    };
    void cycle();
  }

  dispose() { this.disposed = true; for (const slot of this.slots.values()) slot.restartIntent = null; clearTimeout(this.timer); this.abort.abort(); }
}

for (const name of ['engine', 'sample', 'lastValid', 'target', 'restartIntent', 'cancelledIdentity', 'postponeUntil', 'pendingCommand', 'restartOutcome']) {
  Object.defineProperty(WatchdogController.prototype, name, slotAccessor(name));
}

module.exports = { WatchdogController, TargetSlot, PRIMARY, PRIMARY_COMMAND };