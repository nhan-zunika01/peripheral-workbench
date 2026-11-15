const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { packet, response } = require('./protocol.cjs');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function inspect(devices, change, hid) {
  const candidates = devices.filter(item => item.interface === 0).sort((a, b) => Number(b.usagePage === 1 && b.usage === 2) - Number(a.usagePage === 1 && a.usage === 2));
  if (!candidates.length) return { connected: false, model: 'Razer Viper V3 Pro SE', message: 'No supported mouse on HID interface 0.', settings: [] };
  let connection;
  let transaction = 0;
  const read = async (command, data = []) => {
    if (connection.exchange) return connection.exchange(command, data);
    transaction = transaction % 31 + 1;
    const sent = packet(command, data, transaction);
    const written = await connection.sendFeatureReport([0, ...sent]);
    if (written !== 91) throw new Error('Incomplete HID feature report');
    await sleep(20);
    return response((await connection.getFeatureReport(0, 91)).slice(1), sent);
  };
  const settings = [], unavailable = [], handlers = new Map();
  let firmware;
  const probeErrors = [];
  for (const device of candidates) {
    try { connection = new hid.HID(device.path); firmware = await read([2, 0, 129]); if (firmware.length < 2) throw new Error('Invalid firmware response'); break; }
    catch (error) { probeErrors.push(error.message); if (connection) await connection.close(); connection = undefined; }
  }
  if (!connection) throw new Error(`No HID interface answered the verified firmware query: ${[...new Set(probeErrors)].join('; ')}`);
  const number = (label, min, max) => ({ type: 'number', label, integer: true, min, max });
  const query = async (id, label, get, decode, schema, set) => {
    try {
      const getValue = () => typeof get === 'function' ? get(read) : read(...get);
      const decodeValue = data => {
        const minimum = { dpi: 5, dpiStages: 3, polling: 1, pollingWired: 2, pollingWireless: 2, battery: 2, sleep: 2, lowPower: 1, rotation: 3, dynamicState: 2, dynamicMode: 2, calibrationState: 3, asymmetricTracking: 4 }[id];
        if (minimum && data.length < minimum) throw new Error('Invalid setting response length');
        return decode(data);
      };
      const value = decodeValue(await getValue());
      settings.push({ id, ...schema, label, value, writable: !!set });
      if (set) handlers.set(id, async value => {
        const command = await set(value, read);
        if (Array.isArray(command)) await read(...command);
        const actual = decodeValue(await getValue());
        if (!isDeepStrictEqual(actual, command?.expected ?? value)) throw new Error('Device readback differs from the requested value');
        return 'hardware-readback';
      });
    }
    catch (error) { unavailable.push(`${label}: ${error.message}`); }
  };
  const be16 = (data, offset) => data[offset] * 256 + data[offset + 1];
  try {
    const bytes16 = value => [value >> 8 & 255, value & 255];
    let stageIds = [];
    settings.push({ id: 'firmware', label: 'Firmware', type: 'string', value: `${firmware[0]}.${firmware[1]}`, writable: false });
    await query('dpi', 'Current DPI', [[7, 4, 133], [0]], data => ({ x: be16(data, 1), y: be16(data, 3) }), { type: 'object', properties: { x: number('X axis', 100, 35000), y: number('Y axis', 100, 35000) } }, value => [[7, 4, 5], [0, ...bytes16(value.x), ...bytes16(value.y), 0, 0]]);
    await query('dpiStages', 'DPI stages', [[80, 4, 134], [0]], data => {
      if (data[2] < 1 || data[2] > 5 || data[1] < 1 || data[1] > data[2] || data.length < 3 + data[2] * 7) throw new Error('Invalid DPI stages response');
      stageIds = Array.from({ length: data[2] }, (_, index) => data[3 + index * 7]);
      return { active: data[1], stages: Array.from({ length: data[2] }, (_, index) => ({ x: be16(data, 4 + index * 7), y: be16(data, 6 + index * 7) })) };
    }, { type: 'object', properties: { active: number('Active stage', 1, 5), stages: { type: 'array', label: 'Stages', minItems: 1, maxItems: 5, items: { type: 'object', properties: { x: number('X axis', 100, 35000), y: number('Y axis', 100, 35000) } } } } }, value => {
      if (value.active > value.stages.length) throw new Error('Active stage exceeds the stage count');
      const data = [0, value.active, value.stages.length, ...value.stages.flatMap((stage, index) => [stageIds[index] ?? stageIds[0] + index, ...bytes16(stage.x), ...bytes16(stage.y), 0, 0])];
      return [[data.length, 4, 6], data];
    });
    const rates = new Map([[64, 125], [16, 500], [8, 1000]]);
    const normalRates = new Map([[8, 125], [2, 500], [1, 1000]]);
    await query('polling', 'Polling rate (Hz)', [[1, 0, 133]], data => { const rate = normalRates.get(data[0]); if (!rate) throw new Error('Unsupported polling response'); return rate; }, { type: 'number', options: [125, 500, 1000] }, value => [[1, 0, 5], [[...normalRates].find(([, rate]) => rate === value)[0]]]);
    for (const [id, label, profile] of [['pollingWired', 'Wired polling rate (Hz)', 0], ['pollingWireless', 'Wireless polling rate (Hz)', 1]]) {
      await query(id, label, [[2, 0, 192], [profile]], data => { const rate = rates.get(data[1]); if (!rate) throw new Error('Unsupported polling response'); return rate; }, { type: 'number', options: [125, 500, 1000] }, value => [[2, 0, 64], [profile, [...rates].find(([, rate]) => rate === value)[0]]]);
    }
    await query('battery', 'Battery (%)', [[2, 7, 128], [0]], data => Math.floor(data[1] / 255 * 100), number('Battery', 0, 100));
    await query('sleep', 'Idle sleep (seconds)', [[2, 7, 131]], data => be16(data, 0), { ...number('Idle sleep', 60, 900), step: 60 }, value => [[2, 7, 3], bytes16(value)]);
    await query('lowPower', 'Low power threshold (%)', [[1, 7, 129]], data => Math.floor(data[0] / 255 * 100), { ...number('Low power threshold', 5, 100), step: 5 }, value => [[1, 7, 1], [Math.ceil(value / 100 * 255)]]);
    await query('rotation', 'Sensor rotation', [[3, 11, 148], [1]], data => ({ enabled: data[1] === 1, angle: data[2] > 127 ? data[2] - 256 : data[2] }), { type: 'object', properties: { enabled: { type: 'boolean', label: 'Enabled' }, angle: number('Angle (degrees)', -44, 44) } }, value => [[3, 11, 20], [1, Number(value.enabled), value.angle & 255]]);
    await query('dynamicState', 'Dynamic sensitivity enabled', [[2, 11, 144], [1]], data => data[1] === 1, { type: 'boolean' }, value => [[2, 11, 16], [1, Number(value)]]);
    await query('dynamicMode', 'Dynamic sensitivity mode', [[2, 11, 145], [1]], data => data[1], { type: 'number', options: [{ value: 0, label: 'Classic' }, { value: 1, label: 'Natural' }, { value: 2, label: 'Jump' }, { value: 3, label: 'Custom (existing curve)' }] }, value => [[2, 11, 17], [1, value]]);
    if (settings.some(setting => setting.id === 'dynamicMode')) {
      const getCurve = async read => {
        const values = [];
        for (let offset = 0; offset < 250; offset += 8) {
          const count = Math.min(8, 250 - offset), data = await read([37, 11, 147], [1, 3, 250, offset, count]);
          if (data[0] !== 1 || data[1] !== 3 || data[2] !== 250 || data[3] !== offset || data[4] !== count || data.length < 5 + count * 4) throw new Error('Invalid custom curve response');
          const buffer = Buffer.from(data.slice(5));
          for (let index = 0; index < count; index++) { const value = buffer.readFloatLE(index * 4); if (!Number.isFinite(value)) throw new Error('Invalid custom curve point'); values.push(value); }
        }
        return values;
      };
      await query('customCurve', 'Custom sensitivity curve (250 points)', getCurve, value => value, { type: 'array', minItems: 250, maxItems: 250, itemLabel: 'Point', description: 'Applies custom mode and enables dynamic sensitivity. Values use firmware Float32 precision.', items: { type: 'number', min: 0.1, max: 3.4028234663852886e38 } }, async (value, read) => {
        const normalized = Array.from(new Float32Array(value));
        if (normalized.some(item => !Number.isFinite(item) || item < 0.1)) throw new Error('Invalid custom curve point');
        await read([2, 11, 16], [1, 1]); await read([2, 11, 17], [1, 3]);
        for (let offset = 0; offset < 250; offset += 8) {
          const count = Math.min(8, 250 - offset), bytes = Buffer.alloc(count * 4);
          for (let index = 0; index < count; index++) bytes.writeFloatLE(normalized[offset + index], index * 4);
          await read([37, 11, 19], [1, 3, 250, offset, count, ...bytes]);
        }
        return { expected: normalized };
      });
    }
    await query('calibrationState', 'Tracking sensor enabled', [[3, 11, 131], [0, 4]], data => data[2] === 1, { type: 'boolean' });
    await query('asymmetricTracking', 'Asymmetric tracking distances', [[10, 11, 133], [0, 4]], data => ({ liftOff: data[2] + 1, landing: data[3] + 1 }), { type: 'object', description: 'Applying these distances enables asymmetric tracking.', properties: { liftOff: number('Lift-off level', 2, 26), landing: number('Landing level', 1, 25) } }, async (value, read) => {
      if (value.landing >= value.liftOff) throw new Error('Landing distance must be below lift-off distance');
      await read([3, 11, 3], [0, 4, 1]);
      await read([4, 11, 11], [0, 4, 4, 0]);
      await read([10, 11, 5], [0, 4, value.liftOff - 1, value.landing - 1]);
    });
    if (settings.some(setting => setting.id === 'calibrationState')) {
      settings.push({ id: 'smartTracking', label: 'Set smart tracking distance', type: 'number', min: 1, max: 3, integer: true, value: null, writable: true, description: 'Enter a level from 1 to 3 to enable smart tracking. The firmware has no independent mode getter; confirmation uses its command acknowledgement.' });
      handlers.set('smartTracking', async value => {
        await read([3, 11, 3], [0, 4, 1]);
        const result = await read([4, 11, 11], [0, 4, 1, value - 1]);
        if (!isDeepStrictEqual(result, [0, 4, 1, value - 1])) throw new Error('Tracking acknowledgement differs from the requested value');
        return 'hardware-acknowledgement';
      });
    }
    if (change) {
      const handler = handlers.get(change.id);
      if (!handler) throw new Error('Native setting unavailable');
      const { validateValue } = await import('./server.mjs');
      validateValue(settings.find(setting => setting.id === change.id), change.value);
      const verification = await handler(change.value);
      return { verified: true, verification };
    }
    return { connected: true, model: 'Razer Viper V3 Pro SE', message: `${settings.length} native settings read. Close Synapse while using this companion to prevent concurrent device access.`, settings, unavailable };
  } finally { await connection.close(); }
}
async function handleRequest(request, hid) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid native request');
  const devices = hid.devices().filter(device => device.vendorId === 0x1532);
  if (request.action === 'enumerate') return { devices };
  if (!['snapshot', 'apply'].includes(request.action)) throw new Error('Unsupported native action');
  if (!/^[a-f0-9]{24}$/.test(request.deviceId)) throw new Error('A stable device identity is required');
  if (!Array.isArray(request.target) || !request.target.length || request.target.some(item => typeof item !== 'string')) throw new Error('An explicit physical device target is required');
  if (request.action === 'apply' && (!request.change || typeof request.change.id !== 'string' || !Object.hasOwn(request.change, 'value'))) throw new Error('Invalid native change');
  const selected = devices.filter(device => request.target.includes(device.path) && [0x00de, 0x00df].includes(device.productId));
  if (!selected.length) throw new Error('Selected device is no longer attached');
  return inspect(selected, request.action === 'apply' ? request.change : undefined, hid);
}
module.exports = { inspect, handleRequest };
if (require.main === module) {
const engineDirectory = path.dirname(process.execPath);
const hid = require(path.join(engineDirectory, 'resources/app.asar/node_modules/node-rz-hid'));
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { text += chunk; if (text.length > 16384) process.exit(1); });
process.stdin.on('end', async () => {
  try {
    const request = JSON.parse(text);
    const result = await handleRequest(request, hid);
    process.stdout.write(`MOUSE_CONTROL_RESULT:${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stdout.write(`MOUSE_CONTROL_RESULT:${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 1;
  }
});
}
