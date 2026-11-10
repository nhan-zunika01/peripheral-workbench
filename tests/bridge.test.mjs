import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { createBridge, validateValue } from '../bridge/server.mjs';
const origin = 'https://mouse.example';
const deviceId = 'b'.repeat(24);
const token = 'a'.repeat(64);
test('setting validation rejects incorrect types, ranges and unsupported enum values', () => {
  assert.equal(validateValue({ type: 'number', min: 100, max: 35000, integer: true }, 800), 800);
  for (const value of [NaN, 99, 35001, 800.5, '800']) assert.throws(() => validateValue({ type: 'number', min: 100, max: 35000, integer: true }, value));
  assert.throws(() => validateValue({ type: 'number', options: [125, 500, 1000] }, 200));
  const stages = { type: 'array', minItems: 1, maxItems: 5, items: { type: 'object', properties: { x: { type: 'number', integer: true, min: 100, max: 35000 }, y: { type: 'number', integer: true, min: 100, max: 35000 } } } };
  assert.deepEqual(validateValue(stages, [{ x: 800, y: 800 }]), [{ x: 800, y: 800 }]);
  assert.throws(() => validateValue(stages, [{ x: 800, y: 800, z: 800 }]));
  assert.throws(() => validateValue(stages, []));
  assert.throws(() => validateValue(stages, [{ x: 99, y: 800 }]));
});
test('fragmented UTF-8 request bodies preserve profile names', async t => {
  let observed;
  const server = createBridge({ origin, token, backend: {
    snapshot: async () => ({ connected: true, selectedDeviceId: deviceId, settings: [{ id: 'name', type: 'string', writable: true, value: '' }] }),
    apply: async (selected, id, value) => { observed = value; return { verified: true, verification: 'synapse-acknowledgement' }; }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const body = Buffer.from(JSON.stringify({ deviceId, id: 'name', value: 'Chuột' }));
  const split = body.indexOf(Buffer.from('ộ')) + 1;
  const status = await new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, path: '/api/settings', method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.write(body.subarray(0, split)); setImmediate(() => request.end(body.subarray(split)));
  });
  assert.equal(status, 200); assert.equal(observed, 'Chuột');
});
test('loopback API authenticates, validates and never claims unverified writes', async t => {
  let writes = 0;
  let verified = false;
  const backend = {
    snapshot: async () => ({ connected: true, selectedDeviceId: deviceId, settings: [{ id: 'dpi', type: 'number', integer: true, min: 100, max: 35000, writable: true, value: 800 }] }),
    apply: async () => { writes++; return { verified }; }
  };
  const server = createBridge({ origin, token, backend });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const post = value => fetch(`${base}/api/settings`, { method: 'POST', headers, body: JSON.stringify(value) });
  const paired = await fetch(`${base}/api/pair`, { headers: { Origin: origin } });
  assert.equal(paired.status, 200); assert.equal(paired.headers.get('cache-control'), 'no-store'); assert.equal((await paired.json()).token, token);
  assert.equal((await fetch(`${base}/api/pair`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/pair`)).status, 403);
  const wrongHost = await new Promise((resolve, reject) => {
    const request = http.get(`${base}/api/pair`, { headers: { Origin: origin, Host: `evil.example:${server.address().port}` } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject);
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { Origin: origin } })).status, 401);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, id: 'dpi', value: 800 }) })).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/api/state`, { headers: { ...headers, Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { headers: { ...headers, Authorization: `Bearer ${'é'.repeat(64)}` } })).status, 401);
  assert.equal((await fetch(`${base}/api/state`, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } })).status, 204);
  assert.equal((await fetch(`${base}/api/state`, { headers })).status, 200);
  assert.equal((await post({ deviceId, id: 'dpi', value: 800, extra: true })).status, 400);
  assert.equal((await post({ deviceId, id: 'dpi', value: 99 })).status, 400);
  assert.equal((await post({ deviceId, id: 'unknown', value: 800 })).status, 400);
  assert.equal(writes, 0);
  assert.equal((await post({ deviceId, id: 'dpi', value: 800 })).status, 502);
  verified = true;
  const result = await post({ deviceId, id: 'dpi', value: 800 });
  assert.equal(result.status, 200); assert.equal((await result.json()).verified, true);
});
test('tabs share an in-flight device read without conflict or duplicate native access', async t => {
  let release;
  let entered;
  let snapshots = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const server = createBridge({ origin, token, backend: { snapshot: () => { snapshots++; entered(); return pending; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, Authorization: `Bearer ${token}` };
  const first = fetch(`${base}/api/state`, { headers });
  await started;
  const received = once(server, 'request');
  const second = fetch(`${base}/api/state`, { headers });
  await received;
  release({ connected: false, settings: [] });
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(snapshots, 1);
});

test('state reads for another device wait for an explicit Apply to finish', async t => {
  let release, entered, writes = 0, reads = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const server = createBridge({ origin, token, backend: {
    snapshot: async selected => { reads++; return { connected: true, selectedDeviceId: selected, settings: [{ id: 'dpi', type: 'number', writable: true, value: 800 }] }; },
    apply: async () => { writes++; entered(); await pending; return { verified: true }; }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const write = fetch(`${base}/api/settings`, { method: 'POST', headers, body: JSON.stringify({ deviceId, id: 'dpi', value: 900 }) });
  await started;
  const received = once(server, 'request');
  const read = fetch(`${base}/api/state?deviceId=${'c'.repeat(24)}`, { headers });
  await received;
  assert.equal(reads, 1);
  release();
  assert.equal((await write).status, 200); assert.equal((await read).status, 200);
  assert.equal(reads, 3); assert.equal(writes, 1);
});

test('settings route requires matching physical identity and never forwards a replacement', async t => {
  let applied = false; let requested;
  const server = createBridge({ origin, token, backend: {
    snapshot: async selected => { requested = selected; return { selectedDeviceId: 'c'.repeat(24), connected: true, settings: [] }; },
    apply: async () => { applied = true; }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/settings`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId, id: 'dpi', value: 800 }) });
  assert.equal(response.status, 409); assert.equal(requested, deviceId); assert.equal(applied, false);
});
