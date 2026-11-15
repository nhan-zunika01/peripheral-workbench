import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTransport } from '../public/transport.js';
import { createTransport as createHistoricalTransport } from './fixtures/legacy-source/public/transport.js';
import { createStore } from '../public/state.js';

function companion(factory = createTransport) {
  const calls = [], controls = { offline: false, rotate: false, hold: null, writeError: false };
  const transport = factory(async (url, options) => {
    const path = new URL(url).pathname; calls.push({ path, url, options });
    if (controls.offline) throw new TypeError('Offline');
    if (controls.hold) await controls.hold;
    if (controls.rotate && path !== '/api/pair') { controls.rotate = false; return { ok: false, status: 401, json: async () => ({ error: 'Expired' }) }; }
    if (controls.writeError && path === '/api/settings') throw Object.assign(new Error('Timeout'), { name: 'TimeoutError' });
    return { ok: true, status: 200, json: async () => path === '/api/pair' ? { token: 'a'.repeat(64) } : { connected: true, selectedDeviceId: 'b'.repeat(24), settings: [] } };
  });
  return { calls, controls, transport };
}
test('automatic reads pair, renew expired tokens, retain physical identity and never write', async () => {
  const p = companion(); await p.transport.read('b'.repeat(24));
  assert.deepEqual(p.calls.map(c => c.path), ['/api/pair', '/api/state']);
  assert.match(p.calls.at(-1).url, /deviceId=bbbbbbbbbbbbbbbbbbbbbbbb/);
  assert.equal(p.calls.at(-1).options.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
  p.controls.rotate = true; await p.transport.read('b'.repeat(24));
  assert.equal(p.calls.filter(c => c.path === '/api/pair').length, 2);
  assert.equal(p.calls.some(c => c.path === '/api/settings'), false);
  assert.equal(p.calls.at(-1).options.credentials, 'omit');
  assert.equal(p.calls.at(-1).options.targetAddressSpace, 'loopback');
});
test('pending reads and Apply exclude overlapping polls; hidden tabs do not poll', async () => {
  const p = companion(createHistoricalTransport); await p.transport.read('b');
  let release; p.controls.hold = new Promise(resolve => { release = resolve; });
  const pending = p.transport.read('b'); const count = p.calls.length;
  assert.equal(await p.transport.poll('b', false), null); assert.equal(p.calls.length, count);
  release(); await pending; p.controls.hold = null; assert.equal(await p.transport.poll('b', true), null);
  p.controls.hold = new Promise(resolve => { release = resolve; });
  const write = p.transport.apply('b', 'dpi', { x: 1200, y: 1200 }); const writing = p.calls.length;
  assert.equal(await p.transport.poll('b', false), null); assert.equal(p.calls.length, writing);
  release(); await write;
  assert.deepEqual(JSON.parse(p.calls.at(-1).options.body), { deviceId: 'b', id: 'dpi', value: { x: 1200, y: 1200 } });
});
test('network write failure never retries a potentially executed command', async () => {
  const p = companion(createHistoricalTransport); await p.transport.read('b'); p.controls.writeError = true;
  await assert.rejects(p.transport.apply('b', 'dpi', 1600), { name: 'TimeoutError' });
  assert.equal(p.calls.filter(c => c.path === '/api/settings').length, 1); assert.equal(p.transport.busy, false);
});
test('review writes carry the exact expected value, including null, and expose conflicts', async () => {
  const calls = [];
  const transport = createHistoricalTransport(async (url, options) => {
    const path = new URL(url).pathname; calls.push({ path, options });
    return path === '/api/pair'
      ? { ok: true, status: 200, json: async () => ({ token: 'a'.repeat(64) }) }
      : { ok: false, status: 409, json: async () => ({ error: 'Value changed', code: 'STATE_CONFLICT', actualValue: null }) };
  });
  await assert.rejects(transport.apply('b', 'smartTracking', 2, null), error => {
    assert.equal(error.status, 409); assert.equal(error.code, 'STATE_CONFLICT'); assert.equal(error.actualValue, null); return true;
  });
  assert.deepEqual(JSON.parse(calls.at(-1).options.body), { deviceId: 'b', id: 'smartTracking', value: 2, expectedValue: null });
  assert.equal(transport.busy, false);
});
test('disconnect and changed schema retain drafts and lock Apply until reload', () => {
  const s = createStore(); const snapshot = max => ({ selectedDeviceId: 'b', connected: true, devices: [{ id: 'b', name: 'Mouse' }], settings: [{ id: 'dpi', type: 'number', min: 100, max, value: 800, writable: true }] });
  s.ingest(snapshot(35000)); s.edit('dpi', 1200); const entry = s.entry('dpi');
  s.ingest({ selectedDeviceId: 'b', connected: false, settings: [], devices: [] });
  assert.equal(s.entry('dpi'), entry); assert.equal(entry.draft, 1200); assert.equal(s.canApply('dpi'), false);
  s.ingest(snapshot(35000)); assert.equal(s.canApply('dpi'), true);
  s.ingest(snapshot(30000)); assert.equal(entry.draft, 1200); assert.equal(s.canApply('dpi'), false); assert.equal(entry.stale, true);
  s.ingest(snapshot(30000), { discard: true }); assert.equal(s.entry('dpi').draft, 800); assert.equal(s.canApply('dpi'), false);
});
