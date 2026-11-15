import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupDevices } from '../bridge/inventory.mjs';
import { createBackend } from '../bridge/backend.mjs';
import { probe, waitReady } from '../scripts/start.mjs';

const a = { vendorId: 0x1532, productId: 0xdf, interface: 0, path: String.raw`\\?\hid#vid_1532&pid_00df#unit-a#{guid}`, product: 'Viper' };
const b = { ...a, path: String.raw`\\?\hid#vid_1532&pid_00df#unit-b#{guid}` };
test('container grouping includes HID, USB and audio; preserves distinct physical units', () => {
  const devices = groupDevices([a, b, { vendorId: 1 }], [
    { instanceId: 'HID\\VID_1532&PID_00DF\\UNIT-A', containerId: 'container-a', name: 'Razer mouse' },
    { instanceId: 'USB\\VID_1532&PID_00DF\\UNIT-A', containerId: 'container-a', name: 'Razer USB' },
    { instanceId: 'AUDIO\\UNIT-C', containerId: 'container-c', name: 'Razer headset' }
  ]);
  assert.equal(devices.length, 3);
  assert.equal(devices.find(device => device.containerId === 'container-a').interfaces.length, 1);
  assert.match(devices.find(device => device.containerId === 'container-c').reason, /no verified settings adapter/);
  assert.equal(new Set(devices.map(device => device.id)).size, 3);
});
test('selected device cannot fall back to another identical unit and read-only apply never probes', async () => {
  let attached = [a, b]; const calls = [];
  const backend = createBackend({ inspector: '', pnp: async () => [], native: async request => {
    calls.push(request); return request.action === 'enumerate' ? { devices: attached } : request.action === 'snapshot' ? { connected: true, settings: [] } : { verified: true };
  } });
  const selected = groupDevices([a])[0].id;
  const state = await backend.snapshot(selected);
  assert.deepEqual(calls.at(-1).target, [a.path]);
  attached = [b];
  const missing = await backend.snapshot(selected);
  assert.equal(missing.connected, false); assert.equal(missing.selectedDeviceId, selected);
  const beforeApply = calls.length;
  await assert.rejects(backend.apply(selected, 'dpi', 800), /read-only/);
  assert.equal(calls.length, beforeApply);
  assert.equal(calls.some(call => call.action === 'apply'), false);
});
test('session mode refuses controls without a physical binding and unsupported products never probe', async () => {
  const calls = [];
  const backend = createBackend({ inspector: 'http://127.0.0.1:9334', pnp: async () => [], native: async request => { calls.push(request); return { devices: [a] }; } });
  const state = await backend.snapshot(); assert.equal(state.connected, false); assert.match(state.message, /cannot be bound/); assert.equal(state.settings.length, 0);
  assert.equal(calls.length, 1);
  const unknown = { ...a, productId: 0x1234, product: 'Razer keyboard' };
  const unknownCalls = [];
  const unsupported = createBackend({ inspector: '', pnp: async () => [], native: async request => { unknownCalls.push(request.action); return { devices: [unknown] }; } });
  const detected = await unsupported.snapshot();
  assert.equal(detected.devices.length, 1); assert.equal(detected.settings.length, 0);
  await assert.rejects(unsupported.apply(detected.selectedDeviceId, 'dpi', 800), /read-only/);
  assert.deepEqual(unknownCalls, ['enumerate']);
});
test('launcher checks app identity, exact-origin pairing and failed readiness', async () => {
  assert.equal(await probe('http://local/api/info', null, async () => ({ ok: true, json: async () => ({ app: 'other' }) })), 'conflict');
  assert.equal(await probe('http://local/api/info', null, async () => ({ ok: true, json: async () => ({ app: 'razer-device-control' }) })), 'ready');
  assert.equal(await probe('http://local/api/pair', 'https://ui', async (_, options) => { assert.equal(options.headers.Origin, 'https://ui'); return { ok: true, headers: new Headers({ 'X-Razer-Companion-Backend': 'legacy', 'X-Razer-Companion-Writes': '0' }), json: async () => ({ token: 'a'.repeat(64) }) }; }), 'ready');
  assert.equal(await probe('http://local', null, async () => { throw Object.assign(new Error(), { cause: { code: 'ECONNREFUSED' } }); }), 'absent');
  await assert.rejects(waitReady(async () => 'ready', { exitCode: 1 }), /exited/);
});
