// Explicit fake data for browser regression tests; never imported by production files.
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const number = (min, max, extra = {}) => ({ type: 'number', integer: true, min, max, ...extra });
const axes = { type: 'object', properties: { x: number(100, 35000), y: number(100, 35000) } };
export const deviceA = 'b'.repeat(24), deviceB = 'c'.repeat(24);

const schemaSettings = value => {
  if (!value || typeof value !== 'object' || !Array.isArray(value.settings)) throw new Error('UI_SCHEMA_FIXTURE must contain a settings array');
  return { settings: value.settings, ...(Array.isArray(value.unavailable) ? { unavailable: value.unavailable } : {}) };
};

export function fixture(deviceId = deviceA) {
  const settings = [];
  const add = (id, schema, value, writable = true) => settings.push({ id, ...schema, value, writable });
  add('firmware', { type: 'string' }, '1.0', false);
  add('dpi', axes, { x: 1600, y: 1600 });
  add('dpiStages', { type: 'object', properties: { active: number(1, 5), stages: { type: 'array', minItems: 1, maxItems: 5, items: axes } } }, { active: 3, stages: [400, 800, 1600, 3200, 6400].map(value => ({ x: value, y: value })) });
  for (const id of ['polling', 'pollingWired', 'pollingWireless']) add(id, { type: 'number', options: [125, 500, 1000] }, 1000);
  add('battery', number(0, 100), 35, false);
  add('sleep', number(60, 900, { step: 60 }), 300);
  add('lowPower', number(5, 100, { step: 5 }), 29);
  add('rotation', { type: 'object', properties: { enabled: { type: 'boolean' }, angle: number(-44, 44) } }, { enabled: false, angle: 0 });
  add('dynamicState', { type: 'boolean' }, false);
  add('dynamicMode', { type: 'number', options: [{ value: 0, label: 'Classic' }, { value: 1, label: 'Natural' }, { value: 2, label: 'Jump' }, { value: 3, label: 'Custom (existing curve)' }] }, 0);
  add('customCurve', { type: 'array', minItems: 250, maxItems: 250, items: { type: 'number', min: 0.1, max: 3.4028234663852886e38 } }, Array.from({ length: 250 }, (_, i) => 1 + i / 500));
  add('calibrationState', { type: 'boolean' }, true, false);
  add('asymmetricTracking', { type: 'object', properties: { liftOff: number(2, 26), landing: number(1, 25) } }, { liftOff: 3, landing: 2 });
  add('smartTracking', number(1, 3), null);
  const snapshot = { selectedDeviceId: deviceId, model: 'Razer Viper V3 Pro SE', connected: true, devices: [{ id: deviceA, name: 'Razer Viper V3 Pro SE', supported: true }, { id: deviceB, name: 'Test keyboard (detected only)', supported: false }], settings, unavailable: [], message: 'MOCK companion fixture; not a live hardware reading.' };
  const override = process.env.UI_SCHEMA_FIXTURE;
  if (!override) return snapshot;
  if (!isAbsolute(override)) throw new Error(`UI_SCHEMA_FIXTURE must be an absolute path: ${override}`);
  let payload;
  try { payload = JSON.parse(readFileSync(override, 'utf8')); }
  catch (error) { throw new Error(`Unable to read UI_SCHEMA_FIXTURE ${override}: ${error.message}`, { cause: error }); }
  const injected = schemaSettings(payload);
  return { ...snapshot, settings: structuredClone(injected.settings), ...(injected.unavailable ? { unavailable: structuredClone(injected.unavailable) } : {}) };
}
