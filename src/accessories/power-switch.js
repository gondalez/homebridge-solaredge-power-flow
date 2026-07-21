import { kwhToMwh, wToMw, VOLTAGE_MV_DEFAULT } from '../solaredge/power-flow.js';
import { formatError } from '../util/logger.js';

export function buildSwitchAccessory({ api, siteId, metric, displayName, direction, initial }) {
  return {
    UUID: api.matter.uuid.generate(`solaredge-${siteId}-${metric}-${direction}`),
    displayName,
    serialNumber: `SE-${siteId}-${metric}-${direction}`,
    manufacturer: 'SolarEdge',
    model: `Power Flow ${metric}`,
    firmwareRevision: '1.0.0',
    context: {
      metric,
      direction,
      importedKwh: initial?.importedKwh ?? 0,
      exportedKwh: initial?.exportedKwh ?? 0,
      lastTs: initial?.lastTs ?? Date.now(),
      consecutiveMissingPolls: 0,
    },
    deviceType: api.matter.deviceTypes.OnOffOutlet,
    clusters: {
      onOff: { onOff: false },
      electricalPowerMeasurement: {
        activePower: 0,
        voltage: VOLTAGE_MV_DEFAULT,
      },
      electricalEnergyMeasurement: {},
    },
    handlers: {
      onOff: {
        on: () => logNoop(api, displayName, 'on'),
        off: () => logNoop(api, displayName, 'off'),
      },
    },
  };
}

function logNoop(api, displayName, action) {
  api.log.debug?.(`[${displayName}] ignored ${action} (read-only SolarEdge mirror)`);
}

export async function applySwitchUpdate({ accessory, update, matter, log }) {
  const ctx = accessory.context;
  ctx.importedKwh = update.importedKwh;
  ctx.exportedKwh = update.exportedKwh;
  ctx.lastTs = Date.now();

  await safeUpdateState({ log, accessory }, () =>
    matter.updateAccessoryState(accessory.UUID, 'onOff', { onOff: update.onOff }),
  );

  await safeUpdateState({ log, accessory }, () =>
    matter.updateAccessoryState(accessory.UUID, 'electricalPowerMeasurement', {
      activePower: wToMw(Math.abs(update.powerW)),
    }),
  );

  const energyUpdates = {};
  if (update.importedKwh > 0) {
    energyUpdates.cumulativeEnergyImported = { energy: kwhToMwh(update.importedKwh) };
  }
  if (update.exportedKwh > 0) {
    energyUpdates.cumulativeEnergyExported = { energy: kwhToMwh(update.exportedKwh) };
  }
  if (Object.keys(energyUpdates).length > 0) {
    await safeUpdateState({ log, accessory }, () =>
      matter.updateAccessoryState(accessory.UUID, 'electricalEnergyMeasurement', energyUpdates),
    );
  }
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
