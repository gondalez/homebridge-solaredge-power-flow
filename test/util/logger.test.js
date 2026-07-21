import { describe, it, expect } from 'vitest';
import { formatError, truncate } from '../../src/util/logger.js';

describe('formatError', () => {
  it('returns "unknown error" for nullish values', () => {
    expect(formatError(null)).toBe('unknown error');
    expect(formatError(undefined)).toBe('unknown error');
  });

  it('returns the string for a string input', () => {
    expect(formatError('boom')).toBe('boom');
  });

  it('includes name and message for an Error', () => {
    const err = new TypeError('nope');
    const out = formatError(err);
    expect(out).toContain('TypeError');
    expect(out).toContain('nope');
  });

  it('includes the cause chain', () => {
    const root = new Error('root cause');
    const wrapper = new Error('wrapper', { cause: root });
    const out = formatError(wrapper);
    expect(out).toContain('wrapper');
    expect(out).toContain('Caused by');
    expect(out).toContain('root cause');
  });

  it('includes the stack when present', () => {
    const err = new Error('with stack');
    const out = formatError(err);
    expect(out).toContain(err.stack.split('\n')[0]);
  });
});

describe('truncate', () => {
  it('returns empty for nullish', () => {
    expect(truncate(null)).toBe('');
    expect(truncate(undefined)).toBe('');
  });

  it('returns the string unchanged when short enough', () => {
    expect(truncate('hello', 10)).toBe('hello');
  });

  it('truncates long strings with an ellipsis', () => {
    expect(truncate('x'.repeat(20), 5)).toBe('xxxxx…');
  });

  it('coerces non-strings', () => {
    expect(truncate(12345, 3)).toBe('123…');
  });
});
