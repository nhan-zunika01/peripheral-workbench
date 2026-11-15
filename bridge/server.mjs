import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createBackend } from './backend.mjs';
import { validateMappings } from './session-catalog.mjs';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

export function assertNoRustSession(localAppData = process.env.LOCALAPPDATA) {
  if (!localAppData) throw new Error('LOCALAPPDATA is required to check the companion recovery guard');
  for (const name of ['companion-session.json', 'companion-session.recovery-owner.json']) {
    try { lstatSync(join(localAppData, 'RazerDeviceControl', name)); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    throw new Error('A Rust companion session guard exists. Complete explicit read-only recovery before starting legacy.');
  }
}

const LIMIT = 16384;
function failure(status, message) { return Object.assign(new Error(message), { status }); }
export function validateValue(schema, value, depth = 0) {
  if (depth > 6 || !schema || !['number', 'boolean', 'string', 'object', 'array', 'json'].includes(schema.type)) throw failure(400, 'Unsupported setting schema');
  if (schema.type === 'json') {
    if (schema.format === 'curve') { if (!Array.isArray(value) || value.length !== 250 || value.some(item => typeof item !== 'number' || !Number.isFinite(item) || item < 0.1 || item > 3.4028234663852886e38)) throw failure(400, 'Custom curves require exactly 250 finite positive Float32 values'); return value; }
    if (schema.format !== 'mapping-list') throw failure(400, 'Unsupported JSON setting'); try { return validateMappings(value); } catch (error) { throw failure(400, error.message); }
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 20)) throw failure(400, 'Incorrect array length');
    for (const item of value) validateValue(schema.items, item, depth + 1);
    return value;
  }
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !schema.properties || Object.keys(value).sort().join(',') !== Object.keys(schema.properties).sort().join(',')) throw failure(400, 'Incorrect setting fields');
    for (const [key, child] of Object.entries(schema.properties)) validateValue(child, value[key], depth + 1);
    return value;
  }
  if (typeof value !== schema.type) throw failure(400, 'Incorrect value type');
  if (schema.type === 'number' && (!Number.isFinite(value) || (schema.integer && !Number.isInteger(value)) || (schema.min !== undefined && value < schema.min) || (schema.max !== undefined && value > schema.max))) throw failure(400, 'Value outside supported range');
  if (schema.type === 'number' && schema.step && Math.abs((value - (schema.min ?? 0)) / schema.step - Math.round((value - (schema.min ?? 0)) / schema.step)) > 1e-8) throw failure(400, 'Value does not match the supported step');
  if (schema.type === 'string' && value.length > 256) throw failure(400, 'Value too long');
  if (schema.options && !schema.options.some(option => (option.value ?? option) === value)) throw failure(400, 'Unsupported value');
  return value;
}
export function createBridge({ origin, token, backend, port = 17321 }) {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol)) throw new Error('UI_ORIGIN must be an exact HTTP(S) origin without a trailing slash');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Pairing token must contain 64 hexadecimal characters');
  let activeWork;
  const reads = new Map();
  async function transaction(action) {
    if (activeWork) throw failure(409, 'A device operation is already in progress');
    const work = Promise.resolve().then(action).finally(() => { activeWork = undefined; });
    activeWork = work;
    let timer;
    try {
      return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(failure(504, 'Device operation timed out. Inspect the companion before retrying.')), 75000); })]);
    } finally { clearTimeout(timer); }
  }
  function snapshot(deviceId) {
    if (!reads.has(deviceId)) {
      const work = (async () => {
        while (activeWork) await activeWork.catch(() => {});
        return transaction(() => backend.snapshot(deviceId));
      })().finally(() => reads.delete(deviceId));
      reads.set(deviceId, work);
    }
    return reads.get(deviceId);
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const reply = (status, value) => { if (!res.writableEnded) { res.writeHead(status); res.end(JSON.stringify(value)); } };
    try {
      const expectedHost = `127.0.0.1:${server.address().port}`;
      if (req.headers.host !== expectedHost || req.headers.origin !== origin) throw failure(403, 'Host or UI origin not allowed');
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') {
        if (!['GET', 'POST'].includes(req.headers['access-control-request-method'])) throw failure(405, 'Method not allowed');
        const requested = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
        if (requested.some(x => !['authorization', 'content-type'].includes(x))) throw failure(403, 'Header not allowed');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        res.writeHead(204); res.end(); return;
      }
      if (req.method === 'GET' && req.url === '/api/pair') {
        res.setHeader('X-Razer-Companion-Backend', 'legacy');
        if (backend.writes === false) res.setHeader('X-Razer-Companion-Writes', '0');
        reply(200, { token }); return;
      }
      const credential = String(req.headers.authorization || '');
      const expected = `Bearer ${token}`;
      if (Buffer.byteLength(credential) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(credential), Buffer.from(expected))) throw failure(401, 'Incorrect pairing token');
      const route = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && route.pathname === '/api/state') {
        const deviceId = route.searchParams.get('deviceId') || undefined;
        if (deviceId && !/^[a-f0-9]{24}$/.test(deviceId)) throw failure(400, 'Invalid device identity');
        reply(200, await snapshot(deviceId)); return;
      }
      if (req.method !== 'POST' || req.url !== '/api/settings') throw failure(404, 'Route not found');
      if (req.headers['content-type'] !== 'application/json') throw failure(415, 'Expected application/json');
      let body = '';
      req.setEncoding('utf8');
      for await (const chunk of req) { body += chunk.toString(); if (Buffer.byteLength(body) > LIMIT) throw failure(413, 'Request too large'); }
      let change;
      try { change = JSON.parse(body); } catch { throw failure(400, 'Invalid JSON'); }
      if (!change || typeof change !== 'object' || Array.isArray(change) || !['deviceId,id,value', 'deviceId,expectedValue,id,value'].includes(Object.keys(change).sort().join(',')) || typeof change.id !== 'string' || !/^[a-f0-9]{24}$/.test(change.deviceId)) throw failure(400, 'Expected deviceId, id, value and optional expectedValue');
      const result = await transaction(async () => {
        const state = await backend.snapshot(change.deviceId);
        if (state.selectedDeviceId !== change.deviceId) throw failure(409, 'Selected device identity changed');
        if (!state.connected) throw failure(503, 'Device is not connected');
        const setting = state.settings.find(item => item.id === change.id);
        if (!setting?.writable) throw failure(400, 'Setting is not writable');
        if (Object.hasOwn(change, 'expectedValue') && !isDeepStrictEqual(setting.value, change.expectedValue)) throw Object.assign(failure(409, 'Device value changed since review. Reload and review it before applying.'), { code: 'STATE_CONFLICT', actualValue: setting.value });
        validateValue(setting, change.value);
        const applied = await backend.apply(change.deviceId, change.id, change.value);
        if (applied?.verified !== true) throw failure(502, 'Native operation could not be verified');
        let refreshed = await backend.snapshot(change.deviceId);
        if (refreshed.selectedDeviceId !== change.deviceId) refreshed = { devices: refreshed.devices || [], selectedDeviceId: change.deviceId, connected: false, settings: [], message: 'The operation was confirmed, but the refreshed device identity changed. Reconnect before making another change.' };
        return { verified: true, verification: applied.verification || 'hardware-readback', state: refreshed, ...(!refreshed.connected ? { warning: 'The operation was confirmed, but refreshing device state failed. Reconnect before making another change.' } : {}) };
      });
      reply(200, result);
    } catch (error) { reply(error.status || 502, { error: error.status ? error.message : 'Native transport failed; reconnect and inspect the companion console.', ...(error.code === 'STATE_CONFLICT' ? { code: error.code, actualValue: error.actualValue } : {}) }); if (!error.status) console.error(error); }
  });
  server.requestTimeout = 80000;
  server.headersTimeout = 10000;
  server.timeout = 85000;
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assertNoRustSession();
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--origin')) throw new Error('Usage: npm run bridge -- --origin https://your-worker.example');
  const origin = args[1] || process.env.UI_ORIGIN || 'http://127.0.0.1:8787';
  const token = randomBytes(32).toString('hex');
  const server = createBridge({ origin, token, backend: createBackend() });
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? 'Port 17321 is already in use. Stop the other companion or reuse it with its configured origin.' : error.message); process.exitCode = 1; });
  server.listen(17321, '127.0.0.1', () => {
    console.log(`Companion listening at http://127.0.0.1:17321 for ${origin}`);
    console.log('The configured interface connects automatically. Keep this companion running.');
  });
}
