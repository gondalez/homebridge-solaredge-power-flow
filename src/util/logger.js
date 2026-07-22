export function silentLogger() {
  const noop = () => {};
  return {
    info: noop,
    debug: noop,
    warn: noop,
    error: noop,
  };
}

export function wrapLogger(log) {
  return {
    info: (...args) => log.info(...args),
    debug: (...args) => log.debug(...args),
    warn: (...args) => log.warn(...args),
    error: (...args) => log.error(...args),
  };
}
