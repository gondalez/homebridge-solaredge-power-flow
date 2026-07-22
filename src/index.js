import { PLUGIN_NAME } from './settings.js';
import { SolarEdgePowerFlowPlatform } from './platform.js';

export default function (api) {
  api.registerPlatform(PLUGIN_NAME, 'SolarEdgePowerFlow', SolarEdgePowerFlowPlatform);
}
