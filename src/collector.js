'use strict';



const { WatchdogError } = require('./session');

function withDeadline(action, milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, new WatchdogError('cancelled', 'Operation cancelled.'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(reject, new WatchdogError('timeout', 'Operation deadline exceeded.')), milliseconds);
    Promise.resolve().then(action).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

module.exports = { withDeadline };
