'use strict';

// These pure functions run identically in unit tests and in the offline report.
function createChartTools() {
  function segments(entries, identity, field, fallbackInterval) {
    const result = [];
    let segment = [];
    let previous = null;
    for (const entry of entries) {
      const process = entry.processes.find((item) => item.id === identity) ||
        (entry.sample?.id === identity ? entry.sample : null);
      const interval = entry.sampleIntervalSeconds || fallbackInterval;
      const value = process?.[field];
      if (!Number.isFinite(value) || (previous !== null && entry.at - previous > interval * 2500)) {
        if (segment.length) result.push(segment);
        segment = [];
      }
      if (Number.isFinite(value)) segment.push({ at: entry.at, value });
      previous = entry.at;
    }
    if (segment.length) result.push(segment);
    return result;
  }

  function thinSegment(points, limit = 1000) {
    if (points.length <= limit || limit < 4) return points;
    const selected = new Set([0, points.length - 1]);
    const buckets = Math.max(1, Math.floor((limit - 2) / 2));
    for (let bucket = 0; bucket < buckets; bucket++) {
      const start = 1 + Math.floor(bucket * (points.length - 2) / buckets);
      const end = 1 + Math.floor((bucket + 1) * (points.length - 2) / buckets);
      let low = start;
      let high = start;
      for (let index = start + 1; index < end; index++) {
        if (points[index].value < points[low].value) low = index;
        if (points[index].value > points[high].value) high = index;
      }
      selected.add(low); selected.add(high);
    }
    return [...selected].sort((left, right) => left - right).map((index) => points[index]);
  }

  const MiB = 1024 ** 2;
  const GiB = 1024 ** 3;
  /** Linear axis from zero with round ticks: MiB below 1 GiB, GiB above, so small processes are not flattened. */
  function memoryScale(maxBytes, targetTicks = 4) {
    const top = Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0;
    const unitBytes = top >= GiB ? GiB : MiB;
    const unit = unitBytes === GiB ? 'GiB' : 'MiB';
    const value = Math.max(1, top / unitBytes);
    const rawStep = value / targetTicks;
    const magnitude = 10 ** Math.floor(Math.log10(rawStep));
    const step = [1, 2, 2.5, 4, 5, 10].find((factor) => factor * magnitude >= rawStep * (1 - 1e-9)) * magnitude;
    const intervals = Math.max(1, Math.ceil(value / step - 1e-9));
    const digits = Math.max(0, -Math.floor(Math.log10(step)) + 1);
    const ticks = Array.from({ length: intervals + 1 }, (_, index) => ({ bytes: index * step * unitBytes,
      label: `${Number((index * step).toFixed(digits))} ${unit}` }));
    return { unit, unitBytes, stepBytes: step * unitBytes, ceilingBytes: intervals * step * unitBytes, ticks };
  }

  /** Thresholds far above the data would flatten every trace: only those within `reach` × the data peak widen the scale. */
  function scaleTop(dataMax, thresholds = [], reach = 2) {
    const peak = Number.isFinite(dataMax) && dataMax > 0 ? dataMax : 0;
    return thresholds.filter((value) => Number.isFinite(value) && value > 0 && value <= peak * reach).reduce((top, value) => Math.max(top, value), peak);
  }

  /** Human memory value: MiB below 1 GiB, GiB with two decimals above. */
  function formatBytes(bytes, unknown = '—') {
    if (!Number.isFinite(bytes)) return unknown;
    return Math.abs(bytes) >= GiB ? `${(bytes / GiB).toFixed(2)} GiB` : `${(bytes / MiB).toFixed(0)} MiB`;
  }

  return { segments, thinSegment, memoryScale, scaleTop, formatBytes };
}

module.exports = { createChartTools };
