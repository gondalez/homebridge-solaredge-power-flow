export const ACTIVE_STATUS = 'Active';
export const CHARGING_STATUS = 'Charging';
export const DISCHARGING_STATUS = 'Discharging';
export const IDLE_STATUS = 'Idle';

export const VOLTAGE_MV_DEFAULT = 230_000;

export const ACTIVE = 'Active';
export const INACTIVE = 'Inactive';

const UNIT_TO_WATTS = { W: 1, kW: 1_000, MW: 1_000_000 };
const _warnedUnknownUnits = new Set();

export function normalizeToWatts(value, unit) {
  if (value == null || !Number.isFinite(value)) return 0;
  const scale = UNIT_TO_WATTS[unit] ?? 1;
  return value * scale;
}

export function wToMw(w) {
  if (w == null || !Number.isFinite(w)) return 0;
  return Math.round(w * 1000);
}

export function percentToMatter(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(200, Math.round(pct * 2)));
}

export function matterToPercent(m) {
  if (m == null || !Number.isFinite(m)) return null;
  return Math.max(0, Math.min(100, m / 2));
}

export function resolveGrid(pf, pfUnit = 'W', log = null) {
  const unit = pf?.GRID;
  if (!unit) return absent('GRID');
  const power = normalizeToWatts(unit.currentPower, pfUnit);
  const isImporting = connectionsFrom(pf, 'GRID');
  const result = {
    present: true,
    active: unit.status === ACTIVE_STATUS,
    rawStatus: unit.status || INACTIVE,
    power: isImporting ? power : -power,
  };
  log?.info?.(`[GRID] resolved: ${JSON.stringify(result)}`);
  return result;
}

export function resolveLoad(pf, pfUnit = 'W', log = null) {
  const unit = pf?.LOAD;
  if (!unit) return absent('LOAD');
  const power = normalizeToWatts(unit.currentPower, pfUnit);
  const result = {
    present: true,
    active: unit.status === ACTIVE_STATUS,
    rawStatus: unit.status || INACTIVE,
    power,
  };
  log?.info?.(`[LOAD] resolved: ${JSON.stringify(result)}`);
  return result;
}

export function resolvePV(pf, pfUnit = 'W', log = null) {
  const unit = pf?.PV;
  if (!unit) return absent('PV');
  const power = normalizeToWatts(unit.currentPower, pfUnit);
  const result = {
    present: true,
    active: unit.status === ACTIVE_STATUS,
    rawStatus: unit.status || INACTIVE,
    power,
  };
  log?.info?.(`[PV] resolved: ${JSON.stringify(result)}`);
  return result;
}

export function resolveStorage(pf, pfUnit = 'W', log = null) {
  const unit = pf?.STORAGE;
  if (!unit) {
    const result = {
      ...absent('STORAGE'),
      charge: 0,
      discharge: 0,
      chargeLevel: null,
      critical: false,
    };
    log?.info?.(`[STORAGE] resolved: ${JSON.stringify(result)}`);
    return result;
  }
  const power = normalizeToWatts(unit.currentPower, pfUnit);
  const isCharging = connectionsTo(pf, 'STORAGE');
  const isDischarging = connectionsFrom(pf, 'STORAGE');
  const charge = isCharging ? power : 0;
  const discharge = isDischarging ? power : 0;
  const result = {
    present: true,
    active:
      unit.status === ACTIVE_STATUS ||
      unit.status === CHARGING_STATUS ||
      unit.status === DISCHARGING_STATUS,
    rawStatus: unit.status || IDLE_STATUS,
    charge,
    discharge,
    chargeLevel: Number.isFinite(unit.chargeLevel) ? unit.chargeLevel : null,
    critical: Boolean(unit.critical),
  };
  log?.info?.(`[STORAGE] resolved: ${JSON.stringify(result)}`);
  return result;
}

export function resolveAll(pf, log) {
  const pfUnit = pf?.unit || 'W';
  if (log && !UNIT_TO_WATTS[pfUnit] && !_warnedUnknownUnits.has(pfUnit)) {
    _warnedUnknownUnits.add(pfUnit);
    log.warn?.(`SolarEdge: unknown unit "${pfUnit}" in power-flow response; assuming W`);
  }
  return {
    GRID: resolveGrid(pf, pfUnit, log),
    LOAD: resolveLoad(pf, pfUnit, log),
    PV: resolvePV(pf, pfUnit, log),
    STORAGE: resolveStorage(pf, pfUnit, log),
  };
}

export function buildAccessoryUpdates(resolved) {
  const updates = {};
  for (const metric of ['GRID', 'LOAD', 'PV', 'STORAGE']) {
    const r = resolved[metric];
    if (!r?.present) continue;
    updates[metric] = {
      onOff: r.active,
      powerMW: wToMw(pickSignedWatts(r)),
    };
  }
  return updates;
}

function pickSignedWatts(r) {
  if (r.discharge && r.discharge > 0) return r.discharge;
  if (r.charge && r.charge > 0) return -r.charge;
  return r.power || 0;
}

function absent(_metric) {
  return {
    present: false,
    active: false,
    rawStatus: INACTIVE,
    power: 0,
  };
}

function connectionsFrom(pf, node) {
  return (pf?.connections || []).some((c) => c && c.from === node);
}

function connectionsTo(pf, node) {
  return (pf?.connections || []).some((c) => c && c.to === node);
}
