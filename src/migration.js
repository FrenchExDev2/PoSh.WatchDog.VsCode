'use strict';

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { pathFor } = require('./platform');
const { validateConfig, SUFFIX } = require('./targets');

const MIGRATION_KEY = 'memoryWatchdog.migration';
const OLD_SECTION = 'frenchexdev.powershellWatchdog';
const KINDS = Object.freeze({ editorServices: 'pwsh-editor-services', terminal: 'pwsh-terminals', child: 'pwsh-children' });
const FACTORS = Object.freeze({ development: 1, tests: 1.5, build: 2 });
// Old global keys that still exist as machine-wide settings in the new section.
const GLOBAL_KEYS = Object.freeze({ enabled: 'enabled', mode: 'mode', sampleIntervalSeconds: 'sampleIntervalSeconds', collectTimeoutSeconds: 'collectTimeoutSeconds',
  historyRetentionDays: 'historyRetentionDays', historyMaxMiB: 'historyMaxMiB', reportRetentionDays: 'reportRetentionDays', reportMaxMiB: 'reportMaxMiB', profile: 'workload' });
const TARGET_KEYS = Object.freeze(['warningPrivateGiB', 'restartPrivateGiB', 'consecutiveSamples', 'processThresholds', 'growthWarningMiB', 'growthWindowSeconds',
  'restartTimeoutSeconds', 'cooldownSeconds', 'maxAutomaticRestartsPerHour', 'deferWhileDebugging', 'deferWhileRunningCommands', 'requireKnownIdle', 'restartGraceSeconds']);
const LABELS = Object.freeze({ editorServices: 'PowerShell Editor Services', terminal: 'PowerShell terminals', child: 'PowerShell child processes' });

const userValue = (old, key) => old[key] !== undefined && old[key] !== null;

/**
 * Translate explicitly set 0.5.x settings into overriding configs named like the built-ins plus new global settings.
 * `old` holds only machine (global) values the user set; absent keys keep the built-in behavior.
 */
function buildMigration(old) {
  const settings = {};
  for (const [from, to] of Object.entries(GLOBAL_KEYS)) if (userValue(old, from)) settings[to] = old[from];
  const files = [];
  const errors = [];
  if (TARGET_KEYS.some((key) => userValue(old, key))) {
    const factor = FACTORS[old.profile] || 1;
    const overrides = old.processThresholds && typeof old.processThresholds === 'object' ? old.processThresholds : {};
    for (const [kind, name] of Object.entries(KINDS)) {
      const own = overrides[kind] && typeof overrides[kind] === 'object' ? overrides[kind] : {};
      const absolute = own.warningPrivateGiB !== undefined || own.restartPrivateGiB !== undefined;
      // 0.5.x overrides were absolute while the remaining value still scaled; freeze both to keep the effective numbers.
      const warning = own.warningPrivateGiB ?? (old.warningPrivateGiB ?? 4) * (absolute ? factor : 1);
      const action = own.restartPrivateGiB ?? (old.restartPrivateGiB ?? 8) * (absolute ? factor : 1);
      const config = { schemaVersion: 1, name,
        label: LABELS[kind], description: 'Migrated from FrenchExDev Memory Watchdog 0.5.x settings.' };
      if (kind === 'editorServices') config.adapter = 'powershellEditorServices';
      else config.match = { processNames: ['pwsh'], ownership: kind };
      config.thresholds = { warningPrivateGiB: warning, actionPrivateGiB: action, consecutiveSamples: old.consecutiveSamples ?? 3,
        growthWarningMiB: old.growthWarningMiB ?? 500, growthWindowSeconds: old.growthWindowSeconds ?? 300 };
      config.action = kind === 'editorServices' ? { mode: 'automatic', restartCommand: 'PowerShell.RestartSession', graceSeconds: old.restartGraceSeconds ?? 30,
        cooldownSeconds: old.cooldownSeconds ?? 120, maxPerHour: old.maxAutomaticRestartsPerHour ?? 3, timeoutSeconds: old.restartTimeoutSeconds ?? 45,
        deferWhileDebugging: old.deferWhileDebugging === false ? [] : ['PowerShell'], deferWhileRunningCommands: old.deferWhileRunningCommands ?? true,
        requireKnownIdle: old.requireKnownIdle ?? false } : { mode: 'notifyOnly' };
      if (absolute) config.scaleWithWorkload = false;
      const result = validateConfig(config, { fileBase: name });
      if (!result.config) { errors.push(...result.errors.map((message) => `${name}: ${message}`)); continue; }
      const content = `${JSON.stringify(config, null, 2)}\n`;
      files.push({ name, fileName: `${name}${SUFFIX}`, content, hash: crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex') });
    }
  }
  return { settings, files, errors, needed: Object.keys(settings).length > 0 || files.length > 0 || errors.length > 0 };
}

/** Write migrated files without ever overwriting an existing user config. */
async function writeMigration(directory, files, { fs = fsp, platform = process.platform } = {}) {
  const path = pathFor(platform);
  await fs.mkdir(directory, { recursive: true });
  const written = [];
  const skipped = [];
  for (const file of files) {
    const target = path.join(directory, file.fileName);
    try { await fs.writeFile(target, file.content, { encoding: 'utf8', flag: 'wx' }); written.push({ ...file, file: target }); } catch (error) {
      if (error?.code === 'EEXIST') skipped.push({ ...file, file: target }); else throw error;
    }
  }
  return { written, skipped };
}

module.exports = { MIGRATION_KEY, OLD_SECTION, KINDS, GLOBAL_KEYS, TARGET_KEYS, buildMigration, writeMigration };