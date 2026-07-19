# @gondalez/homebridge-solaredge-power-flow

A [Homebridge](https://homebridge.io) plugin that exposes your [SolarEdge](https://www.solaredge.com) site power flow as Matter switches and a battery accessory — surfaced in the iOS 27+ Home app energy view.

## What you get

Up to six Matter accessories, depending on what your SolarEdge site reports:

| Accessory | Device type | When shown |
|---|---|---|
| Grid | `OnOffOutlet` | `GRID` key present in the power flow response |
| Load | `OnOffOutlet` | `LOAD` key present |
| PV | `OnOffOutlet` | `PV` key present |
| Battery Charge | `OnOffOutlet` | `STORAGE` key present |
| Battery Discharge | `OnOffOutlet` | `STORAGE` key present |
| Battery (state of charge) | `ElectricalSensor` | `STORAGE.chargeLevel` present |

Each switch is **on when its `status` is `"Active"`** (or `"Charging"` / `"Discharging"` for the battery), **off otherwise**. Power flow direction is inferred from the API's `connections[]` array: importing from the grid is positive watts, exporting is negative; the battery's charge and discharge directions are reported on separate switches.

The battery accessory exposes the current state of charge via the Matter `powerSource` cluster (`batPercentRemaining`) and the lifetime energy in/out via `electricalEnergyMeasurement` (`cumulativeEnergyImported` / `cumulativeEnergyExported`).

## Requirements

- Homebridge **v2.2.0 or later** (the plugin uses the Matter `electricalPowerMeasurement` / `electricalEnergyMeasurement` cluster support added in [homebridge/homebridge@c2d9d7d](https://github.com/homebridge/homebridge/commit/c2d9d7d34dcbfc9323964894117692346ea9f15c))
- Node **22+**
- A SolarEdge API key (admin account → [my.solaredge.com](https://my.solaredge.com) → Admin → API Access)
- A **Matter-enabled bridge** — either the main bridge or a dedicated child bridge

## Installation

Once published:

```bash
npm install -g @gondalez/homebridge-solaredge-power-flow
```

Then add a platform block to your Homebridge `config.json`:

```json
{
  "platforms": [
    {
      "name": "SolarEdge",
      "apiKey": "YOUR_API_KEY",
      "siteId": 12345,
      "platform": "SolarEdgePowerFlow",
      "_bridge": {
        "name": "SolarEdge Power Flow",
        "matter": { "enabled": true }
      }
    }
  ]
}
```

Restart Homebridge. The plugin will poll the SolarEdge API every 15 minutes and create the appropriate accessories.

## Configuration

| Field | Type | Default | Description |
|---|---|---|---|
| `name` | string | `"SolarEdge"` | Platform name shown in Homebridge |
| `apiKey` | string | — | SolarEdge API key (required) |
| `siteId` | integer | — | SolarEdge site ID (required) |
| `refreshIntervalSeconds` | integer | `900` | Poll interval. API limit is 300 calls/day |
| `showBatterySwitches` | boolean | `true` | Show battery charge / discharge switches |
| `showBatteryAccessory` | boolean | `true` | Show battery state-of-charge accessory |
| `accessoryNames.grid` | string | `"SolarEdge Grid"` | Custom display name |
| `accessoryNames.load` | string | `"SolarEdge Load"` | |
| `accessoryNames.pv` | string | `"SolarEdge PV"` | |
| `accessoryNames.batteryCharge` | string | `"SolarEdge Battery Charge"` | |
| `accessoryNames.batteryDischarge` | string | `"SolarEdge Battery Discharge"` | |
| `accessoryNames.battery` | string | `"SolarEdge Battery"` | |
| `_bridge.matter.enabled` | boolean | `true` | Required for the plugin to work |

## Behaviour notes

- **Polling cadence** — 15 minutes by default. The SolarEdge API limit is 300 requests per API key per day, so a 15-minute interval uses 96 of those 300. Configurable down to 30 s, up to 1 h.
- **Authentication failures (401 / 403)** — polling stops, the plugin logs an error, and you'll need to fix the API key and restart Homebridge.
- **Rate limiting (429)** — the plugin honours the `Retry-After` header and immediately fails the request (no retry storm against a rate-limited endpoint).
- **Transient 5xx** — three retries with 1 s / 3 s / 9 s backoff before giving up for that cycle.
- **Missing metric in API response** — the accessory is unregistered after two consecutive polls where its key is absent, so a brief inverter blip doesn't take down an accessory.
- **Lifetime kWh** — accumulated in `accessory.context` and reported via `cumulativeEnergyImported` / `cumulativeEnergyExported` in milliwatt-hours. Totals survive Homebridge restarts.

## Development

```bash
npm install
npm test         # runs all 55 tests (vitest)
npm run lint     # eslint
npm run watch    # not used; the plugin has no build step
```

The project is **pure untyped ESM JavaScript** — no TypeScript, no JSDoc, no `// @ts-check`. Tests use [vitest](https://vitest.dev/) and [MSW](https://mswjs.io/) for the HTTP client layer.

## License

Apache 2.0
