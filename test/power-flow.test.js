import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  ACTIVE_STATUS,
  IDLE_STATUS,
  matterToPercent,
  normalizeToWatts,
  percentToMatter,
  resolveAll,
  resolveGrid,
  resolveLoad,
  resolvePV,
  resolveStorage,
  wToMw,
  buildAccessoryUpdates,
} from '../src/solaredge/power-flow.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = resolve(__dirname, 'fixtures');

function loadFixture(name) {
  const raw = readFileSync(resolve(FIXTURE_DIR, name), 'utf8');
  return JSON.parse(raw).siteCurrentPowerFlow;
}

describe('normalizeToWatts', () => {
  it('converts 3.4 kW to 3400 W', () => {
    expect(normalizeToWatts(3.4, 'kW')).toBe(3400);
  });

  it('converts 0.005 MW to 5000 W', () => {
    expect(normalizeToWatts(0.005, 'MW')).toBe(5000);
  });

  it('passes watts through unchanged', () => {
    expect(normalizeToWatts(100, 'W')).toBe(100);
  });

  it('defaults to W when unit is missing', () => {
    expect(normalizeToWatts(3.4, undefined)).toBe(3.4);
  });

  it('falls back to W for unknown units', () => {
    expect(normalizeToWatts(3.4, 'GW')).toBe(3.4);
  });

  it('returns 0 for null', () => {
    expect(normalizeToWatts(null, 'kW')).toBe(0);
  });

  it('returns 0 for NaN', () => {
    expect(normalizeToWatts(NaN, 'W')).toBe(0);
  });
});

describe('wToMw', () => {
  it('converts 0.5 W to 500 mW', () => {
    expect(wToMw(0.5)).toBe(500);
  });
  it('preserves sign for negative watts', () => {
    expect(wToMw(-1234.5)).toBe(-1234500);
  });
  it('returns 0 for null', () => {
    expect(wToMw(null)).toBe(0);
  });
  it('returns 0 for NaN', () => {
    expect(wToMw(NaN)).toBe(0);
  });
});

describe('percentToMatter', () => {
  it('converts 75% to 150', () => {
    expect(percentToMatter(75)).toBe(150);
  });
  it('converts 100% to 200', () => {
    expect(percentToMatter(100)).toBe(200);
  });
  it('clamps above 100% to 200', () => {
    expect(percentToMatter(150)).toBe(200);
  });
  it('clamps below 0% to 0', () => {
    expect(percentToMatter(-10)).toBe(0);
  });
  it('returns null for null', () => {
    expect(percentToMatter(null)).toBe(null);
  });
});

describe('matterToPercent', () => {
  it('converts 200 to 100', () => {
    expect(matterToPercent(200)).toBe(100);
  });
  it('converts 150 to 75', () => {
    expect(matterToPercent(150)).toBe(75);
  });
  it('clamps above 200 to 100', () => {
    expect(matterToPercent(500)).toBe(100);
  });
});

describe('resolveGrid', () => {
  it('returns absent when GRID is missing', () => {
    const r = resolveGrid({});
    expect(r.present).toBe(false);
    expect(r.active).toBe(false);
    expect(r.power).toBe(0);
  });

  it('returns positive power when GRID is importing (GRID appears as "from")', () => {
    const pf = loadFixture('power-flow-grid-import.json');
    const r = resolveGrid(pf);
    expect(r.present).toBe(true);
    expect(r.active).toBe(true);
    expect(r.power).toBe(500);
  });

  it('returns negative power when GRID is exporting (GRID appears as "to")', () => {
    const pf = loadFixture('power-flow-grid-export.json');
    const r = resolveGrid(pf);
    expect(r.present).toBe(true);
    expect(r.active).toBe(true);
    expect(r.power).toBe(-500);
  });

  it('returns active=false when status is not "Active"', () => {
    const r = resolveGrid({ GRID: { status: 'Inactive', currentPower: 100 }, connections: [] });
    expect(r.present).toBe(true);
    expect(r.active).toBe(false);
    expect(r.rawStatus).toBe('Inactive');
  });

  it('scales currentPower from kW to watts', () => {
    const r = resolveGrid(
      { unit: 'kW', GRID: { status: 'Active', currentPower: 3.4 }, connections: [{ from: 'GRID', to: 'Load' }] },
      'kW',
    );
    expect(r.power).toBe(3400);
  });

  it('scales currentPower from MW to watts', () => {
    const r = resolveGrid(
      { unit: 'MW', GRID: { status: 'Active', currentPower: 0.005 }, connections: [{ from: 'GRID', to: 'Load' }] },
      'MW',
    );
    expect(r.power).toBe(5000);
  });
});

describe('resolveLoad', () => {
  it('returns present, always positive power', () => {
    const pf = loadFixture('power-flow-pv-only.json');
    const r = resolveLoad(pf);
    expect(r.present).toBe(true);
    expect(r.active).toBe(true);
    expect(r.power).toBe(1500);
  });

  it('returns absent when LOAD is missing', () => {
    const r = resolveLoad({});
    expect(r.present).toBe(false);
  });
});

describe('resolvePV', () => {
  it('returns present and active', () => {
    const pf = loadFixture('power-flow-pv-only.json');
    const r = resolvePV(pf);
    expect(r.present).toBe(true);
    expect(r.active).toBe(true);
    expect(r.power).toBe(1500);
  });
});

describe('resolveStorage', () => {
  it('sets charge=power, discharge=0 when STORAGE is "to" in connections', () => {
    const pf = loadFixture('power-flow-storage-charging.json');
    const r = resolveStorage(pf);
    expect(r.present).toBe(true);
    expect(r.active).toBe(true);
    expect(r.charge).toBe(250);
    expect(r.discharge).toBe(0);
    expect(r.chargeLevel).toBe(75);
    expect(r.critical).toBe(false);
  });

  it('sets discharge=power, charge=0 when STORAGE is "from" in connections', () => {
    const pf = loadFixture('power-flow-storage-discharging.json');
    const r = resolveStorage(pf);
    expect(r.charge).toBe(0);
    expect(r.discharge).toBe(300);
    expect(r.chargeLevel).toBe(45);
  });

  it('returns charge=0 and discharge=0 when STORAGE is idle', () => {
    const pf = loadFixture('power-flow-idle.json');
    const r = resolveStorage(pf);
    expect(r.charge).toBe(0);
    expect(r.discharge).toBe(0);
    expect(r.chargeLevel).toBe(60);
    expect(r.rawStatus).toBe(IDLE_STATUS);
  });

  it('treats status "Active" as active even when not connected', () => {
    const r = resolveStorage({
      STORAGE: { status: ACTIVE_STATUS, currentPower: 100, chargeLevel: 50 },
      connections: [],
    });
    expect(r.active).toBe(true);
  });

  it('returns chargeLevel=null when missing', () => {
    const r = resolveStorage({
      STORAGE: { status: 'Idle', currentPower: 0 },
      connections: [],
    });
    expect(r.chargeLevel).toBe(null);
  });

  it('flags critical=true from the response', () => {
    const pf = loadFixture('power-flow-critical-battery.json');
    const r = resolveStorage(pf);
    expect(r.critical).toBe(true);
  });
});

describe('resolveAll', () => {
  it('returns all four metrics', () => {
    const pf = loadFixture('power-flow-storage-charging.json');
    const r = resolveAll(pf);
    expect(Object.keys(r).sort()).toEqual(['GRID', 'LOAD', 'PV', 'STORAGE']);
    expect(r.STORAGE.chargeLevel).toBe(75);
  });

  it('logs a warning and assumes W when the response carries an unknown unit', () => {
    const log = { warn: vi.fn() };
    const pf = {
      unit: 'GW',
      GRID: { status: 'Active', currentPower: 3.4 },
      connections: [{ from: 'GRID', to: 'Load' }],
    };
    const r = resolveAll(pf, log);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('GW'));
    expect(r.GRID.power).toBe(3.4);
  });
});

describe('buildAccessoryUpdates', () => {
  it('returns { onOff, powerW } only (no energy fields)', () => {
    const pf = loadFixture('power-flow-grid-import.json');
    const resolved = resolveAll(pf);
    const updates = buildAccessoryUpdates(resolved);
    expect(updates.GRID).toBeDefined();
    expect(Object.keys(updates.GRID).sort()).toEqual(['onOff', 'powerW']);
    expect(updates.GRID.importedKwh).toBeUndefined();
    expect(updates.GRID.exportedKwh).toBeUndefined();
  });

  it('emits a negative powerW for STORAGE when the battery is charging', () => {
    const pf = loadFixture('power-flow-storage-charging.json');
    const resolved = resolveAll(pf);
    const updates = buildAccessoryUpdates(resolved);
    expect(updates.STORAGE.powerW).toBeLessThan(0);
  });

  it('emits a positive powerW for STORAGE when the battery is discharging', () => {
    const pf = loadFixture('power-flow-storage-discharging.json');
    const resolved = resolveAll(pf);
    const updates = buildAccessoryUpdates(resolved);
    expect(updates.STORAGE.powerW).toBeGreaterThan(0);
  });

  it('omits metrics that are not present', () => {
    const pf = loadFixture('power-flow-pv-only.json');
    const resolved = resolveAll(pf);
    const updates = buildAccessoryUpdates(resolved);
    expect(updates.STORAGE).toBeUndefined();
    expect(updates.PV).toBeDefined();
  });

  it('scales kW fixture values to watts in powerW', () => {
    const pf = loadFixture('power-flow-kw-unit.json');
    const resolved = resolveAll(pf);
    const updates = buildAccessoryUpdates(resolved);
    expect(updates.GRID.powerW).toBe(500);
    expect(updates.LOAD.powerW).toBe(2000);
    expect(updates.PV.powerW).toBe(1500);
  });
});
