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

export function kwhToMwh(kwh) {
  if (kwh == null || !Number.isFinite(kwh)) return 0;
  return Math.round(kwh * 1_000_000);
}

export function percentToMatter(pct) {
  if (pct == null || !Number.isFinite(pct)) return null;
  return Math.max(0, Math.min(200, Math.round(pct * 2)));
}

export function matterToPercent(m) {
  if (m == null || !Number.isFinite(m)) return null;
  return Math.max(0, Math.min(100, m / 2));
}

export function resolveGrid(pf, pfUnit = 'W') {
  const unit = pf?.GRID;
  if (!unit) return absent('GRID');
  const power = normalizeToWatts(unit.currentPower, pfUnit);
  const isImporting = connectionsFrom(pf, 'GRID');
  return {
    present: true,
    active: unit.status === ACTIVE_STATUS,
    rawStatus: unit.status || INACTIVE,
    power: isImporting ? power : -power,
  };
}

export function resolveLoad(pf, pfUnit = 'W') {
  const unit = pf?.LOAD;
  if (!unit) return absent('LOAD');
  const power = normalizeToWatts(unit.currentPower, pfUnit);
  return {
    present: true,
    active: unit.status === ACTIVE_STATUS,
    rawStatus: unit.status || INACTIVE,
    power,
  };
}

export function resolvePV(pf, pfUnit = 'W') {
  const unit = pf?.PV;
  if (!unit) return absent('PV');
  const power = normalizeToWatts(unit.currentPower, pfUnit);
  return {
    present: true,
    active: unit.status === ACTIVE_STATUS,
    rawStatus: unit.status || INACTIVE,
    power,
  };
}

export function resolveStorage(pf, pfUnit = 'W') {
  const unit = pf?.STORAGE;
  if (!unit) {
    return {
      ...absent('STORAGE'),
      charge: 0,
      discharge: 0,
      chargeLevel: null,
      critical: false,
    };
  }
  const power = normalizeToWatts(unit.currentPower, pfUnit);
  const isCharging = connectionsTo(pf, 'STORAGE');
  const isDischarging = connectionsFrom(pf, 'STORAGE');
  const charge = isCharging ? power : 0;
  const discharge = isDischarging ? power : 0;
  return {
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
}

export function resolveAll(pf, log) {
  const pfUnit = pf?.unit || 'W';
  if (log && !UNIT_TO_WATTS[pfUnit] && !_warnedUnknownUnits.has(pfUnit)) {
    _warnedUnknownUnits.add(pfUnit);
    log.warn?.(`SolarEdge: unknown unit "${pfUnit}" in power-flow response; assuming W`);
  }
  return {
    GRID: resolveGrid(pf, pfUnit),
    LOAD: resolveLoad(pf, pfUnit),
    PV: resolvePV(pf, pfUnit),
    STORAGE: resolveStorage(pf, pfUnit),
  };
}

export function buildAccessoryUpdates(resolved, previousTotals, now) {
  const updates = {};
  const totals = {};
  for (const metric of ['GRID', 'LOAD', 'PV', 'STORAGE']) {
    const r = resolved[metric];
    if (!r?.present) continue;
    const prev = previousTotals?.[metric] || { importedKwh: 0, exportedKwh: 0, lastTs: now };
    const deltaHours = Math.max(0, (now - prev.lastTs) / 3_600_000);
    const { importedKwh, exportedKwh } = integrateEnergy(r, deltaHours);
    const newImportedKwh = prev.importedKwh + importedKwh;
    const newExportedKwh = prev.exportedKwh + exportedKwh;
    updates[metric] = {
      onOff: r.active,
      powerW: pickSignedWatts(r),
      importedKwh: newImportedKwh,
      exportedKwh: newExportedKwh,
    };
    totals[metric] = { importedKwh: newImportedKwh, exportedKwh: newExportedKwh, lastTs: now };
  }
  return { updates, totals };
}

function integrateEnergy(r, deltaHours) {
  let importedKwh = 0;
  let exportedKwh = 0;
  const watts = pickSignedWatts(r);
  const absWatts = Math.abs(watts);
  if (absWatts === 0 || deltaHours === 0) return { importedKwh, exportedKwh };
  const deltaKwh = (absWatts * deltaHours) / 1000;
  if (watts > 0) importedKwh = deltaKwh;
  else if (watts < 0) exportedKwh = deltaKwh;
  return { importedKwh, exportedKwh };
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
