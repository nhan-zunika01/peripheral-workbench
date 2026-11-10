// Test-only HID exchange emulator, driven exclusively through legacy exported adapter functions.
import nativeHost from '../bridge/native-host.cjs';
export const adapterDevice = { vendorId: 0x1532, productId: 0xdf, interface: 0, usagePage: 1, usage: 2, path: 'fake-unit-a', product: 'Razer Viper V3 Pro SE' };
export const adapterIds = ['firmware', 'dpi', 'dpiStages', 'polling', 'pollingWired', 'pollingWireless', 'battery', 'sleep', 'lowPower', 'rotation', 'dynamicState', 'dynamicMode', 'customCurve', 'calibrationState', 'asymmetricTracking', 'smartTracking'];
export function fakeHid(config = {}) {
  const transcript = [], curve = Array(250).fill(1);
  const getters = new Map([
    ['2,0,129', ['firmware', [1, 2]]], ['7,4,133', ['dpi', [0, 3, 32, 3, 32]]],
    ['80,4,134', ['dpiStages', [0, 1, 1, 1, 3, 32, 3, 32, 0, 0]]], ['1,0,133', ['polling', [1]]],
    ['2,7,128', ['battery', [0, 128]]], ['2,7,131', ['sleep', [1, 44]]], ['1,7,129', ['lowPower', [51]]],
    ['3,11,148', ['rotation', [1, 0, 0]]], ['2,11,144', ['dynamicState', [1, 0]]], ['2,11,145', ['dynamicMode', [1, 0]]],
    ['3,11,131', ['calibrationState', [0, 4, 1]]], ['10,11,133', ['asymmetricTracking', [0, 4, 2, 1]]],
    ['2,0,192:0', ['pollingWired', [0, 8]]], ['2,0,192:1', ['pollingWireless', [1, 8]]]
  ]);
  const unavailable = (Array.isArray(config.unavailable) ? config.unavailable : [config.unavailable]).map(id => id === 'smartTracking' ? 'calibrationState' : id);
  const setter = new Map([['7,4,5', '7,4,133'], ['1,0,5', '1,0,133'], ['2,7,3', '2,7,131'], ['1,7,1', '1,7,129'], ['3,11,20', '3,11,148'], ['2,11,16', '2,11,144'], ['2,11,17', '2,11,145'], ['10,11,5', '10,11,133']]);
  const hid = { devices: () => config.devices || [adapterDevice], HID: class {
    constructor(path) { transcript.push({ action: 'open', path }); }
    exchange(command, data = []) {
      transcript.push({ action: 'exchange', command: [...command], data: [...data] });
      const key = command.join(), lookup = key === '2,0,192' ? `${key}:${data[0]}` : key;
      if (key === '37,11,147' || key === '37,11,19') {
        if (unavailable.includes('customCurve')) throw new Error('Unavailable getter');
        const [, , , offset, count] = data;
        if (key === '37,11,19') {
          if (offset === config.failCurveAt) throw new Error('Simulated uncertain chunk');
          const bytes = Buffer.from(data.slice(5));
          for (let index = 0; index < count; index++) curve[offset + index] = bytes.readFloatLE(index * 4);
        }
        const bytes = Buffer.alloc(count * 4);
        for (let index = 0; index < count; index++) bytes.writeFloatLE(curve[offset + index], index * 4);
        return [...data.slice(0, 5), ...bytes];
      }
      if (getters.has(lookup)) {
        const [id, value] = getters.get(lookup);
        if (unavailable.includes(id)) throw new Error('Unavailable getter');
        return config.shortGetter === id ? [] : [...value];
      }
      if (key === '2,0,64') {
        if (!config.dropWrites) getters.set(`2,0,192:${data[0]}`, [data[0] ? 'pollingWireless' : 'pollingWired', [...data]]);
      } else if (command[1] === 4 && command[2] === 6) {
        if (!config.dropWrites) getters.set('80,4,134', ['dpiStages', [...data]]);
      } else if (setter.has(key)) {
        const target = setter.get(key), [id] = getters.get(target);
        if (!config.dropWrites) getters.set(target, [id, [...data]]);
      } else if (!['3,11,3', '4,11,11'].includes(key)) throw new Error(`Unexpected fake command ${key}`);
      return config.badAcknowledgement && key === '4,11,11' ? [] : [...data];
    }
    close() { transcript.push({ action: 'close' }); }
  } };
  return { hid, transcript };
}
export async function captureAdapter(input) {
  const fake = fakeHid(input);
  try {
    const result = await nativeHost.handleRequest({ action: input.change ? 'apply' : 'snapshot', deviceId: 'b'.repeat(24), target: input.target || [adapterDevice.path], ...(input.change ? { change: input.change } : {}) }, fake.hid);
    return { result, transcript: fake.transcript };
  } catch (error) { return { error: error.message, transcript: fake.transcript }; }
}
export function adapterCases() {
  const values = { dpi: { x: 1600, y: 1600 }, dpiStages: { active: 2, stages: [{ x: 400, y: 400 }, { x: 800, y: 800 }] }, polling: 500, pollingWired: 125, pollingWireless: 500, sleep: 600, lowPower: 20, rotation: { enabled: true, angle: -44 }, dynamicState: true, dynamicMode: 3, customCurve: Array(250).fill(Math.PI), asymmetricTracking: { liftOff: 4, landing: 2 }, smartTracking: 3 };
  return [
    { id: 'available', input: {} },
    ...adapterIds.map(id => ({ id: `unavailable-${id}`, input: { unavailable: id } })),
    ...Object.entries(values).map(([id, value]) => ({ id: `apply-${id}`, input: { change: { id, value } } })),
    { id: 'old-14-schema', input: { unavailable: ['pollingWired', 'pollingWireless'] } },
    { id: 'curve-partial-failure', input: { failCurveAt: 16, change: { id: 'customCurve', value: values.customCurve } } },
    { id: 'readback-mismatch', input: { dropWrites: true, change: { id: 'dpi', value: values.dpi } } },
    { id: 'smart-bad-acknowledgement', input: { badAcknowledgement: true, change: { id: 'smartTracking', value: 3 } } },
    { id: 'asymmetric-invalid-relation', input: { change: { id: 'asymmetricTracking', value: { liftOff: 2, landing: 2 } } } },
    { id: 'short-dpi', input: { shortGetter: 'dpi' } },
    { id: 'short-firmware', input: { shortGetter: 'firmware' } },
    { id: 'stale-target', input: { target: ['fake-unit-missing'] } },
    { id: 'unknown-sku', input: { devices: [{ ...adapterDevice, productId: 0x1234 }] } },
    { id: 'wrong-interface', input: { devices: [{ ...adapterDevice, interface: 1 }] } }
  ];
}
