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
    deviceTypes: { OnOffOutlet: 'OnOffPlugInUnit', ElectricalSensor: 'ElectricalSensor' },
    clusterNames: { OnOff: 'onOff', PowerSource: 'powerSource' },
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
    expect(accessory.clusters.electricalEnergyMeasurement).toBeDefined();
  });

  it('createBattery returns an ElectricalSensor with powerSource cluster', async () => {
    const accessory = await platform.ensureBatteryAccessory();
    expect(accessory).toBeDefined();
    expect(accessory.deviceType).toBe('ElectricalSensor');
    expect(accessory.context.metric).toBe('BATTERY');
    expect(accessory.clusters.powerSource).toBeDefined();
    expect(accessory.clusters.electricalPowerMeasurement.powerMode).toBe(1);
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
      context: { metric: 'GRID', direction: 'flow', importedKwh: 12.5, exportedKwh: 3.25 },
    };
    platform.configureAccessory(cached);
    expect(platform.registeredAccessories.get('uuid-cached')).toBe(cached);
    expect(platform.registeredAccessories.get('uuid-cached').context.importedKwh).toBe(12.5);
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
