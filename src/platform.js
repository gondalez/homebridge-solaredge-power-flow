import { PLUGIN_NAME, PLATFORM_NAME } from './settings.js';
import { SolarEdgeClient, AuthError } from './solaredge/client.js';
import { resolveAll, buildAccessoryUpdates } from './solaredge/power-flow.js';
import { buildSwitchAccessory, applySwitchUpdate } from './accessories/power-switch.js';
import { buildBatteryAccessory, applyBatteryUpdate } from './accessories/battery.js';

const DEFAULT_REFRESH_INTERVAL_SECONDS = 900;
const MIN_REFRESH_INTERVAL_SECONDS = 30;
const MAX_REFRESH_INTERVAL_SECONDS = 3600;
const UNREGISTER_AFTER_MISSING_POLLS = 2;

const DEFAULT_DISPLAY_NAMES = {
  GRID: 'Grid',
  LOAD: 'Load',
  PV: 'PV',
  BATTERY_CHARGE: 'Battery Charge',
  BATTERY_DISCHARGE: 'Battery Discharge',
  BATTERY: 'Battery',
};

export class SolarEdgePowerFlowPlatform {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.registeredAccessories = new Map();
    this.pollTimer = null;
    this.pollInFlight = false;
    this.lastTotals = {};
    this.matterAvailable = Boolean(api.matter);

    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.stop());
  }

  configureAccessory(accessory) {
    this.registeredAccessories.set(accessory.UUID, accessory);
  }

  accessories(callback) {
    callback([...this.registeredAccessories.values()]);
  }

  start() {
    const errors = validateConfig(this.config);
    if (errors.length > 0) {
      this.log.error('SolarEdge plugin: invalid configuration; not starting.');
      for (const err of errors) this.log.error(`  - ${err}`);
      return;
    }

    if (!this.matterAvailable) {
      this.log.error(
        'SolarEdge plugin: api.matter is not available. This plugin requires Homebridge v2.2+ with a Matter-enabled bridge. ' +
          'Add `matter: { enabled: true }` to your bridge or child-bridge config and restart Homebridge.',
      );
      return;
    }

    this.client = new SolarEdgeClient(this.log, this.config.apiKey);
    this.refreshIntervalMs = clampInt(
      this.config.refreshIntervalSeconds,
      MIN_REFRESH_INTERVAL_SECONDS,
      MAX_REFRESH_INTERVAL_SECONDS,
      DEFAULT_REFRESH_INTERVAL_SECONDS,
    ) * 1000;

    this.log.info(`SolarEdge: starting; poll every ${this.refreshIntervalMs / 1000}s`);

    this.pollAndSchedule();
  }

  stop() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  async pollAndSchedule() {
    await this.poll();
    if (this.pollTimer) this.pollTimer = setTimeout(() => this.pollAndSchedule(), this.refreshIntervalMs);
  }

  async poll() {
    if (this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      const pf = await this.client.getCurrentPowerFlow(this.config.siteId);
      await this.handleSuccess(pf);
    } catch (err) {
      this.handleError(err);
    } finally {
      this.pollInFlight = false;
    }
  }

  async handleSuccess(pf) {
    const resolved = resolveAll(pf, this.log);
    const { updates, totals } = buildAccessoryUpdates(resolved, this.lastTotals, Date.now());
    this.lastTotals = { ...this.lastTotals, ...totals };

    for (const [metric, u] of Object.entries(updates)) {
      await this.applyMetricUpdate(metric, u);
    }

    await this.applyBatteryUpdate(resolved.STORAGE);
  }

  async applyMetricUpdate(metric, update) {
    if (metric === 'STORAGE') {
      if (update.powerW > 0) {
        await this.updateSwitchAccessory('STORAGE', 'discharge', { ...update, powerW: update.powerW });
      } else if (update.powerW < 0) {
        await this.updateSwitchAccessory('STORAGE', 'charge', { ...update, powerW: update.powerW });
      } else {
        await this.markBothStorageSwitchesOff();
      }
      return;
    }
    await this.updateSwitchAccessory(metric, 'flow', update);
  }

  async updateSwitchAccessory(metric, direction, update) {
    const accessory = await this.ensureSwitchAccessory(metric, direction);
    if (!accessory) return;
    accessory.context.consecutiveMissingPolls = 0;
    await applySwitchUpdate({
      api: this.api,
      accessory,
      update: {
        onOff: update.onOff,
        powerW: update.powerW,
        importedKwh: update.importedKwh,
        exportedKwh: update.exportedKwh,
      },
      matter: this.api.matter,
    });
  }

  async markBothStorageSwitchesOff() {
    for (const direction of ['charge', 'discharge']) {
      const accessory = this.findRegistered('STORAGE', direction);
      if (!accessory) continue;
      accessory.context.consecutiveMissingPolls = 0;
      await this.api.matter.updateAccessoryState(accessory.UUID, 'onOff', { onOff: false });
    }
  }

  async applyBatteryUpdate(storage) {
    if (!storage?.present) {
      await this.bumpMissingPolls('BATTERY');
      return;
    }
    const accessory = await this.ensureBatteryAccessory();
    if (!accessory) return;
    accessory.context.consecutiveMissingPolls = 0;
    await applyBatteryUpdate({
      matter: this.api.matter,
      accessory,
      chargeW: storage.charge,
      dischargeW: storage.discharge,
      chargeLevel: storage.chargeLevel,
      critical: storage.critical,
      onOff: storage.active,
    });
  }

  handleError(err) {
    if (err instanceof AuthError) {
      this.log.error(`SolarEdge auth failed: ${err.message}. Polling stopped; fix apiKey and restart Homebridge.`);
      this.stop();
      return;
    }
    this.log.warn(`SolarEdge poll failed (${err.name}): ${err.message}`);
    this.bumpMissingPolls(null);
  }

  bumpMissingPolls(specificMetric) {
    for (const acc of this.registeredAccessories.values()) {
      if (specificMetric && acc.context.metric !== specificMetric) continue;
      acc.context.consecutiveMissingPolls = (acc.context.consecutiveMissingPolls || 0) + 1;
      if (acc.context.consecutiveMissingPolls >= UNREGISTER_AFTER_MISSING_POLLS) {
        this.unregisterAccessory(acc);
      }
    }
  }

  unregisterAccessory(accessory) {
    this.log.info(`SolarEdge: unregistering ${accessory.displayName} (key absent for ${UNREGISTER_AFTER_MISSING_POLLS} polls)`);
    this.registeredAccessories.delete(accessory.UUID);
    this.api.matter
      .unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      .catch((e) => this.log.warn(`Failed to unregister ${accessory.displayName}: ${e.message}`));
  }

  async ensureSwitchAccessory(metric, direction) {
    const existing = this.findRegistered(metric, direction);
    if (existing) return existing;

    const displayName = pickDisplayName(this.config, metric, direction);
    const initial = this.lastTotals[metric];
    const accessory = buildSwitchAccessory({
      api: this.api,
      siteId: this.config.siteId,
      metric,
      direction,
      displayName,
      initial,
    });
    try {
      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.registeredAccessories.set(accessory.UUID, accessory);
      this.log.info(`SolarEdge: registered ${accessory.displayName}`);
      return accessory;
    } catch (e) {
      this.log.error(`Failed to register ${accessory.displayName}: ${e.message}`);
      return null;
    }
  }

  async ensureBatteryAccessory() {
    const existing = this.findRegistered('BATTERY', 'sensor');
    if (existing) return existing;
    const displayName = this.config.accessoryNames?.battery || DEFAULT_DISPLAY_NAMES.BATTERY;
    const initial = this.lastTotals.STORAGE || {};
    const accessory = buildBatteryAccessory({
      api: this.api,
      siteId: this.config.siteId,
      displayName,
      initial: {
        chargeKwh: initial.importedKwh ?? 0,
        dischargeKwh: initial.exportedKwh ?? 0,
        lastTs: initial.lastTs ?? Date.now(),
      },
    });
    try {
      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.registeredAccessories.set(accessory.UUID, accessory);
      this.log.info(`SolarEdge: registered ${accessory.displayName}`);
      return accessory;
    } catch (e) {
      this.log.error(`Failed to register ${accessory.displayName}: ${e.message}`);
      return null;
    }
  }

  findRegistered(metric, direction) {
    for (const acc of this.registeredAccessories.values()) {
      if (acc.context.metric === metric && acc.context.direction === direction) return acc;
    }
    return null;
  }
}

function clampInt(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function validateConfig(config) {
  const errors = [];
  if (!config.apiKey || typeof config.apiKey !== 'string') {
    errors.push('apiKey is required');
  }
  if (!Number.isFinite(config.siteId)) {
    errors.push('siteId is required and must be a number');
  }
  return errors;
}

function pickDisplayName(config, metric, direction) {
  const names = config.accessoryNames || {};
  if (metric === 'STORAGE') {
    if (direction === 'charge') return names.batteryCharge || DEFAULT_DISPLAY_NAMES.BATTERY_CHARGE;
    if (direction === 'discharge') return names.batteryDischarge || DEFAULT_DISPLAY_NAMES.BATTERY_DISCHARGE;
  }
  const key = metric.toLowerCase();
  return names[key] || DEFAULT_DISPLAY_NAMES[metric] || metric;
}
