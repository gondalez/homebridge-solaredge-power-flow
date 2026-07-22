const MIN_MATTER_LEVEL = 0;
const MAX_MATTER_LEVEL = 254;

export function chargeLevelToMatterLevel(chargeLevel) {
  if (chargeLevel == null || !Number.isFinite(chargeLevel)) return 0;
  const clamped = Math.max(0, Math.min(100, chargeLevel));
  return Math.round((clamped / 100) * MAX_MATTER_LEVEL);
}

export function buildBatteryAccessory({ api, siteId, displayName }) {
  return {
    UUID: api.matter.uuid.generate(`solaredge-${siteId}-battery`),
    displayName,
    serialNumber: `SE-${siteId}-BATTERY`,
    manufacturer: 'SolarEdge',
    model: 'Power Flow Battery Level',
    firmwareRevision: '1.0.0',
    context: {
      metric: 'BATTERY',
      direction: 'sensor',
      consecutiveMissingPolls: 0,
    },
    deviceType: api.matter.deviceTypes.DimmableLight,
    clusters: {
      onOff: { onOff: true },
      levelControl: { currentLevel: 0, minLevel: MIN_MATTER_LEVEL, maxLevel: MAX_MATTER_LEVEL },
    },
    handlers: {
      onOff: {
        on: () => logNoop(api, displayName, 'on'),
        off: () => logNoop(api, displayName, 'off'),
        toggle: () => logNoop(api, displayName, 'toggle'),
      },
      levelControl: {
        moveToLevel: (args) => logNoop(api, displayName, `level ${args?.level}`),
        move: (args) => logNoop(api, displayName, `move ${args?.moveMode}`),
        step: (args) => logNoop(api, displayName, `step ${args?.stepMode}`),
        stop: () => logNoop(api, displayName, 'stop'),
        moveToLevelWithOnOff: (args) => logNoop(api, displayName, `level+onoff ${args?.level}`),
      },
    },
  };
}

export async function applyBatteryUpdate({ matter, accessory, chargeLevel }) {
  const currentLevel = chargeLevelToMatterLevel(chargeLevel);
  await matter.updateAccessoryState(accessory.UUID, 'levelControl', { currentLevel });
}

function logNoop(api, displayName, action) {
  api.log.debug?.(`[${displayName}] ignored ${action} (read-only SolarEdge mirror)`);
}
