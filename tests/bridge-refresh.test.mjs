import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createBridge } from '../bridge/server.mjs';

test('confirmed write survives mismatched refresh without exposing another physical device', async t => {
  const deviceId = 'a'.repeat(24), other = 'b'.repeat(24), origin = 'https://ui.example', token = 'c'.repeat(64);
  let snapshots = 0, writes = 0;
  const server = createBridge({ origin, token, backend: {
    snapshot: async () => ({ connected: true, selectedDeviceId: ++snapshots === 1 ? deviceId : other, settings: [{ id: 'dpi', type: 'number', writable: true, value: 800 }] }),
    apply: async () => { writes++; return { verified: true, verification: 'hardware-readback' }; }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/settings`, {
    method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, id: 'dpi', value: 1600 })
  });
  const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.verified, true); assert.equal(writes, 1);
  assert.equal(result.state.connected, false); assert.equal(result.state.selectedDeviceId, deviceId);
  assert.deepEqual(result.state.settings, []); assert.match(result.warning, /confirmed/);
});

test('write transaction rejects a value changed after browser preflight and never applies it', async t => {
  const deviceId = 'a'.repeat(24), origin = 'https://ui.example', token = 'c'.repeat(64);
  let value = 800, writes = 0;
  const server = createBridge({ origin, token, backend: {
    snapshot: async () => ({ connected: true, selectedDeviceId: deviceId, settings: [{ id: 'dpi', type: 'number', writable: true, value }] }),
    apply: async () => { writes++; return { verified: true }; }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const preflight = await (await fetch(`${base}/api/state?deviceId=${deviceId}`, { headers })).json();
  assert.equal(preflight.settings[0].value, 800);
  value = 1600;
  const response = await fetch(`${base}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ deviceId, id: 'dpi', value: 3200, expectedValue: preflight.settings[0].value }) });
  const result = await response.json();
  assert.equal(response.status, 409); assert.equal(result.code, 'STATE_CONFLICT'); assert.equal(writes, 0);
  assert.equal(result.actualValue, 1600);
  assert.match(result.error, /changed since review/);
});

test('expectedValue compares objects by value, accepts null baselines, and preserves the old contract', async t => {
  const deviceId = 'a'.repeat(24), origin = 'https://ui.example', token = 'c'.repeat(64);
  let writes = 0;
  const settings = [
    { id: 'dpi', type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, writable: true, value: { x: 800, y: 800 } },
    { id: 'smartTracking', type: 'number', min: 1, max: 3, integer: true, writable: true, value: null }
  ];
  const server = createBridge({ origin, token, backend: {
    snapshot: async () => ({ connected: true, selectedDeviceId: deviceId, settings }),
    apply: async () => { writes++; return { verified: true }; }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const post = change => fetch(`http://127.0.0.1:${server.address().port}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ deviceId, ...change }) });
  assert.equal((await post({ id: 'dpi', value: { x: 1600, y: 1600 }, expectedValue: { y: 800, x: 800 } })).status, 200);
  assert.equal((await post({ id: 'smartTracking', value: 3, expectedValue: null })).status, 200);
  assert.equal((await post({ id: 'dpi', value: { x: 1600, y: 1600 } })).status, 200);
  assert.equal(writes, 3);
  assert.equal((await post({ id: 'dpi', value: { x: 1600, y: 1600 }, expectedValue: { x: 800, y: 800 }, arbitrary: true })).status, 400);
  assert.equal(writes, 3);
});
