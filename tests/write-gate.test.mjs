import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import vm from 'node:vm';
import { createBackend, nativeRequest } from '../bridge/backend.mjs';
import { rustRequest } from '../bridge/rust-transport.mjs';
import { groupDevices } from '../bridge/inventory.mjs';
import { adapterDevice, fakeHid } from './companion-adapter-support.mjs';
import { startBridge, closeBridge, request, change } from './companion-wire-support.mjs';

test('direct production apply rejects before native enumeration or PnP collection', async () => {
  let nativeCalls = 0, pnpCalls = 0;
  const backend = createBackend({ inspector: '',
    pnp: async () => { pnpCalls++; return []; },
    native: async () => { nativeCalls++; return { devices: [adapterDevice] }; }
  });
  await assert.rejects(backend.apply(groupDevices([adapterDevice])[0].id, 'dpi', 1600), /read-only/i);
  assert.equal(nativeCalls, 0);
  assert.equal(pnpCalls, 0);
});

test('production backend masks injected writable capabilities and refuses direct and HTTP setters', async () => {
  const calls = [], settings = [{ id: 'dpi', type: 'number', value: 800, writable: true }];
  const id = groupDevices([adapterDevice])[0].id;
  const backend = createBackend({ inspector: '', pnp: async () => [], native: async value => {
    calls.push(value);
    return value.action === 'enumerate' ? { devices: [adapterDevice] } : { connected: true, settings };
  } });
  const state = await backend.snapshot(id);
  assert.equal(state.settings[0].writable, false);
  assert.equal(settings[0].writable, true, 'do not mutate the collector result');
  await assert.rejects(backend.apply(id, 'dpi', 1600), /read-only/i);
  const server = await startBridge(backend);
  try {
    const pair = await request(server, { path: '/api/pair' });
    assert.equal(pair.headers['x-razer-companion-writes'], '0');
    const response = await request(server, { method: 'POST', path: '/api/settings', raw: change('1600').replace('b'.repeat(24), id) });
    assert.equal(response.status, 400);
    assert.equal(calls.filter(value => value.action === 'apply').length, 0);
  } finally { await closeBridge(server); }
});

test('direct transports reject writes despite inherited flags and explicit old opt-ins', async () => {
  const previous = process.env.RAZER_RUST_ALLOW_WRITES;
  const transport = process.env.RAZER_TRANSPORT;
  process.env.RAZER_RUST_ALLOW_WRITES = '1';
  process.env.RAZER_TRANSPORT = 'invalid-test-transport';
  try {
    const value = { action: 'apply', deviceId: 'a'.repeat(24), target: ['fake'], change: { id: 'smartTracking', value: 2 } };
    await assert.rejects(nativeRequest(value), /read-only/i);
    let spawned = 0;
    await assert.rejects(rustRequest(value, { executable: process.execPath, allowWrites: true, spawnHelper() { spawned++; } }), /read-only/i);
    assert.equal(spawned, 0);
  } finally {
    if (previous === undefined) delete process.env.RAZER_RUST_ALLOW_WRITES; else process.env.RAZER_RUST_ALLOW_WRITES = previous;
    if (transport === undefined) delete process.env.RAZER_TRANSPORT; else process.env.RAZER_TRANSPORT = transport;
  }
});

async function nativeEntry(input, hid) {
  const source = readFileSync(new URL('../bridge/native-host.cjs', import.meta.url), 'utf8');
  const module = { exports: {} }, stdin = new EventEmitter(), realRequire = createRequire(import.meta.url);
  stdin.setEncoding = () => {};
  let loaded = 0, complete;
  const output = new Promise(resolve => { complete = resolve; });
  const require = value => {
    if (value.endsWith('node-rz-hid')) { loaded++; return hid; }
    return realRequire(value === './protocol.cjs' ? '../bridge/protocol.cjs' : value);
  };
  require.main = module;
  const runtime = { execPath: process.execPath, stdin, stdout: { write: value => complete(JSON.parse(value.slice('MOUSE_CONTROL_RESULT:'.length))) } };
  vm.runInNewContext(source, { module, require, process: runtime, Buffer, setTimeout, console });
  stdin.emit('data', JSON.stringify(input)); stdin.emit('end');
  const result = await output;
  return { result, loaded, exitCode: runtime.exitCode };
}

test('native executable rejects apply before loading the physical HID addon', async () => {
  const { result, loaded, exitCode } = await nativeEntry({ action: 'apply' });
  assert.match(result.error, /read-only/i);
  assert.equal(loaded, 0);
  assert.equal(exitCode, 1);
});

test('native executable exposes only read-only settings from its fake HID snapshot', async () => {
  const fake = fakeHid();
  const { result, loaded, exitCode } = await nativeEntry({ action: 'snapshot', deviceId: 'a'.repeat(24), target: [adapterDevice.path] }, fake.hid);
  assert.equal(result.connected, true);
  assert.equal(result.settings.length, 16);
  assert.ok(result.settings.every(setting => setting.writable === false));
  assert.equal(loaded, 1);
  assert.equal(exitCode, undefined);
});
