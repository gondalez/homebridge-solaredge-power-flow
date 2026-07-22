import { describe, it, expect } from 'vitest';
import { chargeLevelToMatterLevel } from '../../src/accessories/battery.js';

describe('chargeLevelToMatterLevel', () => {
  it('returns 0 for null', () => {
    expect(chargeLevelToMatterLevel(null)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(chargeLevelToMatterLevel(undefined)).toBe(0);
  });

  it('returns 0 for NaN', () => {
    expect(chargeLevelToMatterLevel(NaN)).toBe(0);
  });

  it('maps 0% to 0', () => {
    expect(chargeLevelToMatterLevel(0)).toBe(0);
  });

  it('maps 100% to 254', () => {
    expect(chargeLevelToMatterLevel(100)).toBe(254);
  });

  it('maps 50% to roughly half (127)', () => {
    expect(chargeLevelToMatterLevel(50)).toBe(127);
  });

  it('maps 25% to 64', () => {
    expect(chargeLevelToMatterLevel(25)).toBeCloseTo(64, 0);
  });

  it('clamps above 100% to 254', () => {
    expect(chargeLevelToMatterLevel(150)).toBe(254);
  });

  it('clamps below 0% to 0', () => {
    expect(chargeLevelToMatterLevel(-5)).toBe(0);
  });

  it('handles a realistic midrange value', () => {
    expect(chargeLevelToMatterLevel(73)).toBe(185);
  });
});
