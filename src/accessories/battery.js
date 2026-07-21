import { kwhToMwh, percentToMatter, wToMw } from '../solaredge/power-flow.js';
import { formatError } from '../util/logger.js';

const BATTERY_OK_MIN = 50;
const BATTERY_WARNING_MIN = 20;
const MATTER_OK = 0;
const MATTER_WARNING = 1;
const MATTER_CRITICAL = 2;

export function buildBatteryAccessory({ api, siteId, displayName, initial }) {
  return {
    UUID: api.matter.uuid.generate(`solaredge-${siteId}-battery`),
    displayName,
    serialNumber: `SE-${siteId}-BATTERY`,
    manufacturer: 'SolarEdge',
    model: 'Power Flow Battery',
    firmwareRevision: '1.0.0',
    context: {
      metric: 'BATTERY',
      direction: 'sensor',
      chargeKwh: initial?.chargeKwh ?? 0,
      dischargeKwh: initial?.dischargeKwh ?? 0,
      lastTs: initial?.lastTs ?? Date.now(),
      consecutiveMissingPolls: 0,
    },
    deviceType: api.matter.deviceTypes.ElectricalSensor,
    clusters: {
      electricalPowerMeasurement: {
        activePower: 0,
        powerMode: 1,
      },
      electricalEnergyMeasurement: {},
      powerSource: {
        batPresent: true,
        status: 1,
        batPercentRemaining: null,
        batChargeLevel: MATTER_OK,
      },
    },
  };
}

export async function applyBatteryUpdate({ log, matter, accessory, chargeW, dischargeW, chargeLevel, critical }) {
  const ctx = accessory.context;

  const activePower = dischargeW > 0 ? wToMw(dischargeW) : chargeW > 0 ? -wToMw(chargeW) : 0;
  const deltaHours = Math.max(0, (Date.now() - ctx.lastTs) / 3_600_000);
  if (dischargeW > 0) ctx.dischargeKwh += (dischargeW * deltaHours) / 1000;
  if (chargeW > 0) ctx.chargeKwh += (chargeW * deltaHours) / 1000;
  ctx.lastTs = Date.now();

  await safeUpdateState({ log, accessory }, () =>
    matter.updateAccessoryState(accessory.UUID, 'electricalPowerMeasurement', { activePower }),
  );

  const energy = {};
  if (ctx.chargeKwh > 0) energy.cumulativeEnergyImported = { energy: kwhToMwh(ctx.chargeKwh) };
  if (ctx.dischargeKwh > 0) energy.cumulativeEnergyExported = { energy: kwhToMwh(ctx.dischargeKwh) };
  if (Object.keys(energy).length > 0) {
    await safeUpdateState({ log, accessory }, () =>
      matter.updateAccessoryState(accessory.UUID, 'electricalEnergyMeasurement', energy),
    );
  }

  if (chargeLevel != null) {
    await safeUpdateState({ log, accessory }, () =>
      matter.updateAccessoryState(accessory.UUID, 'powerSource', {
        batPercentRemaining: percentToMatter(chargeLevel),
        batChargeLevel: chargeLevelToMatter(chargeLevel, critical),
      }),
    );
  }
}

function chargeLevelToMatter(level, critical) {
  if (critical || level <= BATTERY_WARNING_MIN) return MATTER_CRITICAL;
  if (level < BATTERY_OK_MIN) return MATTER_WARNING;
  return MATTER_OK;
}

async function safeUpdateState({ log, accessory }, fn) {
  try {
    await fn();
  } catch (e) {
    const detail = formatError(e);
    if (log?.error) log.error(`SolarEdge: ${accessory.displayName} state update failed: ${detail}`);
    else console.error(`SolarEdge: ${accessory.displayName} state update failed: ${detail}`);
  }
}
