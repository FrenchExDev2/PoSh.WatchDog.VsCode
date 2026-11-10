'use strict';

// One Braille cell keeps the loading indicator in a fixed status-bar footprint.
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const IDLE_FRAME = frames[0];

/** Animate only during collection; stop owned timers when idle or disposed. */
function createLoadingSpinner(onFrame, timers = { setInterval, clearInterval }) {
  let timer;
  let index = 0;
  let disposed = false;
  return {
    get frame() { return frames[index]; },
    setCollecting(active) {
      if (disposed) return;
      if (active && timer === undefined) {
        timer = timers.setInterval(() => {
          if (disposed || timer === undefined) return;
          index = (index + 1) % frames.length;
          onFrame();
        }, 100);
      } else if (!active && timer !== undefined) {
        timers.clearInterval(timer);
        timer = undefined;
      }
    },
    dispose() {
      disposed = true;
      if (timer !== undefined) timers.clearInterval(timer);
      timer = undefined;
    },
  };
}

module.exports = { createLoadingSpinner, IDLE_FRAME };
