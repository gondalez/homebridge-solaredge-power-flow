import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SolarEdgePowerFlowPlatform } from '../src/platform.js';

const silentLogger = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
};

function makeApi() {
  const events = {};
  const matter = {
    uuid: { generate: (s) => `uuid-${s}` },
    deviceTypes: { OnOffOutlet: 'OnOffPlugInUnit', DimmableLight: 'DimmableLight' },
    clusterNames: { OnOff: 'onOff', LevelControl: 'levelControl' },
    registerPlatformAccessories: vi.fn(async () => {}),
    updateAccessoryState: vi.fn(async () => {}),
    unregisterPlatformAccessories: vi.fn(async () => {}),
  };
  return {
    on(event, cb) {
      events[event] = cb;
    },
    fire(event) {
      if (events[event]) events[event]();
    },
    matter,
    log: silentLogger,
    events,
  };
}

describe('SolarEdgePowerFlowPlatform - config validation', () => {
  it('logs an error and does not start when apiKey is missing', () => {
    const log = { ...silentLogger, error: vi.fn() };
    const api = makeApi();
    new SolarEdgePowerFlowPlatform(log, { siteId: 12345 }, api);
    api.fire('didFinishLaunching');
    expect(log.error).toHaveBeenCalled();
  });

  it('logs an error and does not start when siteId is missing', () => {
    const log = { ...silentLogger, error: vi.fn() };
    const api = makeApi();
    new SolarEdgePowerFlowPlatform(log, { apiKey: 'K' }, api);
    api.fire('didFinishLaunching');
    expect(log.error).toHaveBeenCalled();
  });

  it('logs an error when matter is not available', () => {
    const log = { ...silentLogger, error: vi.fn() };
    const api = makeApi();
    api.matter = undefined;
    new SolarEdgePowerFlowPlatform(log, { apiKey: 'K', siteId: 1 }, api);
    api.fire('didFinishLaunching');
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('api.matter is not available'));
  });
});

describe('SolarEdgePowerFlowPlatform - accessory creation', () => {
  let platform;
  let api;
  let log;

  beforeEach(() => {
    log = { ...silentLogger, info: vi.fn() };
    api = makeApi();
    platform = new SolarEdgePowerFlowPlatform(log, { apiKey: 'K', siteId: 12345 }, api);
  });

  it('createSwitch returns a Matter accessory with the right device type and clusters', async () => {
    const accessory = await platform.ensureSwitchAccessory('GRID', 'flow');
    expect(accessory).toBeDefined();
    expect(accessory.deviceType).toBe('OnOffPlugInUnit');
    expect(accessory.UUID).toBe('uuid-solaredge-12345-GRID-flow');
    expect(accessory.context.metric).toBe('GRID');
    expect(accessory.context.direction).toBe('flow');
    expect(accessory.clusters.onOff).toBeDefined();
    expect(accessory.clusters.electricalPowerMeasurement).toBeDefined();
    expect(accessory.clusters.electricalEnergyMeasurement).toBeUndefined();
  });

  it('createBattery returns a DimmableLight fader with onOff + levelControl clusters', async () => {
    const accessory = await platform.ensureBatteryAccessory();
    expect(accessory).toBeDefined();
    expect(accessory.deviceType).toBe('DimmableLight');
    expect(accessory.context.metric).toBe('BATTERY');
    expect(accessory.clusters.onOff.onOff).toBe(true);
    expect(accessory.clusters.levelControl.currentLevel).toBe(0);
    expect(accessory.clusters.levelControl.minLevel).toBe(0);
    expect(accessory.clusters.levelControl.maxLevel).toBe(254);
    expect(accessory.clusters.powerSource).toBeUndefined();
    expect(accessory.clusters.electricalPowerMeasurement).toBeUndefined();
    expect(accessory.clusters.electricalEnergyMeasurement).toBeUndefined();
    expect(accessory.handlers.onOff).toBeDefined();
    expect(accessory.handlers.levelControl).toBeDefined();
  });

  it('reuses a registered accessory on a second ensureSwitchAccessory call', async () => {
    const a1 = await platform.ensureSwitchAccessory('GRID', 'flow');
    const a2 = await platform.ensureSwitchAccessory('GRID', 'flow');
    expect(a1).toBe(a2);
    expect(api.matter.registerPlatformAccessories).toHaveBeenCalledTimes(1);
  });

  it('finds a registered accessory by metric+direction', async () => {
    const a1 = await platform.ensureSwitchAccessory('PV', 'flow');
    const found = platform.findRegistered('PV', 'flow');
    expect(found).toBe(a1);
  });
});

describe('SolarEdgePowerFlowPlatform - Homebridge Platform API', () => {
  it('configureAccessory stores the cached accessory under its UUID and preserves context', () => {
    const api = makeApi();
    const platform = new SolarEdgePowerFlowPlatform(silentLogger, { apiKey: 'K', siteId: 12345 }, api);
    const cached = {
      UUID: 'uuid-cached',
      displayName: 'Grid',
      context: { metric: 'GRID', direction: 'flow' },
    };
    platform.configureAccessory(cached);
    expect(platform.registeredAccessories.get('uuid-cached')).toBe(cached);
    expect(platform.registeredAccessories.get('uuid-cached').context.metric).toBe('GRID');
  });

  it('accessories(callback) invokes the callback with an empty array when nothing is registered', () => {
    const api = makeApi();
    const platform = new SolarEdgePowerFlowPlatform(silentLogger, { apiKey: 'K', siteId: 12345 }, api);
    const cb = vi.fn();
    platform.accessories(cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith([]);
  });

  it('accessories(callback) returns the array of currently-registered accessories', async () => {
    const api = makeApi();
    const platform = new SolarEdgePowerFlowPlatform(silentLogger, { apiKey: 'K', siteId: 12345 }, api);
    const grid = { UUID: 'uuid-grid', displayName: 'Grid', context: { metric: 'GRID', direction: 'flow' } };
    const pv = { UUID: 'uuid-pv', displayName: 'PV', context: { metric: 'PV', direction: 'flow' } };
    platform.configureAccessory(grid);
    platform.configureAccessory(pv);
    const cb = vi.fn();
    platform.accessories(cb);
    const result = cb.mock.calls[0][0];
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([grid, pv]));
  });
});

describe('SolarEdgePowerFlowPlatform - STORAGE charge/discharge exclusivity', () => {
  function findStateForUuid(matter, uuid, cluster) {
    return matter.updateAccessoryState.mock.calls
      .filter((c) => c[0] === uuid && c[1] === cluster)
      .map((c) => c[2]);
  }

  function lastStateForUuid(matter, uuid, cluster) {
    const calls = matter.updateAccessoryState.mock.calls
      .filter((c) => c[0] === uuid && c[1] === cluster);
    return calls.length ? calls[calls.length - 1][2] : undefined;
  }

  it('registers both charge and discharge switches on the first STORAGE poll, even when idle', async () => {
    const log = { ...silentLogger, info: vi.fn() };
    const api = makeApi();
    const platform = new SolarEdgePowerFlowPlatform(log, { apiKey: 'K', siteId: 12345 }, api);
    await platform.applyMetricUpdate('STORAGE', { onOff: false, powerMW: 0 });
    expect(platform.findRegistered('STORAGE', 'charge')).toBeDefined();
    expect(platform.findRegistered('STORAGE', 'discharge')).toBeDefined();
  });

  it('lights the charge switch and turns the discharge switch off when charging', async () => {
    const log = { ...silentLogger, info: vi.fn() };
    const api = makeApi();
    const platform = new SolarEdgePowerFlowPlatform(log, { apiKey: 'K', siteId: 12345 }, api);
    await platform.applyMetricUpdate('STORAGE', { onOff: true, powerMW: -2_500_000 });

    const charge = platform.findRegistered('STORAGE', 'charge');
    const discharge = platform.findRegistered('STORAGE', 'discharge');

    expect(lastStateForUuid(api.matter, charge.UUID, 'onOff')).toEqual({ onOff: true });
    expect(lastStateForUuid(api.matter, charge.UUID, 'electricalPowerMeasurement')).toEqual({ activePower: 2_500_000 });
    expect(lastStateForUuid(api.matter, discharge.UUID, 'onOff')).toEqual({ onOff: false });
    expect(lastStateForUuid(api.matter, discharge.UUID, 'electricalPowerMeasurement')).toEqual({ activePower: 0 });
  });

  it('lights the discharge switch and turns the charge switch off when discharging', async () => {
    const log = { ...silentLogger, info: vi.fn() };
    const api = makeApi();
    const platform = new SolarEdgePowerFlowPlatform(log, { apiKey: 'K', siteId: 12345 }, api);
    await platform.applyMetricUpdate('STORAGE', { onOff: true, powerMW: 1_800_000 });

    const charge = platform.findRegistered('STORAGE', 'charge');
    const discharge = platform.findRegistered('STORAGE', 'discharge');

    expect(lastStateForUuid(api.matter, discharge.UUID, 'onOff')).toEqual({ onOff: true });
    expect(lastStateForUuid(api.matter, discharge.UUID, 'electricalPowerMeasurement')).toEqual({ activePower: 1_800_000 });
    expect(lastStateForUuid(api.matter, charge.UUID, 'onOff')).toEqual({ onOff: false });
    expect(lastStateForUuid(api.matter, charge.UUID, 'electricalPowerMeasurement')).toEqual({ activePower: 0 });
  });

  it('keeps both switches off when the battery is idle', async () => {
    const log = { ...silentLogger, info: vi.fn() };
    const api = makeApi();
    const platform = new SolarEdgePowerFlowPlatform(log, { apiKey: 'K', siteId: 12345 }, api);
    await platform.applyMetricUpdate('STORAGE', { onOff: false, powerMW: 0 });

    const charge = platform.findRegistered('STORAGE', 'charge');
    const discharge = platform.findRegistered('STORAGE', 'discharge');

    expect(lastStateForUuid(api.matter, charge.UUID, 'onOff')).toEqual({ onOff: false });
    expect(lastStateForUuid(api.matter, discharge.UUID, 'onOff')).toEqual({ onOff: false });
    expect(lastStateForUuid(api.matter, charge.UUID, 'electricalPowerMeasurement')).toEqual({ activePower: 0 });
    expect(lastStateForUuid(api.matter, discharge.UUID, 'electricalPowerMeasurement')).toEqual({ activePower: 0 });
  });

  it('turns the previously-active switch off when direction flips (charge → discharge)', async () => {
    const log = { ...silentLogger, info: vi.fn() };
    const api = makeApi();
    const platform = new SolarEdgePowerFlowPlatform(log, { apiKey: 'K', siteId: 12345 }, api);

    await platform.applyMetricUpdate('STORAGE', { onOff: true, powerMW: -2_500_000 });
    await platform.applyMetricUpdate('STORAGE', { onOff: true, powerMW: 1_800_000 });

    const charge = platform.findRegistered('STORAGE', 'charge');
    const discharge = platform.findRegistered('STORAGE', 'discharge');

    const chargeOnOffStates = findStateForUuid(api.matter, charge.UUID, 'onOff');
    expect(chargeOnOffStates[chargeOnOffStates.length - 1]).toEqual({ onOff: false });

    const dischargeOnOffStates = findStateForUuid(api.matter, discharge.UUID, 'onOff');
    expect(dischargeOnOffStates[dischargeOnOffStates.length - 1]).toEqual({ onOff: true });
  });

  it('reports power as a positive milliwatt value on the active switch regardless of direction', async () => {
    const log = { ...silentLogger, info: vi.fn() };
    const api = makeApi();
    const platform = new SolarEdgePowerFlowPlatform(log, { apiKey: 'K', siteId: 12345 }, api);

    await platform.applyMetricUpdate('STORAGE', { onOff: true, powerMW: -2_500_000 });
    const charge = platform.findRegistered('STORAGE', 'charge');
    const chargePower = findStateForUuid(api.matter, charge.UUID, 'electricalPowerMeasurement');
    expect(chargePower[chargePower.length - 1].activePower).toBe(2_500_000);
    expect(chargePower[chargePower.length - 1].activePower).toBeGreaterThan(0);

    api.matter.updateAccessoryState.mockClear();
    await platform.applyMetricUpdate('STORAGE', { onOff: true, powerMW: 1_800_000 });
    const discharge = platform.findRegistered('STORAGE', 'discharge');
    const dischargePower = findStateForUuid(api.matter, discharge.UUID, 'electricalPowerMeasurement');
    expect(dischargePower[dischargePower.length - 1].activePower).toBe(1_800_000);
    expect(dischargePower[dischargePower.length - 1].activePower).toBeGreaterThan(0);
  });
});
