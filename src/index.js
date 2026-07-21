import { PLUGIN_NAME, PLATFORM_NAME } from './settings.js';
import { SolarEdgePowerFlowPlatform } from './platform.js';

function installFatalGuards(log) {
  let exiting = false;
  const exit = (code) => {
    if (exiting) return;
    exiting = true;
    process.exit(code);
  };
  const report = (label, err) => {
    const detail = err?.stack || (err && JSON.stringify(err)) || String(err);
    try {
      log.error(`SolarEdge: ${label}: ${detail}`);
    } catch {
      console.error(`SolarEdge: ${label}: ${detail}`);
    }
  };
  process.on('uncaughtException', (err) => {
    report('uncaughtException', err);
    exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    report('unhandledRejection', reason);
    exit(1);
  });
}

export default function (api) {
  installFatalGuards(api.log);
  api.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, SolarEdgePowerFlowPlatform);
}
