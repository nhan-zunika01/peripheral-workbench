import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { groupDevices, windowsInventory } from './inventory.mjs';
import { rustRequest } from './rust-transport.mjs';

// shortcut: uses the verified Synapse 4.0.896 runtime, reverify the addon before supporting another installation.
const engine = 'C:\\Program Files\\Razer\\RazerAppEngine\\app-4.0.896\\RazerAppEngine.exe';
const helper = fileURLToPath(new URL('./native-host.cjs', import.meta.url));
export function nativeRequest(request) {
  const transport = process.env.RAZER_TRANSPORT || 'native';
  if (transport === 'rust') return rustRequest(request);
  if (transport !== 'native') return Promise.reject(new Error('RAZER_TRANSPORT must be native or rust'));
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32' || !existsSync(engine)) { reject(new Error('The verified Synapse 4.0.896 Windows runtime is required')); return; }
    const child = execFile(engine, [helper], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true, timeout: 9000, maxBuffer: 256 * 1024, encoding: 'utf8'
    }, (error, stdout) => {
      const line = stdout.split(/\r?\n/).find(value => value.startsWith('MOUSE_CONTROL_RESULT:'));
      if (!line) { reject(Object.assign(new Error(error?.killed ? 'Native helper timed out; the setting may have changed. Inspect the device before retrying.' : 'Native helper failed; the setting may have changed. Inspect the device before retrying.'), { status: error?.killed ? 504 : 502 })); return; }
      try {
        const result = JSON.parse(line.slice('MOUSE_CONTROL_RESULT:'.length));
        if (result.error || error) reject(Object.assign(new Error(result.error || 'Native helper failed'), { status: 502 })); else resolve(result);
      } catch (parseError) { reject(parseError); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(request));
  });
}
export function createBackend({ native = nativeRequest, pnp = windowsInventory, inspector = process.env.SYNAPSE_INSPECTOR_URL } = {}) {
  async function inventory() {
    const [hidResult, pnpResult] = await Promise.allSettled([native({ action: 'enumerate' }), pnp()]);
    const devices = groupDevices(hidResult.status === 'fulfilled' ? hidResult.value.devices : [], pnpResult.status === 'fulfilled' ? pnpResult.value : []);
    return { devices, warnings: [hidResult, pnpResult].filter(item => item.status === 'rejected').map(item => item.reason.message) };
  }
  async function resolve(deviceId) {
    const result = await inventory();
    const selected = deviceId ? result.devices.find(item => item.id === deviceId) : result.devices[0];
    return { ...result, selected, selectedDeviceId: deviceId || selected?.id || null };
  }
  const publicDevices = devices => devices.map(({ interfaces, endpoints, ...device }) => ({ ...device, interfaceCount: interfaces.length + endpoints.length }));
  return {
    async snapshot(deviceId) {
      const { devices, selected, selectedDeviceId, warnings } = await resolve(deviceId);
      const common = { devices: publicDevices(devices), selectedDeviceId, settings: [], unavailable: warnings };
      if (!selected) return { ...common, connected: false, message: deviceId ? 'Selected device is no longer attached. Reconnect it or choose another device.' : 'No attached Razer devices found.' };
      if (!selected.supported) return { ...common, connected: false, model: selected.name, message: selected.reason };
      if (inspector) return { ...common, connected: false, model: selected.name, message: 'Synapse session controls are disabled: its product page cannot be bound to this selected physical device. Start the companion without SYNAPSE_INSPECTOR_URL for verified native controls.' };
      try {
        return { ...common, ...await native({ action: 'snapshot', deviceId: selected.id, target: selected.interfaces.map(item => item.path) }), devices: common.devices, selectedDeviceId };
      } catch (error) { return { ...common, connected: false, model: selected.name, message: error.message }; }
    },
    async apply(deviceId, id, value) {
      const { selected } = await resolve(deviceId);
      if (!deviceId || !selected) throw Object.assign(new Error('Selected device is no longer attached'), { status: 409 });
      if (!selected.supported || inspector) throw Object.assign(new Error('No verified adapter bound to this physical device'), { status: 400 });
      return native({ action: 'apply', deviceId: selected.id, target: selected.interfaces.map(item => item.path), change: { id, value } });
    }
  };
}
