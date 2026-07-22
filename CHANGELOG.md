# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Log solaredge API request and response for debugging.

### Changed
- Reverted needless logging and error handling changes.
- Replaced the battery `ElectricalSensor` accessory with a `DimmableLight` so the iOS Home app surfaces the battery state of charge as a fader. Lifetime kWh and active power reporting for the battery are dropped (the per-switch Battery Charge / Battery Discharge switches are unchanged).
- Dropped lifetime kWh / MWh energy tracking from all Matter switches. Live power (W/kW) and on/off state are unchanged. The STORAGE charge and discharge switches are now both always registered when the `STORAGE` key is present; only the active direction is on, the other is off, and the live power is shown as a positive value.

### Fixed
- Power readings being reported 1000× too small when the SolarEdge API returns a `kW` or `MW` unit. The plugin now normalises `currentPower` to watts using the top-level `unit` field before reporting to Matter and before integrating lifetime energy.

## [0.0.3] - 2026-07-21

Fixed Homebridge Platform API: child-bridge no longer crashes at start.

## [0.0.2] - 2026-07-21

Improved error handling and logging.

## [0.0.1] - 2026-07-19

### Added
- Initial release.
