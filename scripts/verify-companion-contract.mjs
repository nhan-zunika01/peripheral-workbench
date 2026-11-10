import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { request, origin, token, scrubPairToken } from '../tests/companion-wire-support.mjs';
import { captureRemoteScenario } from '../tests/companion-remote-support.mjs';

// Private Cargo test-target IPC v1, never a production executable mode:
// exact argv: --serve-contract-fixture. First stdout JSONL: {ready:true,protocol:1,port}.
// Commands: {id,op,...}; ack: {id,ok:true,result}. Only one command outstanding.
// reset{backend,token,origin,fakeMode,hold?} resets fake backend/transcript and gates;
// fakeMode is explicit read-only or approved-write (synthetic devices only); set-token{token};
// observe -> {transcript}; checkpoint{action,count} waits for backend entry;
// barrier{requests} waits for HTTP ingress count; release clears fake operation gates;
// advance{milliseconds} advances isolated lease clock (never sleeps in wall time).
// adapter/inventory{input} -> legacy-shaped observation through production pure modules.
// shutdown acknowledges, drains and exits. Diagnostics go to stderr, stdout only JSONL.
// All HTTP requests/response bytes below travel through the advertised loopback socket.
export async function startCandidate(executable, spawnChild = spawn, { timeoutMs = 5000 } = {}) {
  const child = spawnChild(executable, ['--serve-contract-fixture'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let nextId = 0, pending, readyResolve, readyReject, closedResolve, exited = false, stderr = '', terminalFailure;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const closed = new Promise(resolve => { closedResolve = resolve; });
  const lines = createInterface({ input: child.stdout });
  const fail = error => { terminalFailure = error; readyReject(error); pending?.reject(error); pending = undefined; };
  child.stderr.on('data', bytes => { stderr = (stderr + bytes).slice(-4000); });
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('close', (code, signal) => { exited = true; closedResolve({ code, signal }); fail(new Error(`Candidate test server closed (${code ?? signal}): ${stderr}`)); });
  lines.on('line', line => {
    try {
      const value = JSON.parse(line);
      if (value.ready === true) {
        assert.equal(value.protocol, 1); assert.ok(Number.isInteger(value.port) && value.port > 0 && value.port <= 65535);
        readyResolve(value.port); return;
      }
      assert.ok(pending && value.id === pending.id, 'Unsolicited/mismatched candidate IPC response');
      const current = pending; pending = undefined;
      if (value.ok !== true) current.reject(new Error(value.error || 'Candidate IPC command failed'));
      else current.resolve(value.result);
    } catch (error) { fail(error); }
  });
  const bounded = async (promise, ms, label) => {
    let timer;
    try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  const command = (op, data = {}) => {
    if (terminalFailure) return Promise.reject(terminalFailure);
    if (exited) return Promise.reject(new Error('Candidate test server has exited'));
    if (pending) return Promise.reject(new Error('Concurrent private IPC commands are forbidden'));
    const id = ++nextId;
    const result = new Promise((resolve, reject) => { pending = { id, resolve, reject }; });
    child.stdin.write(JSON.stringify({ id, op, ...data }) + '\n');
    return bounded(result, timeoutMs, `Candidate ${op} acknowledgement timed out`);
  };
  const stop = async () => {
    const deadline = Date.now() + timeoutMs;
    let failure = exited ? new Error('Candidate exited before shutdown acknowledgement') : undefined, status;
    try { if (!exited) await command('shutdown'); }
    catch (error) { failure = new Error(`Candidate shutdown acknowledgement failed: ${error.message}`, { cause: error }); }
    try {
      if (!exited && Date.now() >= deadline) throw new Error('Candidate shutdown timed out');
      status = exited ? await closed : await bounded(closed, deadline - Date.now(), 'Candidate shutdown timed out');
    } catch (error) {
      failure ||= error;
      child.kill();
      try { status = await bounded(closed, timeoutMs, 'Candidate did not close after kill'); }
      catch (cleanupError) { failure.message += `; ${cleanupError.message}`; }
    } finally { lines.close(); }
    if (!failure && status?.code !== 0) failure = new Error(`Candidate shutdown exited with ${status?.code ?? status?.signal}`);
    if (failure) throw failure;
  };
  try {
    const port = await bounded(ready, timeoutMs, 'Candidate test server readiness timed out');
    return { command, server: { address: () => ({ port }) }, stop };
  } catch (error) { try { await stop(); } catch (cleanupError) { error.message += `; cleanup: ${cleanupError.message}`; } throw error; }
}
export function expectedWire(row) {
  const legacy = { ...row.legacy, headers: { ...row.legacy.headers, ...row.candidateHeaders } };
  if (!row.candidateDifference) return legacy;
  const { status, error, dispatches } = row.candidateDifference;
  const body = { error }, bodyHex = Buffer.from(JSON.stringify(body)).toString('hex');
  return { ...legacy, status, body, bodyHex, headers: { ...(row.candidateDifference.headers || legacy.headers) }, dispatches, transcript: [] };
}
export function expectedScenario(row) {
  const expected = structuredClone(row.legacy);
  for (const request of expected.requests || []) if (request.path === '/api/pair') Object.assign(request.response.headers, row.candidatePairHeaders);
  return expected;
}
export function expectedInventory(row) {
  if (row.candidateDifference) {
    assert.ok(row.candidateExpected, `${row.id}: candidate sorted/default-selection expectation is required`);
    return row.candidateExpected;
  }
  const expected = structuredClone(row.legacy);
  // The reviewed byte-sort rule also changes the PnP-only default selection.
  if (row.id === 'pnp-only') {
    expected.groups.reverse();
    const selected = expected.groups[0];
    expected.selectedDeviceId = selected.id;
    for (const state of expected.results) {
      state.devices.reverse(); state.selectedDeviceId = selected.id; state.model = selected.name;
    }
  }
  return expected;
}
export function compareWire(actual, expected, id) {
  assert.equal(actual.status, expected.status, `${id}: HTTP status`);
  assert.deepEqual(actual.body, expected.body, `${id}: HTTP body`);
  validateResponseBytes(actual);
  // HTTP framing is allowed to choose content-length or chunking. Freeze it in the
  // legacy oracle, but compare every application/security header across runtimes.
  const semantic = headers => Object.fromEntries(Object.entries(headers).filter(([name]) => !['connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(name)));
  assert.deepEqual(semantic(actual.headers), semantic(expected.headers), `${id}: headers`);
  assert.equal(actual.requestHex, expected.requestHex, `${id}: request bytes`);
  assert.equal(actual.dispatches, expected.dispatches, `${id}: backend dispatches`);
  assert.deepEqual(actual.transcript, expected.transcript, `${id}: backend transcript`);
}
function validateResponseBytes(response) {
  const raw = Buffer.from(response.bodyHex, 'hex').toString();
  assert.deepEqual(raw ? JSON.parse(raw) : null, response.body, 'Response bytes differ from parsed body');
  for (const match of raw.matchAll(/"(?:\\.|[^"\\])*"|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g)) {
    if (match[1] && Number(match[1]) === 0) assert.equal(match[1], '0', 'Response zero must serialize as 0');
  }
}
export function semanticObservations(value) {
  if (Array.isArray(value)) return value.map(semanticObservations);
  if (!value || typeof value !== 'object') return value;
  const response = ['status', 'body', 'bodyHex', 'headers'].every(key => Object.hasOwn(value, key));
  if (response) validateResponseBytes(value);
  return Object.fromEntries(Object.entries(value).filter(([key]) => !response || key !== 'bodyHex').map(([key, child]) => [key, response && key === 'headers' ? Object.fromEntries(Object.entries(child).filter(([name]) => !['connection', 'content-length', 'transfer-encoding', 'keep-alive'].includes(name))) : semanticObservations(child)]));
}
async function run(executable) {
  if (!isAbsolute(executable || '') || !existsSync(executable) || !statSync(executable).isFile()) throw new Error('A candidate test executable must be an absolute existing file');
  const contract = JSON.parse(readFileSync(new URL('../tests/fixtures/companion-contract.json', import.meta.url)));
  const target = await startCandidate(executable);
  let checked = 0, failure;
  try {
    await target.command('reset', { backend: {}, token, origin, fakeMode: 'read-only' });
    const rotated = 'd'.repeat(64);
    await target.command('set-token', { token: rotated });
    const pair = await request(target.server, { path: '/api/pair', omit: ['Authorization'] });
    assert.equal(pair.status, 200);
    assert.equal(pair.body.token, rotated);
    assert.equal(pair.headers['x-razer-companion-writes'], '0', 'Token renewal must preserve read-only mode');
    const rejected = await request(target.server, { method: 'POST', path: '/api/settings', headers: { Authorization: `Bearer ${rotated}` }, raw: `{"deviceId":"${'b'.repeat(24)}","id":"dpi","value":1600}` });
    assert.equal(rejected.status, 400);
    assert.equal((await target.command('observe')).transcript.filter(row => row.action === 'apply').length, 0);
    for (const row of contract.wire) {
      await target.command('reset', { backend: row.input.backend || {}, token, origin, fakeMode: row.input.fakeMode || 'approved-write' });
      const response = await request(target.server, row.input);
      if (row.input.path === '/api/pair' && response.status === 200) scrubPairToken(response, token);
      const { transcript } = await target.command('observe');
      const actual = { requestHex: (row.input.hex ? Buffer.from(row.input.hex, 'hex') : Buffer.from(row.input.raw || '')).toString('hex'), ...response, dispatches: transcript.filter(row => row.action === 'apply').length, transcript };
      compareWire(actual, expectedWire(row), row.id); checked++;
    }
    for (const row of contract.scenarios) {
      const actual = await captureRemoteScenario(target, row.input);
      assert.deepEqual(semanticObservations(actual), semanticObservations(expectedScenario(row)), row.id); checked++;
    }
    for (const [name, op] of [['adapter-parity', 'adapter'], ['inventory-parity', 'inventory']]) {
      const fixture = JSON.parse(readFileSync(new URL(`../tests/fixtures/${name}.json`, import.meta.url)));
      for (const row of fixture.cases) {
        const actual = await target.command(op, { input: row.input });
        let expected = op === 'inventory' ? expectedInventory(row) : row.legacy;
        if (row.candidateDifference) {
          // Default selection changes the snapshot/native target too. Compare the
          // full candidate observation against the matching frozen selected case.
          expected = row.candidateExpected;
          assert.ok(expected, `${row.id}: candidate sorted/default-selection expectation is required`);
        }
        assert.deepEqual(actual, expected, row.id); checked++;
      }
    }
  } catch (error) { failure = error; }
  finally { try { await target.stop(); } catch (cleanupError) { if (failure) failure.message += `; cleanup: ${cleanupError.message}`; else failure = cleanupError; } }
  if (failure) throw failure;
  console.log(`Verified ${checked} frozen fake-device contract cases against candidate test target.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--candidate-test-server') throw new Error('Usage: --candidate-test-server <absolute candidate test executable>');
    await run(process.argv[3]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
