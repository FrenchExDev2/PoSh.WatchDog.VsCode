'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLoadingSpinner } = require('../src/loading-spinner');
const { describeStatus } = require('../src/presentation');

test('the spinner completes the terminal loading cycle in one fixed cell', () => {
  let tick;
  const animation = createLoadingSpinner(() => {}, {
    setInterval(callback) { tick = callback; return 1; }, clearInterval() {},
  });
  animation.setCollecting(true);
  for (const expected of '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⠋') {
    assert.equal(animation.frame, expected);
    tick();
  }
  animation.dispose();
});

test('generated collection sequences own at most one timer and never animate after disposal', () => {
  let callback; let ticks = 0; let next = 0;
  const pending = new Set();
  const animation = createLoadingSpinner(() => ticks++, {
    setInterval(fn, milliseconds) { assert.equal(milliseconds, 100); callback = fn; pending.add(++next); return next; },
    clearInterval(id) { assert.ok(pending.delete(id)); },
  });
  assert.equal(animation.frame, '⠋');
  // Deterministic state-sequence fuzzing with an independent active/idle invariant.
  let seed = 7321;
  for (let i = 0; i < 512; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const active = Boolean(seed & 128);
    const restingPose = animation.frame;
    animation.setCollecting(active);
    assert.equal(animation.frame, restingPose, 'starting and stopping never replace the displayed pose');
    assert.equal(pending.size, Number(active));
    const before = ticks;
    const frame = animation.frame;
    callback?.();
    assert.equal(ticks - before, Number(active));
    assert.match(animation.frame, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]$/);
    assert.equal([...animation.frame].length, 1);
    if (active) {
      assert.notEqual(animation.frame, frame);
    } else assert.equal(animation.frame, frame);
  }
  animation.setCollecting(true);
  animation.dispose(); animation.dispose();
  const before = ticks;
  callback(); animation.setCollecting(true);
  assert.equal(ticks, before);
  assert.equal(pending.size, 0);
});

test('collection animation preserves every state label, warning marker and measurement', () => {
  for (const state of ['normal', 'warning', 'disabled', 'suspended', 'error', 'waiting', 'countdown', 'restarting', 'unknown']) {
    for (const processes of [[], [{ pid: 42, privateBytes: 1024, workingSetBytes: 2048 }]]) {
    for (const collecting of [false, true]) {
      const snapshot = { state, health: { collecting }, configs: { errors: 1 }, inventory: { complete: false },
        processes };
      const idle = describeStatus(snapshot);
      const moving = describeStatus(snapshot, '⠙');
      assert.match(moving.text, /1 proc.*≥ 1 KiB total|Watchdog/);
      assert.match(moving.text, /\$\(warning\)$/);
      assert.equal(moving.tooltip, idle.tooltip);
      assert.match(moving.text, /⠙/);
      assert.equal(moving.text.length, idle.text.length);
      assert.equal(moving.text.indexOf('⠙'), idle.text.indexOf('⠋'));
      assert.equal(describeStatus({ ...snapshot, health: { collecting: !collecting } }, '⠙').text, moving.text);
      if (state !== 'normal' && (state !== 'waiting' || processes.length)) {
        assert.ok(moving.text.includes(state === 'unknown' ? 'unknown' : require('../src/presentation').stateLabels[state]));
      }
    }
    }
  }
});
