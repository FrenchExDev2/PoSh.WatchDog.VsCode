'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { defaults } = require('./policy');
const historyName = /^watchdog-history-\d{13}-[\da-f-]{36}\.jsonl$/;
const reportName = /^watchdog-[\dTZ.-]+-[\da-f-]{36}\.html$/;

/** Remove only owned regular files, oldest first, with a combined byte and age budget. */
async function pruneFiles(directory, pattern, { days, bytes, reserve = 0, now = Date.now() }) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const filename = path.join(directory, entry.name);
    const stat = await fs.lstat(filename).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    if (stat?.isFile()) files.push({ filename, name: entry.name, bytes: stat.size, at: stat.mtimeMs });
  }
  files.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
  let total = files.reduce((sum, file) => sum + file.bytes, 0);
  const retained = [];
  for (const file of files) {
    if (file.at < now - days * 86400_000 || total + reserve > bytes) {
      await fs.rm(file.filename, { force: true }); total -= file.bytes;
    } else retained.push(file);
  }
  return retained;
}

/** Workspace-scoped history across reloads; each activation writes its own segment. */
class PersistentJournal {
  constructor(directory, policy = defaults, now = Date.now) {
    this.directory = directory; this.now = now; this.configure(policy);
    this.history = []; this.error = null; this.sessionId = randomUUID();
    this.filename = null; this.segmentBytes = 0;
    this.pending = this.restore().catch(() => { this.error = 'Persistent history unavailable; current in-memory history is bounded to 200 entries.'; });
    this.ready = this.pending;
  }

  configure(policy) {
    this.days = Number.isFinite(policy.historyRetentionDays) && policy.historyRetentionDays >= 1 && policy.historyRetentionDays <= 365 ? policy.historyRetentionDays : defaults.historyRetentionDays;
    this.maxBytes = (Number.isFinite(policy.historyMaxMiB) && policy.historyMaxMiB >= 1 && policy.historyMaxMiB <= 100 ? policy.historyMaxMiB : defaults.historyMaxMiB) * 1024 ** 2;
  }

  async files(reserve = 0) {
    await fs.mkdir(this.directory, { recursive: true });
    return pruneFiles(this.directory, historyName, { days: this.days, bytes: this.maxBytes, reserve, now: this.now() });
  }

  async read() {
    const files = await this.files();
    const entries = []; const issues = [];
    let bytesRead = 0; let invalidLines = 0;
    for (const file of files) {
      let handle;
      try {
        handle = await fs.open(file.filename, 'r');
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > this.maxBytes - bytesRead) { issues.push({ file: file.name, code: 'byteLimit' }); continue; }
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
          const part = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!part.bytesRead) break;
          offset += part.bytesRead;
        }
        bytesRead += offset;
        const lines = buffer.subarray(0, offset).toString('utf8').split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
          if (!lines[index].trim()) continue;
          try {
            const entry = JSON.parse(lines[index]); const at = Date.parse(entry?.at);
            if (!Number.isFinite(at) || Array.isArray(entry)) throw new Error('Invalid entry');
            if (at >= this.now() - this.days * 86400_000 && at <= this.now() + 60_000) entries.push(entry);
          } catch { invalidLines++; }
          if (index % 256 === 0) await new Promise((resolve) => setImmediate(resolve));
        }
      } catch (error) { if (error.code !== 'ENOENT') issues.push({ file: file.name, code: 'unreadable' }); }
      finally { await handle?.close(); }
    }
    entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    return { entries, filesRead: files.length, bytesRead, invalidLines, issues, scope: 'workspace' };
  }

  async restore() { const retained = await this.read(); this.history = retained.entries.slice(-200); }

  append(entry) {
    const value = { ...entry, sessionId: this.sessionId };
    this.history.push(value); this.history = this.history.slice(-200);
    const line = JSON.stringify(value) + '\n'; const size = Buffer.byteLength(line);
    this.pending = this.pending.then(async () => {
      if (size > this.maxBytes) throw new Error('Entry exceeds history budget');
      const files = await this.files(size);
      if (!this.filename || !files.some((file) => file.filename === this.filename) || this.segmentBytes + size > Math.min(this.maxBytes, 1024 ** 2)) {
        this.filename = path.join(this.directory, `watchdog-history-${String(this.now()).padStart(13, '0')}-${randomUUID()}.jsonl`);
        this.segmentBytes = 0;
      }
      await fs.appendFile(this.filename, line, 'utf8'); this.segmentBytes += size; this.error = null;
    }).catch(() => { this.error = 'Persistent history unavailable; current in-memory history is bounded to 200 entries.'; });
    return this.pending;
  }

  readRetainedHistory() {
    const reading = this.pending.then(() => this.read());
    this.pending = reading.then(() => {}, () => {}); return reading;
  }
}

/** Reserve report storage and prune only this extension's old HTML exports. */
async function pruneReports(directory, policy = defaults, reserve = 0) {
  const days = Number.isFinite(policy.reportRetentionDays) && policy.reportRetentionDays >= 1 && policy.reportRetentionDays <= 365 ? policy.reportRetentionDays : defaults.reportRetentionDays;
  const bytes = (Number.isFinite(policy.reportMaxMiB) && policy.reportMaxMiB >= 1 && policy.reportMaxMiB <= 500 ? policy.reportMaxMiB : defaults.reportMaxMiB) * 1024 ** 2;
  if (reserve > bytes) throw new Error('Report exceeds configured report storage budget. Increase reportMaxMiB or reduce history retention.');
  return pruneFiles(directory, reportName, { days, bytes, reserve });
}

module.exports = { PersistentJournal, pruneReports };
