'use strict';

const os = require('node:os');
const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { pathFor } = require('./platform');

const SCHEMA_VERSION = 1;
const ADAPTERS = Object.freeze(['powershellEditorServices']);
const ADAPTER_COMMANDS = Object.freeze({ powershellEditorServices: 'PowerShell.RestartSession' });
const OWNERSHIPS = Object.freeze(['terminal', 'child', 'extensionHost', 'window']);
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const COMMAND = /^[A-Za-z0-9_.-]{1,128}$/;
const PROCESS_NAME = /^(?:\*|[^\\/\0]{1,128})$/;
const SUFFIX = '.watchdog.json';
const MAX_FILES = 200;
const MAX_BYTES = 64 * 1024;
const MAX_TARGETS = 32;
const BUILTIN_PROFILES = Object.freeze({ default: Object.freeze(['pwsh-editor-services', 'pwsh-terminals', 'pwsh-children']) });
const DEFAULT_PROFILE = 'default';
const APPROVALS_KEY = 'memoryWatchdog.approvals';

const isObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const number = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;

function unknownKeys(value, allowed, at, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${at}${key}: unknown property.`);
}

/**
 * Validate one parsed config. Returns a normalized copy with defaults applied, or errors; never throws.
 * `fileBase` is the file name without `.watchdog.json`; the declared name must match it exactly.
 */
function validateConfig(raw, { fileBase } = {}) {
  const errors = [];
  const warnings = [];
  if (!isObject(raw)) return { errors: ['The config must be a JSON object.'], warnings };
  unknownKeys(raw, ['$schema', 'schemaVersion', 'name', 'label', 'description', 'adapter', 'match', 'thresholds', 'action', 'scaleWithWorkload'], '', errors);
  if (raw.schemaVersion !== SCHEMA_VERSION) errors.push(`schemaVersion: must be ${SCHEMA_VERSION}.`);
  if (typeof raw.name !== 'string' || !NAME.test(raw.name)) errors.push('name: lowercase letters, digits, ".", "_" or "-" (max 64), starting with a letter or digit.');
  else if (fileBase !== undefined && raw.name !== fileBase) errors.push(`name: "${raw.name}" must equal the file name "${fileBase}${SUFFIX}".`);
  if (typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 80) errors.push('label: required text of at most 80 characters.');
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 500)) errors.push('description: text of at most 500 characters.');
  if (raw.scaleWithWorkload !== undefined && typeof raw.scaleWithWorkload !== 'boolean') errors.push('scaleWithWorkload: must be boolean.');
  if (raw.adapter !== undefined && !ADAPTERS.includes(raw.adapter)) errors.push(`adapter: must be one of ${ADAPTERS.join(', ')}.`);
  let match = null;
  if (raw.adapter !== undefined) {
    if (raw.match !== undefined) warnings.push('match: ignored because the adapter identifies its process itself.');
  } else if (!isObject(raw.match)) errors.push('match: required object (or set adapter).');
  else {
    unknownKeys(raw.match, ['processNames', 'ownership', 'commandLine'], 'match.', errors);
    const names = raw.match.processNames;
    if (!Array.isArray(names) || !names.length || names.length > 32 || names.some((name) => typeof name !== 'string' || !PROCESS_NAME.test(name))) {
      errors.push('match.processNames: 1 to 32 process names without path separators, or ["*"].');
    }
    if (!OWNERSHIPS.includes(raw.match.ownership)) errors.push(`match.ownership: must be one of ${OWNERSHIPS.join(', ')}.`);
    if (raw.match.commandLine !== undefined) {
      if (typeof raw.match.commandLine !== 'string' || !raw.match.commandLine || raw.match.commandLine.length > 512) errors.push('match.commandLine: regular expression of at most 512 characters.');
      else { try { new RegExp(raw.match.commandLine, 'i'); } catch { errors.push('match.commandLine: invalid regular expression.'); } }
    }
    if (Array.isArray(names) && names.includes('*') && raw.match.commandLine === undefined && raw.match.ownership !== 'terminal') {
      errors.push('match.processNames: "*" requires match.commandLine unless ownership is "terminal".');
    }
    match = { processNames: Array.isArray(names) ? [...names] : [], ownership: raw.match.ownership, commandLine: raw.match.commandLine };
  }
  const thresholds = isObject(raw.thresholds) ? raw.thresholds : null;
  if (!thresholds) errors.push('thresholds: required object.');
  else {
    unknownKeys(thresholds, ['warningPrivateGiB', 'actionPrivateGiB', 'consecutiveSamples', 'growthWarningMiB', 'growthWindowSeconds'], 'thresholds.', errors);
    if (!number(thresholds.warningPrivateGiB, 0.01, 1024)) errors.push('thresholds.warningPrivateGiB: number between 0.01 and 1024.');
    if (!number(thresholds.actionPrivateGiB, 0.01, 1024)) errors.push('thresholds.actionPrivateGiB: number between 0.01 and 1024.');
    else if (Number.isFinite(thresholds.warningPrivateGiB) && !(thresholds.warningPrivateGiB < thresholds.actionPrivateGiB)) errors.push('thresholds.actionPrivateGiB: must be greater than warningPrivateGiB.');
    if (thresholds.consecutiveSamples !== undefined && !(Number.isSafeInteger(thresholds.consecutiveSamples) && number(thresholds.consecutiveSamples, 1, 100))) errors.push('thresholds.consecutiveSamples: integer between 1 and 100.');
    if (thresholds.growthWarningMiB !== undefined && !number(thresholds.growthWarningMiB, 1, 1048576)) errors.push('thresholds.growthWarningMiB: number between 1 and 1048576.');
    if (thresholds.growthWindowSeconds !== undefined && !number(thresholds.growthWindowSeconds, 1, 86400)) errors.push('thresholds.growthWindowSeconds: number between 1 and 86400.');
  }
  const action = raw.action === undefined ? {} : raw.action;
  if (!isObject(action)) errors.push('action: must be an object.');
  else {
    unknownKeys(action, ['mode', 'restartCommand', 'graceSeconds', 'cooldownSeconds', 'maxPerHour', 'timeoutSeconds', 'deferWhileDebugging', 'deferWhileRunningCommands', 'requireKnownIdle'], 'action.', errors);
    if (action.mode !== undefined && !['automatic', 'notifyOnly'].includes(action.mode)) errors.push('action.mode: "automatic" or "notifyOnly".');
    if (action.restartCommand !== undefined && (typeof action.restartCommand !== 'string' || !COMMAND.test(action.restartCommand))) errors.push('action.restartCommand: a VS Code command id (letters, digits, ".", "_", "-").');
    if (raw.adapter && action.restartCommand !== undefined && action.restartCommand !== ADAPTER_COMMANDS[raw.adapter]) errors.push(`action.restartCommand: the ${raw.adapter} adapter only restarts through ${ADAPTER_COMMANDS[raw.adapter]}.`);
    if (action.mode === 'automatic' && !action.restartCommand && !raw.adapter) errors.push('action.mode: "automatic" requires action.restartCommand.');
    for (const [key, min, max] of [['graceSeconds', 0, 3600], ['cooldownSeconds', 1, 86400], ['timeoutSeconds', 1, 600]]) {
      if (action[key] !== undefined && !number(action[key], min, max)) errors.push(`action.${key}: number between ${min} and ${max}.`);
    }
    if (action.maxPerHour !== undefined && !(Number.isSafeInteger(action.maxPerHour) && number(action.maxPerHour, 1, 60))) errors.push('action.maxPerHour: integer between 1 and 60.');
    if (action.deferWhileDebugging !== undefined && (!Array.isArray(action.deferWhileDebugging) || action.deferWhileDebugging.length > 16 ||
      action.deferWhileDebugging.some((type) => typeof type !== 'string' || !COMMAND.test(type)))) errors.push('action.deferWhileDebugging: list of debug session types.');
    for (const key of ['deferWhileRunningCommands', 'requireKnownIdle']) if (action[key] !== undefined && typeof action[key] !== 'boolean') errors.push(`action.${key}: must be boolean.`);
  }
  if (errors.length) return { errors, warnings };
  const restartCommand = raw.adapter ? ADAPTER_COMMANDS[raw.adapter] : action.restartCommand || null;
  return { errors, warnings, config: Object.freeze({
    schemaVersion: SCHEMA_VERSION, name: raw.name, label: raw.label.trim(), description: raw.description || '', adapter: raw.adapter || null, match,
    thresholds: Object.freeze({ warningPrivateGiB: thresholds.warningPrivateGiB, actionPrivateGiB: thresholds.actionPrivateGiB,
      consecutiveSamples: thresholds.consecutiveSamples ?? 3, growthWarningMiB: thresholds.growthWarningMiB ?? 500, growthWindowSeconds: thresholds.growthWindowSeconds ?? 300 }),
    action: Object.freeze({ mode: restartCommand ? action.mode || 'notifyOnly' : 'notifyOnly', restartCommand, graceSeconds: action.graceSeconds ?? 30,
      cooldownSeconds: action.cooldownSeconds ?? 120, maxPerHour: action.maxPerHour ?? 3, timeoutSeconds: action.timeoutSeconds ?? 45,
      deferWhileDebugging: Object.freeze([...(action.deferWhileDebugging || [])]), deferWhileRunningCommands: action.deferWhileRunningCommands ?? true,
      requireKnownIdle: action.requireKnownIdle ?? false }),
    scaleWithWorkload: raw.scaleWithWorkload ?? true }) };
}

const defaultConfigDirectory = ({ home = os.homedir(), platform = process.platform } = {}) => pathFor(platform).join(home, '.frenchexdev', 'memory-watchdog');

/** Expand `~`, `${userHome}` and `${env:NAME}`; reject workspace-relative or relative locations. */
function expandConfigPath(raw, { env = process.env, home = os.homedir(), platform = process.platform } = {}) {
  const path = pathFor(platform);
  if (typeof raw !== 'string' || !raw.trim()) return { error: 'Empty path.' };
  let value = raw.trim();
  if (/\$\{workspaceFolder[^}]*\}/i.test(value)) return { error: '${workspaceFolder} is not allowed: config folders are machine-wide.' };
  if (value === '~' || /^~[\\/]/.test(value)) value = home + value.slice(1);
  let missing = null;
  value = value.replace(/\$\{userHome\}/g, home).replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_all, name) => {
    const found = platform === 'win32' ? Object.entries(env).find(([key]) => key.toUpperCase() === name.toUpperCase())?.[1] : env[name];
    if (typeof found !== 'string' || !found) missing = name;
    return found || '';
  });
  if (missing) return { error: `Environment variable ${missing} is not set.` };
  if (/\$\{[^}]*\}/.test(value)) return { error: 'Unsupported variable; use ~, ${userHome} or ${env:NAME}.' };
  if (!path.isAbsolute(value) || (platform === 'win32' && /^[\\/](?![\\/])/.test(value))) return { error: 'The path must be absolute after expansion.' };
  return { path: path.normalize(value) };
}

const comparablePath = (value, platform = process.platform) => {
  const normalized = pathFor(platform).normalize(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
};

function isInside(file, folder, platform = process.platform) {
  const relative = pathFor(platform).relative(comparablePath(folder, platform), comparablePath(file, platform));
  return relative === '' || (!!relative && !relative.startsWith('..') && !pathFor(platform).isAbsolute(relative));
}

/**
 * Load built-in then user configs. Later directories win on a name collision; invalid files are excluded
 * individually and reported, never breaking the others.
 */
async function loadConfigs({ builtinDirectory, directories = [], fs = fsp, platform = process.platform, workspaceFolders = [] } = {}) {
  const path = pathFor(platform);
  const configs = new Map();
  const issues = [];
  const infos = [];
  const sources = [...(builtinDirectory ? [{ path: builtinDirectory, builtin: true, optional: false }] : []), ...directories];
  const seen = new Set();
  for (const source of sources) {
    const key = comparablePath(source.path, platform);
    if (seen.has(key)) continue;
    seen.add(key);
    let names;
    try { names = await fs.readdir(source.path); } catch (error) {
      if (!(source.optional && error?.code === 'ENOENT')) issues.push({ severity: source.optional ? 'info' : 'warning', file: source.path, message: `Config folder unavailable (${error?.code || 'error'}).` });
      continue;
    }
    const files = names.filter((name) => (platform === 'win32' ? name.toLowerCase() : name).endsWith(SUFFIX)).sort();
    if (files.length > MAX_FILES) issues.push({ severity: 'warning', file: source.path, message: `Only the first ${MAX_FILES} configs are loaded.` });
    for (const name of files.slice(0, MAX_FILES)) {
      const file = path.join(source.path, name);
      const fileBase = name.slice(0, -SUFFIX.length);
      try {
        const stat = await fs.stat(file);
        if (!stat.isFile()) continue;
        if (stat.size > MAX_BYTES) { issues.push({ severity: 'error', file, message: `Larger than ${MAX_BYTES / 1024} KiB.` }); continue; }
        const bytes = await fs.readFile(file);
        const hash = crypto.createHash('sha256').update(bytes).digest('hex');
        let parsed;
        try { parsed = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); } catch { issues.push({ severity: 'error', file, message: 'Invalid JSON.' }); continue; }
        const result = validateConfig(parsed, { fileBase });
        for (const warning of result.warnings) issues.push({ severity: 'warning', file, name: fileBase, message: warning });
        if (!result.config) { for (const message of result.errors) issues.push({ severity: 'error', file, name: fileBase, message }); continue; }
        const previous = configs.get(result.config.name);
        const entry = { name: result.config.name, config: result.config, file, directory: source.path, builtin: !!source.builtin, hash,
          inWorkspace: workspaceFolders.some((folder) => isInside(file, folder, platform)), overrides: previous ? previous.file : null };
        if (previous) infos.push(`${result.config.name}: ${file} overrides ${previous.file}.`);
        configs.set(entry.name, entry);
      } catch (error) {
        issues.push({ severity: 'error', file, message: `Unreadable (${error?.code || 'error'}).` });
      }
    }
  }
  return { configs, issues, infos };
}

/** Resolve the active profile; an unknown profile falls back to the built-in default with automatic actions off. */
function resolveProfile(userProfiles, activeProfile, configs) {
  const warnings = [];
  const profiles = { ...BUILTIN_PROFILES };
  if (isObject(userProfiles)) {
    for (const [name, list] of Object.entries(userProfiles)) {
      if (!NAME.test(name) || !Array.isArray(list) || list.some((item) => typeof item !== 'string')) { warnings.push(`Profile ${name}: must be a list of config names.`); continue; }
      profiles[name] = list;
    }
  } else if (userProfiles !== undefined && userProfiles !== null) warnings.push('profiles: must be an object of name to config list.');
  let name = typeof activeProfile === 'string' && activeProfile ? activeProfile : DEFAULT_PROFILE;
  let fallback = false;
  if (!Object.hasOwn(profiles, name)) {
    warnings.push(`Active profile "${name}" does not exist; using "${DEFAULT_PROFILE}" with automatic actions disabled.`);
    name = DEFAULT_PROFILE; fallback = true;
  }
  const targets = [];
  for (const configName of [...new Set(profiles[name])]) {
    const entry = configs.get(configName);
    if (!entry) { warnings.push(`Profile ${name}: unknown or invalid config "${configName}".`); continue; }
    if (targets.length >= MAX_TARGETS) { warnings.push(`Profile ${name}: only ${MAX_TARGETS} configs are monitored.`); break; }
    targets.push(entry);
  }
  return { name, fallback, targets, warnings, available: Object.keys(profiles) };
}

const approvalKey = (file, platform = process.platform) => comparablePath(file, platform);
const isApproved = (approvals, entry, platform = process.platform) => !!entry && (entry.builtin || (isObject(approvals) && approvals[approvalKey(entry.file, platform)] === entry.hash));
const approve = (approvals, entry, platform = process.platform) => ({ ...(isObject(approvals) ? approvals : {}), [approvalKey(entry.file, platform)]: entry.hash });
/** An automatic restart from a user config needs explicit approval of this exact content. */
const needsApproval = (entry, approvals, platform = process.platform) => !!entry?.config.action.restartCommand && entry.config.action.mode === 'automatic' && !isApproved(approvals, entry, platform);

/** Translate a config into the PolicyEngine shape and decide whether automatic actions are allowed. */
function targetPolicy(entry, globals, { approvals = {}, trusted = true, forceNotify = false, platform = process.platform } = {}) {
  const { config } = entry;
  const reasons = [];
  if (globals.mode !== 'automatic') reasons.push('global mode is notify only');
  if (config.action.mode !== 'automatic' || !config.action.restartCommand) reasons.push('config is notify only');
  else {
    if (!isApproved(approvals, entry, platform)) reasons.push('restart command not approved');
    if (entry.inWorkspace && !trusted) reasons.push('config is in an untrusted workspace');
  }
  if (forceNotify) reasons.push('active profile unavailable');
  const automatic = reasons.length === 0;
  return { automatic, reasons, command: config.action.restartCommand, debugTypes: config.action.deferWhileDebugging,
    policy: { ...globals, mode: automatic ? 'automatic' : 'notifyOnly', warningPrivateGiB: config.thresholds.warningPrivateGiB,
      restartPrivateGiB: config.thresholds.actionPrivateGiB, consecutiveSamples: config.thresholds.consecutiveSamples,
      growthWarningMiB: config.thresholds.growthWarningMiB, growthWindowSeconds: config.thresholds.growthWindowSeconds,
      restartGraceSeconds: config.action.graceSeconds, cooldownSeconds: config.action.cooldownSeconds,
      maxAutomaticRestartsPerHour: config.action.maxPerHour, restartTimeoutSeconds: config.action.timeoutSeconds,
      deferWhileDebugging: config.action.deferWhileDebugging.length > 0, deferWhileRunningCommands: config.action.deferWhileRunningCommands,
      requireKnownIdle: config.action.requireKnownIdle, profile: config.scaleWithWorkload ? globals.workload || 'development' : 'development',
      processThresholds: {} } };
}

/** The collector's view of a target: matching only, nothing that could trigger an action. */
const collectorTarget = (entry) => ({ name: entry.name, adapter: entry.config.adapter, processNames: entry.config.match?.processNames,
  ownership: entry.config.match?.ownership, commandLine: entry.config.match?.commandLine });

module.exports = { SCHEMA_VERSION, SUFFIX, BUILTIN_PROFILES, DEFAULT_PROFILE, APPROVALS_KEY, ADAPTER_COMMANDS, validateConfig, defaultConfigDirectory,
  expandConfigPath, isInside, loadConfigs, resolveProfile, approvalKey, isApproved, approve, needsApproval, targetPolicy, collectorTarget };