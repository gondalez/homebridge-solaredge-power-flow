import { PLUGIN_NAME, PLATFORM_NAME } from './settings.js';
import { SolarEdgeClient, AuthError, RateLimitError, NetworkError } from './solaredge/client.js';
import { resolveAll, buildAccessoryUpdates } from './solaredge/power-flow.js';
import { buildSwitchAccessory, applySwitchUpdate } from './accessories/power-switch.js';
import { buildBatteryAccessory, applyBatteryUpdate } from './accessories/battery.js';
import { formatError } from './util/logger.js';

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
  constructor(log, config, api, options = {}) {
    this.log = log;
    this.config = config || {};
    this.api = api;
    this.accessories = new Map();
    this.pollTimer = null;
    this.pollInFlight = false;
    this.lastTotals = {};
    this.matterAvailable = Boolean(api.matter);
    this._injectedClient = options.client || null;

    api.on('didFinishLaunching', () => this.start());
    api.on('shutdown', () => this.stop());
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

    try {
      this.client = this._injectedClient || new SolarEdgeClient(this.log, this.config.apiKey);
    } catch (e) {
      this.log.error(`SolarEdge: failed to construct API client: ${formatError(e)}`);
      return;
    }

    this.refreshIntervalMs = clampInt(
      this.config.refreshIntervalSeconds,
      MIN_REFRESH_INTERVAL_SECONDS,
      MAX_REFRESH_INTERVAL_SECONDS,
      DEFAULT_REFRESH_INTERVAL_SECONDS,
    ) * 1000;

    this.log.info('SolarEdge plugin v0.0.1 starting');
    this.log.info(`  siteId: ${this.config.siteId}`);
    this.log.info(`  refresh: ${this.refreshIntervalMs / 1000}s`);
    this.log.info('  matter: available');

    this.runPoll();
  }

  stop() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  scheduleNextPoll() {
    if (this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.runPoll();
    }, this.refreshIntervalMs);
  }

  runPoll() {
    this.pollAndSchedule().catch((e) => {
      this.log.error(`SolarEdge: poll loop crashed: ${formatError(e)}`);
    });
  }

  async pollAndSchedule() {
    try {
      await this.poll();
    } finally {
      this.scheduleNextPoll();
    }
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
    const resolved = resolveAll(pf);
    const { updates, totals } = buildAccessoryUpdates(resolved, this.lastTotals, Date.now());
    this.lastTotals = { ...this.lastTotals, ...totals };

    for (const [metric, u] of Object.entries(updates)) {
      try {
        await this.applyMetricUpdate(metric, u);
      } catch (e) {
        this.log.error(`SolarEdge: update for ${metric} failed: ${formatError(e)}`);
      }
    }

    try {
      await this.applyBatteryUpdate(resolved.STORAGE);
    } catch (e) {
      this.log.error(`SolarEdge: battery update failed: ${formatError(e)}`);
    }
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
      accessory,
      update: {
        onOff: update.onOff,
        powerW: update.powerW,
        importedKwh: update.importedKwh,
        exportedKwh: update.exportedKwh,
      },
      matter: this.api.matter,
      log: this.log,
    });
  }

  async markBothStorageSwitchesOff() {
    for (const direction of ['charge', 'discharge']) {
      const accessory = this.findRegistered('STORAGE', direction);
      if (!accessory) continue;
      accessory.context.consecutiveMissingPolls = 0;
      try {
        await this.api.matter.updateAccessoryState(accessory.UUID, 'onOff', { onOff: false });
      } catch (e) {
        this.log.error(`SolarEdge: failed to mark ${accessory.displayName} off: ${formatError(e)}`);
      }
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
      log: this.log,
    });
  }

  handleError(err) {
    if (err instanceof AuthError) {
      this.log.error(
        `SolarEdge auth failed for siteId=${this.config.siteId}: ${err.message}. ` +
          `Polling stopped; fix apiKey and restart Homebridge.`,
      );
      this.stop();
      return;
    }
    if (err instanceof RateLimitError) {
      const wait = err.retryAfterSeconds != null ? `${err.retryAfterSeconds}s` : 'unknown';
      this.log.error(
        `SolarEdge rate limit hit (retry after ${wait}). Polling paused until the next scheduled tick. ` +
          `Reduce refreshIntervalSeconds if this recurs.`,
      );
      this.bumpMissingPolls(null);
      return;
    }
    if (err instanceof NetworkError) {
      this.log.error(
        `SolarEdge network error: ${err.message}. ` +
          `Check connectivity and the SolarEdge status page; polling will retry on the next tick.`,
      );
      this.bumpMissingPolls(null);
      return;
    }
    this.log.error(`SolarEdge poll failed: ${formatError(err)}`);
    this.bumpMissingPolls(null);
  }

  bumpMissingPolls(specificMetric) {
    for (const acc of this.accessories.values()) {
      if (specificMetric && acc.context.metric !== specificMetric) continue;
      acc.context.consecutiveMissingPolls = (acc.context.consecutiveMissingPolls || 0) + 1;
      if (acc.context.consecutiveMissingPolls >= UNREGISTER_AFTER_MISSING_POLLS) {
        this.unregisterAccessory(acc);
      }
    }
  }

  unregisterAccessory(accessory) {
    this.log.info(
      `SolarEdge: unregistering ${accessory.displayName} (UUID=${accessory.UUID}, ` +
        `key absent for ${UNREGISTER_AFTER_MISSING_POLLS} polls)`,
    );
    this.accessories.delete(accessory.UUID);
    this.api.matter
      .unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory])
      .then(() => this.log.info(`SolarEdge: unregistered ${accessory.displayName}`))
      .catch((e) => this.log.error(`SolarEdge: failed to unregister ${accessory.displayName}: ${formatError(e)}`));
  }

  async ensureSwitchAccessory(metric, direction) {
    const existing = this.findRegistered(metric, direction);
    if (existing) return existing;

    const displayName = pickDisplayName(this.config, metric, direction);
    const initial = this.lastTotals[metric];
    let accessory;
    try {
      accessory = buildSwitchAccessory({
        api: this.api,
        siteId: this.config.siteId,
        metric,
        direction,
        displayName,
        initial,
      });
    } catch (e) {
      this.log.error(`SolarEdge: failed to build ${displayName} accessory: ${formatError(e)}`);
      return null;
    }
    try {
      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(accessory.UUID, accessory);
      this.log.info(`SolarEdge: registered ${accessory.displayName} (UUID=${accessory.UUID})`);
      return accessory;
    } catch (e) {
      this.log.error(`SolarEdge: failed to register ${accessory.displayName}: ${formatError(e)}`);
      return null;
    }
  }

  async ensureBatteryAccessory() {
    const existing = this.findRegistered('BATTERY', 'sensor');
    if (existing) return existing;
    const displayName = this.config.accessoryNames?.battery || DEFAULT_DISPLAY_NAMES.BATTERY;
    const initial = this.lastTotals.STORAGE || {};
    let accessory;
    try {
      accessory = buildBatteryAccessory({
        api: this.api,
        siteId: this.config.siteId,
        displayName,
        initial: {
          chargeKwh: initial.importedKwh ?? 0,
          dischargeKwh: initial.exportedKwh ?? 0,
          lastTs: initial.lastTs ?? Date.now(),
        },
      });
    } catch (e) {
      this.log.error(`SolarEdge: failed to build ${displayName} accessory: ${formatError(e)}`);
      return null;
    }
    try {
      await this.api.matter.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.set(accessory.UUID, accessory);
      this.log.info(`SolarEdge: registered ${accessory.displayName} (UUID=${accessory.UUID})`);
      return accessory;
    } catch (e) {
      this.log.error(`SolarEdge: failed to register ${accessory.displayName}: ${formatError(e)}`);
      return null;
    }
  }

  findRegistered(metric, direction) {
    for (const acc of this.accessories.values()) {
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
