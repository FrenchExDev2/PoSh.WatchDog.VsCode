'use strict';

const { pathFor, normalizeName } = require('./platform');

// Add a version only after qualifying its launch artifacts and window ownership checks.
const qualifiedPowerShellVersions = Object.freeze(['2026.1.2']);

class WatchdogError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// Paths compare case-insensitively only on Windows; POSIX file systems used by VS Code are case-sensitive by default.
const normalizePath = (value, platform = process.platform) => {
  const normalized = pathFor(platform).normalize(value);
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
};

function quotedArgument(command, name) {
  const matches = [...command.matchAll(new RegExp(`(?:^|\\s)-${name}\\s+'((?:[^']|'')*)'`, 'gi'))];
  return matches.length === 1 ? matches[0][1].replace(/''/g, "'") : null;
}

// This adapter deliberately supports the launch form inspected in PowerShell 2026.1.2.
// Unknown versions must be qualified before broadening the compatibility gate.
function candidateFromOptions(options, extension, platform = process.platform) {
  if (!options || typeof options.shellPath !== 'string' || !Array.isArray(options.shellArgs)) return null;
  const path = pathFor(platform);
  const same = (left, right) => normalizePath(left, platform) === normalizePath(right, platform);
  if (normalizeName(path.basename(options.shellPath), platform) !== 'pwsh') return null;
  const args = options.shellArgs;
  const commandIndex = args.findIndex((arg) => typeof arg === 'string' && arg.toLowerCase() === '-command');
  if (commandIndex < 0 || commandIndex !== args.length - 2) return null;
  const command = args[commandIndex + 1];
  if (typeof command !== 'string' || !/;\s*Start-EditorServices\s/i.test(command) || /-DebugServiceOnly\b/i.test(command)) return null;
  const modulePath = quotedArgument(command, 'Module');
  // Import-Module uses a positional path, not a named -Module parameter.
  const imported = /^Import-Module\s+'((?:[^']|'')*)';\s*Start-EditorServices\s/i.exec(command)?.[1]?.replace(/''/g, "'");
  if (modulePath || !imported || !same(imported, path.join(extension.extensionPath, 'modules', 'PowerShellEditorServices', 'PowerShellEditorServices.psd1'))) return null;
  const logPath = quotedArgument(command, 'LogPath');
  const sessionPath = quotedArgument(command, 'SessionDetailsPath');
  if (!logPath || !sessionPath || !same(logPath, extension.logPath)) return null;
  if (!same(path.dirname(sessionPath), path.join(extension.storagePath, 'sessions')) || !/^PSES-VSCode-\d+-\d+\.json$/i.test(path.basename(sessionPath))) return null;
  return { shellPath: options.shellPath, logPath, sessionPath };
}

async function resolveSession(vscode, { platform = process.platform } = {}) {
  const installed = ['ms-vscode.powershell', 'ms-vscode.powershell-preview']
    .map((id) => vscode.extensions.getExtension(id)).filter((extension) => extension?.isActive);
  if (!installed.length) return { state: 'waiting', detail: 'Waiting for an already running PowerShell extension.' };
  if (installed.length !== 1) throw new WatchdogError('ambiguous', 'Multiple active PowerShell extensions.');
  const extension = installed[0];
  if (extension.id.toLowerCase() !== 'ms-vscode.powershell' || !qualifiedPowerShellVersions.includes(extension.packageJSON.version)) {
    throw new WatchdogError('unsupported', `Editor Services restart is disabled for ${extension.id} ${extension.packageJSON.version}. Qualified: ms-vscode.powershell ${qualifiedPowerShellVersions.join(', ')}. Process monitoring and alerts remain available. Use a qualified version or qualify this version before enabling restart support.`);
  }
  const api = extension.exports;
  if (typeof api?.getLogUri !== 'function' || typeof api?.getStorageUri !== 'function') throw new WatchdogError('unsupported', 'PowerShell session association API unavailable.');
  const logUri = api.getLogUri();
  const storageUri = api.getStorageUri();
  if (logUri?.scheme !== 'file' || storageUri?.scheme !== 'file') throw new WatchdogError('unsupported', 'PowerShell session is not local.');
  const descriptor = { extensionPath: extension.extensionPath, logPath: logUri.fsPath, storagePath: storageUri.fsPath };
  const candidates = vscode.window.terminals.map((terminal) => ({
    terminal, candidate: candidateFromOptions(terminal.creationOptions, descriptor, platform),
  })).filter((entry) => entry.candidate);
  if (!candidates.length) return { state: 'waiting', detail: 'Waiting for a supported Editor Services terminal in this window.' };
  if (candidates.length !== 1) throw new WatchdogError('ambiguous', 'Multiple Editor Services terminals match this window.');
  const { terminal, candidate } = candidates[0];
  const pid = await terminal.processId;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new WatchdogError('unknown', 'Terminal process identity is unavailable.');
  return { ...candidate, pid, terminal, extensionVersion: extension.packageJSON.version };
}

module.exports = { WatchdogError, candidateFromOptions, resolveSession, normalizePath, qualifiedPowerShellVersions };
