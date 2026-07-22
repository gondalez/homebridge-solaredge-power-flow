import { wToMw, VOLTAGE_MV_DEFAULT } from '../solaredge/power-flow.js';

export function buildSwitchAccessory({ api, siteId, metric, displayName, direction }) {
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
      consecutiveMissingPolls: 0,
    },
    deviceType: api.matter.deviceTypes.OnOffOutlet,
    clusters: {
      onOff: { onOff: false },
      electricalPowerMeasurement: {
        activePower: 0,
        voltage: VOLTAGE_MV_DEFAULT,
      },
    },
    handlers: {
      onOff: {
        on: () => logNoop(api, displayName, 'on'),
        off: () => logNoop(api, displayName, 'off'),
        toggle: () => logNoop(api, displayName, 'toggle'),
      },
    },
  };
}

function logNoop(api, displayName, action) {
  api.log.debug?.(`[${displayName}] ignored ${action} (read-only SolarEdge mirror)`);
}

export async function applySwitchUpdate({ accessory, update, matter }) {
  await matter.updateAccessoryState(accessory.UUID, 'onOff', { onOff: update.onOff });
  await matter.updateAccessoryState(accessory.UUID, 'electricalPowerMeasurement', {
    activePower: wToMw(Math.abs(update.powerW)),
  });
}
