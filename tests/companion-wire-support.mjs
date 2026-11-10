// Test-only loopback capture. All backends are synthetic; no native requests are imported.
import http from 'node:http';
import { once } from 'node:events';
import { createBridge } from '../bridge/server.mjs';

export const origin = 'https://mouse.example', token = 'a'.repeat(64), deviceId = 'b'.repeat(24);
export const basicSetting = { id: 'dpi', type: 'number', integer: true, min: 100, max: 35000, writable: true, value: 800 };
export const change = (value = '800', expected = '') => `{"deviceId":"${deviceId}","id":"dpi","value":${value}${expected}}`;
export function scrubPairToken(response, expectedToken) {
  if (response.body?.token !== expectedToken || !/^[a-f0-9]{64}$/.test(response.body.token)) throw Object.assign(new Error('Configured pairing token mismatch before scrub'), { contractViolation: true });
  response.body.token = '<TOKEN>'; response.bodyHex = Buffer.from(JSON.stringify(response.body)).toString('hex');
}
export function fakeBackend(config = {}) {
  let setting = structuredClone(config.setting || basicSetting);
  const transcript = [];
  return { transcript,
    async snapshot(selected) {
      transcript.push({ action: 'snapshot', ...(selected !== undefined ? { deviceId: selected } : {}) });
      return { connected: config.connected ?? true, selectedDeviceId: config.selectedDeviceId || deviceId, settings: [setting] };
    },
    async apply(selected, id, value) {
      transcript.push({ action: 'apply', deviceId: selected, id, value });
      setting = { ...setting, value };
      return { verified: config.verified ?? true, verification: 'hardware-readback' };
    }
  };
}
export async function startBridge(backend, options = {}) {
  const { factory = createBridge, ...rest } = options;
  const server = factory({ origin, token, backend, port: 0, ...rest });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return server;
}
export async function closeBridge(server) {
  const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed;
}
export function request(server, input = {}) {
  const body = input.hex ? Buffer.from(input.hex, 'hex') : Buffer.from(input.raw || '');
  const headers = { Host: `127.0.0.1:${server.address().port}`, Origin: origin, Authorization: `Bearer ${token}`, ...(input.method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...input.headers };
  for (const name of input.omit || []) delete headers[name];
  const pairs = Object.entries(headers).flatMap(([key, value]) => [key, String(value)]);
  for (const pair of input.duplicateHeaders || []) pairs.push(...pair);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: input.path || '/api/state', method: input.method || 'GET', headers: pairs, agent: false }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        try {
          const bytes = Buffer.concat(chunks), responseHeaders = { ...res.headers }; delete responseHeaders.date;
          resolve({ status: res.statusCode, headers: responseHeaders, bodyHex: bytes.toString('hex'), body: bytes.length ? JSON.parse(bytes.toString()) : null });
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('Contract HTTP response timed out')));
    const cuts = [...(input.cuts || []), body.length];
    let offset = 0;
    const send = () => {
      const next = cuts.shift();
      if (next === undefined) { req.end(); return; }
      req.write(body.subarray(offset, next)); offset = next; setImmediate(send);
    };
    if (body.length) send(); else req.end();
  });
}
export async function captureWire(input) {
  const backend = fakeBackend(input.backend), server = await startBridge(backend);
  try {
    const response = await request(server, input);
    if (response.body?.token) { response.body.token = '<TOKEN>'; response.bodyHex = Buffer.from(JSON.stringify(response.body)).toString('hex'); }
    return { requestHex: (input.hex ? Buffer.from(input.hex, 'hex') : Buffer.from(input.raw || '')).toString('hex'), ...response, dispatches: backend.transcript.filter(row => row.action === 'apply').length, transcript: backend.transcript };
  } finally { await closeBridge(server); }
}
export function trustCases() {
  const post = { method: 'POST', path: '/api/settings', raw: change() };
  const exact = change() + ' '.repeat(16384 - Buffer.byteLength(change()));
  const utf8 = `{"deviceId":"${deviceId}","id":"name","value":"Chuột"}`;
  const utf8Bytes = Buffer.from(utf8), split = utf8Bytes.indexOf(Buffer.from('ộ')) + 1;
  const rows = [
    ['pair', { path: '/api/pair', omit: ['Authorization'] }],
    ['pair-read-only', { path: '/api/pair', omit: ['Authorization'], fakeMode: 'read-only' }],
    ['absent-auth', { omit: ['Authorization'] }], ['invalid-auth', { headers: { Authorization: 'Bearer wrong' } }],
    ['absent-origin', { omit: ['Origin'] }], ['invalid-origin', { headers: { Origin: 'https://evil.example' } }],
    ['invalid-host', { headers: { Host: 'evil.example' } }], ['absent-host', { omit: ['Host'] }],
    ['preflight', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, content-type' }, omit: ['Authorization'] }],
    ['preflight-method', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'DELETE' } }],
    ['preflight-header', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'x-secret' } }],
    ['pair-query', { path: '/api/pair?x=1', omit: ['Authorization'] }], ['pair-trailing-slash', { path: '/api/pair/' }],
    ['unknown-route', { path: '/no-such-route' }], ['wrong-method', { method: 'PUT', path: '/api/settings' }],
    ['strict-content-type', { ...post, headers: { 'Content-Type': 'application/json; charset=utf-8' } }],
    ['missing-content-type', { ...post, omit: ['Content-Type'] }], ['limit-16384', { ...post, raw: exact }], ['limit-16385', { ...post, raw: exact + ' ' }],
    ['fragmented-utf8', { ...post, raw: utf8, cuts: [split], backend: { setting: { id: 'name', type: 'string', writable: true, value: '' } } }]
  ].map(([id, input]) => ({ id, input }));
  rows.find(row => row.id === 'absent-host').candidateDifference = { reason: 'Reviewed spec requires application403 before dispatch; Node HTTP parser returns empty400 for missing Host.', status: 403, dispatches: 0, error: 'Host or UI origin not allowed', headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } };
  for (const row of rows.filter(row => row.input.path === '/api/pair')) row.candidateHeaders = { 'x-razer-companion-backend': 'rust', 'x-razer-companion-writes': row.input.fakeMode === 'read-only' ? '0' : '1' };
  return rows;
}
export function valueCases() {
  const post = raw => ({ method: 'POST', path: '/api/settings', raw });
  const numeric = (value, expected) => post(change(value, expected === undefined ? '' : `,"expectedValue":${expected}`));
  const custom = (setting, value, expected) => ({ ...post(`{"deviceId":"${deviceId}","id":"${setting.id}","value":${value}${expected === undefined ? '' : `,"expectedValue":${expected}`}}`), backend: { setting } });
  const number = { id: 'dpi', type: 'number', integer: true, min: 100, max: 35000, writable: true, value: 800 };
  const axes = { id: 'rotation', type: 'object', properties: { enabled: { type: 'boolean' }, angle: { type: 'number', min: -44, max: 44, integer: true } }, writable: true, value: { enabled: false, angle: 0 } };
  const array = { id: 'array', type: 'array', items: { type: 'number' }, minItems: 1, maxItems: 2, writable: true, value: [1, 2] };
  const curve = { id: 'curve', type: 'json', format: 'curve', writable: true, value: [] };
  const rows = [
    ['invalid-json', post('{')], ['null-body', post('null')], ['array-body', post('[]')], ['empty-object', post('{}')],
    ['extra-key', post(change().slice(0, -1) + ',"extra":true}')], ['missing-id', post(`{"deviceId":"${deviceId}","value":800}`)],
    ['invalid-device-id', post(change().replace(deviceId, 'X'.repeat(24)))], ['invalid-query-device-id', { path: '/api/state?deviceId=bad' }],
    ['empty-query-device-id', { path: '/api/state?deviceId=' }], ['query-device-id', { path: `/api/state?deviceId=${deviceId}` }],
    ['settings-query', { ...numeric('800'), path: '/api/settings?x=1' }],
    ['missing-expected', numeric('800')], ['null-expected', numeric('800', 'null')], ['null-actual', { ...numeric('800', '0'), backend: { setting: { ...number, value: null } } }],
    ['null-equal', { ...numeric('800', 'null'), backend: { setting: { ...number, value: null } } }],
    ['signed-zero', custom(axes, '{"enabled":false,"angle":1}', '{"enabled":false,"angle":-0}')],
    ['numeric-spelling', numeric('800', '800.0')],
    ['rounded-large-integer', { ...numeric('800', '9007199254740993'), backend: { setting: { ...number, value: 9007199254740992 } } }],
    ['overflow-expected', numeric('800', '1e400')], ['overflow-value', numeric('1e400')],
    ['object-order', custom(axes, '{"angle":1,"enabled":false}', '{"angle":0,"enabled":false}')],
    ['object-conflict', custom(axes, '{"enabled":false,"angle":1}', '{"enabled":true,"angle":0}')],
    ['array-order', custom(array, '[1,2]', '[2,1]')],
    ['number-min', numeric('100')], ['number-max', numeric('35000')], ['number-below-min', numeric('99')], ['number-above-max', numeric('35001')],
    ['number-fraction', numeric('800.5')], ['number-string', numeric('"800"')], ['number-null', numeric('null')],
    ['number-step', custom({ ...number, min: 60, max: 900, step: 60 }, '61')],
    ['enum-invalid', custom({ ...number, options: [125, 500, 1000] }, '200')],
    ['string-256', custom({ id: 'name', type: 'string', writable: true, value: '' }, JSON.stringify('x'.repeat(256)))],
    ['string-257', custom({ id: 'name', type: 'string', writable: true, value: '' }, JSON.stringify('x'.repeat(257)))],
    ['object-extra-field', custom(axes, '{"enabled":false,"angle":0,"extra":true}')], ['object-missing-field', custom(axes, '{"angle":0}')],
    ['array-empty', custom(array, '[]')], ['array-long', custom(array, '[1,2,3]')], ['array-item-type', custom(array, '["1"]')],
    ['curve-short', custom(curve, JSON.stringify(Array(249).fill(1)))], ['curve-250', custom(curve, JSON.stringify(Array(250).fill(1)))],
    ['curve-zero', custom(curve, JSON.stringify(Array(250).fill(0)))],
    ['read-only', { ...numeric('800'), backend: { setting: { ...number, writable: false } } }],
    ['identity-changed', { ...numeric('800'), backend: { selectedDeviceId: 'c'.repeat(24) } }], ['disconnected', { ...numeric('800'), backend: { connected: false } }],
    ['unverified', { ...numeric('800'), backend: { verified: false } }],
    ['invalid-utf8', { ...custom({ id: 'name', type: 'string', writable: true, value: '' }, '"?"'), raw: undefined, hex: Buffer.from(custom({ id: 'name' }, '"?"').raw).toString('hex').replace('3f', 'ff') }],
    ['duplicate-keys', post(change().replace('"value":800', '"value":100,"value":800'))],
    ['duplicate-authorization', { duplicateHeaders: [['Authorization', 'Bearer invalid']] }],
    ['duplicate-host', { duplicateHeaders: [['Host', 'evil.example']] }],
    ['duplicate-origin', { duplicateHeaders: [['Origin', 'https://evil.example']] }],
    ['duplicate-content-type', { ...numeric('800'), duplicateHeaders: [['Content-Type', 'text/plain']] }]
  ].map(([id, input]) => ({ id, input }));
  for (const row of rows) {
    if (['duplicate-host', 'duplicate-origin'].includes(row.id)) {
      row.candidateDifference = { reason: 'Rust rejects duplicate Host/Origin before CORS, auth or dispatch; preserve actual legacy parser behavior.', status: 400, dispatches: 0, error: 'Duplicate header', headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } };
      continue;
    }
    const reason = { 'overflow-expected': 'Rust rejects nonfinite JSON numbers before dispatch; JavaScript parses Infinity then conflicts.', 'overflow-value': 'Rust rejects nonfinite JSON numbers at parse; legacy rejects schema.', 'invalid-utf8': 'Rust rejects invalid UTF-8; Node replaces invalid bytes before JSON parsing.', 'duplicate-keys': 'Rust rejects duplicate object keys; JavaScript retains the last value.', 'duplicate-authorization': 'Rust rejects duplicate security headers; Node retains the first Authorization.', 'duplicate-content-type': 'Rust rejects duplicate security headers; Node retains the first Content-Type.' }[row.id];
    if (reason) row.candidateDifference = { reason, status: 400, dispatches: 0, error: row.id.includes('authorization') || row.id.includes('content-type') ? 'Duplicate header' : 'Invalid JSON' };
  }
  return rows;
}
