// Test-only orchestration; timer injection is confined to a VM copy of the unchanged server module.
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateMappings } from '../bridge/session-catalog.mjs';
import { createTransport } from '../public/transport.js';
import { createBridge } from '../bridge/server.mjs';
import { startBridge, closeBridge, request, fakeBackend, change, deviceId, origin, token, basicSetting } from './companion-wire-support.mjs';

const gate = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function captureAuth(input) {
  const backend = fakeBackend(input.nullBaseline ? { setting: { ...basicSetting, value: null } } : {});
  const old = await startBridge(backend, { token: 'b'.repeat(64) }), current = await startBridge(backend);
  const rejecting = input.fail ? await startBridge(backend, { token: 'c'.repeat(64) }) : current;
  const requests = [];
  let paired = false;
  const transport = createTransport(async (url, options) => {
    const path = new URL(url).pathname + new URL(url).search;
    const server = path === '/api/pair' ? (paired ? current : old) : rejecting;
    if (path === '/api/pair') paired = true;
    const before = backend.transcript.filter(row => row.action === 'apply').length;
    const readsBefore = backend.transcript.filter(row => row.action === 'snapshot').length;
    const response = await request(server, { path, method: options.method, raw: options.body, headers: options.headers, omit: Object.hasOwn(options.headers, 'Authorization') ? [] : ['Authorization'] });
    const recorded = structuredClone(response);
    if (recorded.body?.token) { recorded.body.token = '<TOKEN>'; recorded.bodyHex = Buffer.from(JSON.stringify(recorded.body)).toString('hex'); }
    requests.push({ path, requestHex: Buffer.from(options.body || '').toString('hex'), response: recorded, dispatches: backend.transcript.filter(row => row.action === 'apply').length - before, snapshots: backend.transcript.filter(row => row.action === 'snapshot').length - readsBefore });
    return { status: response.status, ok: response.status >= 200 && response.status < 300, json: async () => response.body };
  });
  try {
    let result;
    try {
      if (input.read) result = await transport.read(deviceId);
      else result = await transport.apply(deviceId, 'dpi', 1600, ...(input.omitExpected ? [] : [input.nullExpected ? null : 800]));
    } catch (error) { result = { error: error.message, status: error.status, ...(error.code ? { code: error.code, actualValue: error.actualValue } : {}) }; }
    return { requests, result, transcript: backend.transcript };
  } finally { await closeBridge(old); await closeBridge(current); if (input.fail) await closeBridge(rejecting); }
}
async function captureShared(input) {
  const entered = gate(), release = gate(), transcript = [];
  let snapshots = 0;
  const backend = { async snapshot(id) {
    transcript.push({ action: 'snapshot', ...(id ? { deviceId: id } : {}) });
    if (++snapshots === 1) { entered.resolve(); await release.promise; }
    return { connected: true, selectedDeviceId: id || deviceId, settings: [] };
  } };
  const server = await startBridge(backend);
  const firstPath = `/api/state${input.first ? `?deviceId=${input.first}` : ''}`, secondPath = `/api/state${input.second ? `?deviceId=${input.second}` : ''}`;
  try {
    const first = request(server, { path: firstPath }); await entered.promise;
    const received = once(server, 'request'), second = request(server, { path: secondPath }); await received;
    await new Promise(resolve => setImmediate(resolve));
    const snapshotsBeforeRelease = snapshots;
    release.resolve();
    const responses = await Promise.all([first, second]);
    responses.push(await request(server, { path: firstPath }));
    return { responses, snapshotsBeforeRelease, snapshots, transcript };
  } finally { release.resolve(); await closeBridge(server); }
}
export function controlledFactory() {
  const timers = new Map(); let sequence = 0;
  const source = readFileSync(new URL('../bridge/server.mjs', import.meta.url), 'utf8').split('\n').filter(line => !line.startsWith('import ')).join('\n').split('if (process.argv[1]')[0].replaceAll('export function ', 'function ');
  const factory = vm.runInNewContext(`${source}\ncreateBridge`, { http, randomBytes, timingSafeEqual, isDeepStrictEqual, validateMappings, URL, Buffer, console,
    setTimeout(fn, ms) { if (ms !== 75000) throw new Error('Unexpected lease timer duration'); const id = ++sequence; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); }
  });
  return { factory, expire() { const pending = [...timers.values()]; timers.clear(); for (const fn of pending) fn(); } };
}
async function captureLease() {
  const entered = gate(), release = gate(), clock = controlledFactory(), backend = fakeBackend();
  const apply = backend.apply;
  backend.apply = async (...args) => { const result = await apply(...args); entered.resolve(); await release.promise; return result; };
  const server = await startBridge(backend, { factory: clock.factory });
  const post = raw => ({ method: 'POST', path: '/api/settings', raw });
  try {
    const first = request(server, post(change('1600'))); await entered.promise; clock.expire();
    const responses = [await first];
    responses.push(await request(server, post('{')));
    responses.push(await request(server, { ...post('{'), headers: { 'Content-Type': 'text/plain' } }));
    responses.push(await request(server, post(change('99'))));
    responses.push(await request(server, post(change('1800'))));
    const received = once(server, 'request'), reading = request(server); await received;
    const writesBeforeRelease = backend.transcript.filter(row => row.action === 'apply').length;
    const transcriptBeforeRelease = structuredClone(backend.transcript);
    release.resolve(); responses.push(await reading); responses.push(await request(server, post(change('1800'))));
    return { elapsedVirtualMs: 75000, responses, writesBeforeRelease, transcriptBeforeRelease, transcript: backend.transcript };
  } finally { release.resolve(); await closeBridge(server); }
}
export async function captureScenario(input) {
  if (input.kind === 'auth') return captureAuth(input);
  if (input.kind === 'shared') return captureShared(input);
  if (input.kind === 'lease') return captureLease();
  throw new Error(`Unknown contract scenario ${input.kind}`);
}
export const scenarioCases = () => [
  { id: 'auth-apply-renew', input: { kind: 'auth' } }, { id: 'auth-read-renew', input: { kind: 'auth', read: true } },
  { id: 'auth-renew-fails', input: { kind: 'auth', fail: true } },
  { id: 'auth-omitted-expected', input: { kind: 'auth', omitExpected: true } },
  { id: 'auth-null-expected', input: { kind: 'auth', nullExpected: true, nullBaseline: true } },
  { id: 'auth-null-conflict', input: { kind: 'auth', nullBaseline: true } },
  { id: 'shared-explicit', input: { kind: 'shared', first: deviceId, second: deviceId } },
  { id: 'shared-omitted-explicit', input: { kind: 'shared', second: deviceId } },
  { id: 'shared-different', input: { kind: 'shared', first: deviceId, second: 'c'.repeat(24) } },
  { id: 'lease-retained', input: { kind: 'lease' } }
].map(row => row.input.kind === 'auth' ? { ...row, candidatePairHeaders: { 'x-razer-companion-backend': 'rust', 'x-razer-companion-writes': '1' } } : row);
