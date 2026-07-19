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

  it('does not create battery switches when showBatterySwitches is false', async () => {
    platform.config.showBatterySwitches = false;
    const accessory = await platform.ensureSwitchAccessory('STORAGE', 'charge');
    expect(accessory).toBeNull();
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
