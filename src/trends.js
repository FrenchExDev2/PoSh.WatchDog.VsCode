'use strict';

const { identityKey } = require('./policy');
const MiB = 1024 ** 2;

/** Track bounded, identity-specific observations; growth is an alert, not proof of a leak. */
class TrendTracker {
  constructor() { this.entries = new Map(); }

  update(processes, policy, now) {
    const live = new Set();
    for (const sample of processes) {
      const key = identityKey(sample); live.add(key);
      let entry = this.entries.get(key);
      const gap = (policy.sampleIntervalSeconds * 2.5 + policy.collectTimeoutSeconds) * 1000;
      if (!entry || now <= entry.at || now - entry.at > gap) entry = { points: [], at: now, warned: false };
      entry.at = now;
      const cutoff = now - policy.growthWindowSeconds * 1000;
      while (entry.points.length > 1 && entry.points[1].at <= cutoff) entry.points.shift();
      entry.points.push({ at: now, bytes: sample.privateBytes, cpu: sample.cpuTimeMs });
      const first = entry.points[0];
      const span = now - first.at;
      const deltaMiB = (sample.privateBytes - first.bytes) / MiB;
      const rising = entry.points.slice(1).filter((point, index) => point.bytes >= entry.points[index].bytes).length;
      const confirmed = entry.points.length >= 3 && span >= policy.growthWindowSeconds * 1000 &&
        deltaMiB >= policy.growthWarningMiB && rising / (entry.points.length - 1) >= 0.75;
      const previous = entry.points.at(-2);
      const cpuDelta = previous && Number.isFinite(sample.cpuTimeMs) && Number.isFinite(previous.cpu) ? sample.cpuTimeMs - previous.cpu : null;
      sample.cpuPercent = cpuDelta !== null && cpuDelta >= 0 && now > previous.at ? cpuDelta / (now - previous.at) * 100 : null;
      sample.growth = { deltaMiB, rateMiBPerMinute: span > 0 ? deltaMiB / (span / 60000) : null,
        observedSeconds: span / 1000, warning: confirmed, notify: confirmed && !entry.warned };
      entry.warned = confirmed;
      // Preserve window coverage at fast sampling rates by thinning interior points, never its endpoints.
      if (entry.points.length > 1024) entry.points = entry.points.filter((_point, index, points) => index === 0 || index === points.length - 1 || index % 2 === 0);
      this.entries.set(key, entry);
    }
    for (const key of this.entries.keys()) if (!live.has(key)) this.entries.delete(key);
  }

  clear() { this.entries.clear(); }
}

module.exports = { TrendTracker };
