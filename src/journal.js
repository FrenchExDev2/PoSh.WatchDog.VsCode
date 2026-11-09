// Legacy journal retained for historical regression tests only; production uses history.js.
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');

class Journal {
  constructor(directory, { maxBytes = 5 * 1024 ** 2, files = 3 } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.files = files;
    this.history = [];
    this.pending = Promise.resolve();
    this.error = null;
  }

  append(entry) {
    this.history.push(entry);
    if (this.history.length > 200) this.history.shift();
    const line = JSON.stringify(entry) + '\n';
    // Serialize writes and rotation; each controller iteration awaits its append.
    this.pending = this.pending.then(async () => {
      await fs.mkdir(this.directory, { recursive: true });
      const filename = path.join(this.directory, 'watchdog.0.jsonl');
      const size = await fs.stat(filename).then((stat) => stat.size, (error) => {
        if (error.code === 'ENOENT') return 0;
        throw error;
      });
      if (size + Buffer.byteLength(line) > this.maxBytes) {
        await fs.rm(path.join(this.directory, `watchdog.${this.files - 1}.jsonl`), { force: true });
        for (let index = this.files - 2; index >= 0; index--) {
          await fs.rename(path.join(this.directory, `watchdog.${index}.jsonl`),
            path.join(this.directory, `watchdog.${index + 1}.jsonl`)).catch((error) => {
            if (error.code !== 'ENOENT') throw error;
          });
        }
      }
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error('Journal entry exceeds budget.');
      await fs.appendFile(filename, line, 'utf8');
      this.error = null;
    }).catch(() => { this.error = 'Journal unavailable; in-memory history remains bounded to 200 entries.'; });
    return this.pending;
  }

  readRetainedHistory() {
    // Share the rotation/write queue only while taking the bounded disk snapshot.
    const reading = this.pending.then(async () => {
      const result = { files: [], issues: [], bytesRead: 0, missingFiles: 0 };
      for (let index = this.files - 1; index >= 0; index--) {
        const name = `watchdog.${index}.jsonl`;
        let handle;
        try {
          handle = await fs.open(path.join(this.directory, name), 'r');
          const stat = await handle.stat();
          if (!stat.isFile()) throw new Error('Journal path is not a regular file.');
          const length = Math.min(stat.size, this.maxBytes);
          const buffer = Buffer.alloc(length);
          let offset = 0;
          while (offset < length) {
            const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
            if (!bytesRead) break;
            offset += bytesRead;
          }
          if (stat.size > this.maxBytes) result.issues.push({ file: name, code: 'byteLimit' });
          result.bytesRead += offset;
          result.files.push({ name, text: buffer.subarray(0, offset).toString('utf8') });
        } catch (error) {
          if (error.code === 'ENOENT') result.missingFiles++;
          else result.issues.push({ file: name, code: 'unreadable' });
        } finally { await handle?.close(); }
      }
      return result;
    });
    // An export read failure must not poison subsequent monitoring writes.
    this.pending = reading.then(() => {}, () => {});
    return reading.then(async ({ files, ...result }) => {
      const entries = [];
      let invalidLines = 0;
      let linesRead = 0;
      for (const file of files) {
        for (const line of file.text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try {
            const value = JSON.parse(line);
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid entry.');
            entries.push(value);
          } catch { invalidLines++; }
          if (++linesRead % 256 === 0) await new Promise((resolve) => setImmediate(resolve));
        }
      }
      return { ...result, filesRead: files.length, invalidLines, entries };
    });
  }
}

module.exports = { Journal };
