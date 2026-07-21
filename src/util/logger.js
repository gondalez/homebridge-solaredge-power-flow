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

export function formatError(err) {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  const head = `${err.name || 'Error'}: ${err.message || '(no message)'}`;
  const cause = err.cause ? `\nCaused by: ${formatError(err.cause)}` : '';
  const stack = err.stack ? `\n${err.stack}` : '';
  return `${head}${cause}${stack}`;
}

export function truncate(text, max = 500) {
  if (text == null) return '';
  const s = typeof text === 'string' ? text : String(text);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
