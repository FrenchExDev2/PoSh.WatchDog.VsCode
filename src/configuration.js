'use strict';

const { defaults } = require('./policy');

const SECTION = 'frenchexdev.memoryWatchdog';
const LEGACY_SECTION = 'frenchexdev.powershellWatchdog';
/** Machine-wide settings of 0.6 and the 0.5.x key each one falls back to until migration. */
const GLOBAL_SETTINGS = Object.freeze({
  enabled: { legacy: 'enabled', fallback: defaults.enabled },
  mode: { legacy: 'mode', fallback: defaults.mode },
  sampleIntervalSeconds: { legacy: 'sampleIntervalSeconds', fallback: defaults.sampleIntervalSeconds },
  collectTimeoutSeconds: { legacy: 'collectTimeoutSeconds', fallback: defaults.collectTimeoutSeconds },
  historyRetentionDays: { legacy: 'historyRetentionDays', fallback: defaults.historyRetentionDays },
  historyMaxMiB: { legacy: 'historyMaxMiB', fallback: defaults.historyMaxMiB },
  reportRetentionDays: { legacy: 'reportRetentionDays', fallback: defaults.reportRetentionDays },
  reportMaxMiB: { legacy: 'reportMaxMiB', fallback: defaults.reportMaxMiB },
  workload: { legacy: 'profile', fallback: defaults.profile },
  configPaths: { legacy: null, fallback: [] },
  profiles: { legacy: null, fallback: {} },
  activeProfile: { legacy: null, fallback: 'default' },
});

/** 0.5.x reader kept for the legacy single-target policy shape. */
function readMachinePolicy(configuration) {
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => {
    const value = configuration.inspect(key)?.globalValue;
    return [key, value === undefined ? fallback : value];
  }));
}

/** Read user-machine values only; workspace values are ignored even when injected manually. */
function readGlobals(configuration, legacy) {
  return Object.fromEntries(Object.entries(GLOBAL_SETTINGS).map(([key, { legacy: legacyKey, fallback }]) => {
    let value = configuration?.inspect(key)?.globalValue;
    if (value === undefined && legacyKey && legacy) value = legacy.inspect(legacyKey)?.globalValue;
    return [key, value === undefined ? fallback : value];
  }));
}

/** Only the 0.5.x values the user explicitly set; used to offer and build the migration. */
function readLegacyValues(legacy) {
  const values = {};
  for (const key of Object.keys(defaults)) {
    const value = legacy?.inspect(key)?.globalValue;
    if (value !== undefined) values[key] = value;
  }
  return values;
}

/** Engine-shaped policy built from globals; thresholds stay at their defaults until a target config sets them. */
function globalPolicy(globals) {
  const policy = { ...defaults, ...globals, profile: globals.workload };
  for (const key of ['configPaths', 'profiles', 'activeProfile']) delete policy[key];
  return policy;
}

module.exports = { SECTION, LEGACY_SECTION, GLOBAL_SETTINGS, readMachinePolicy, readGlobals, readLegacyValues, globalPolicy };