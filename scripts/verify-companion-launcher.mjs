// Explicit fake-device verification: Rust HTTP is real; launcher child ownership is synthetic.
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { start } from './start.mjs';
import { runBridge } from './bridge.mjs';
import { startCandidate } from './verify-companion-contract.mjs';
import { FakeChild } from '../tests/companion-launcher-support.mjs';
import { deviceId, token } from '../tests/companion-wire-support.mjs';

export async function verifyLauncherModes(target, executable) {
  const rows = [];
  for (const caller of ['start', 'bridge']) for (const readonly of [false, true]) {
    const origin = caller === 'start' ? 'http://127.0.0.1:8787' : 'https://mouse.example';
    const child = new FakeChild(), runtime = new EventEmitter();
    let reset, action, result, failure, probes = 0;
    const exercise = async () => {
      const base = `http://127.0.0.1:${target.server.address().port}`;
      const headers = { Origin: origin, Authorization: `Bearer ${token}` };
      const snapshot = await fetch(`${base}/api/state`, { headers, signal: AbortSignal.timeout(5000) });
      assert.equal(snapshot.status, 200);
      const state = await snapshot.json();
      const setting = state.settings.find(value => value.id === 'dpi');
      assert.equal(setting.writable, !readonly, `${caller}: selected mode must reach Rust schema`);
      const applied = await fetch(`${base}/api/settings`, {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(5000),
        body: JSON.stringify({ deviceId, id: 'dpi', value: 1600, expectedValue: 800 })
      });
      assert.equal(applied.status, readonly ? 400 : 200);
      const body = await applied.json();
      if (!readonly) { assert.equal(body.verified, true); assert.equal(body.state.settings.find(value => value.id === 'dpi').value, 1600); }
      const applies = (await target.command('observe')).transcript.filter(row => row.action === 'apply').length;
      assert.equal(applies, readonly ? 0 : 1, `${caller}: exactly one dispatch in approved fake mode, none in read-only`);
      result = { caller, mode: readonly ? 'read-only-override' : 'promoted', writable: setting.writable, status: applied.status, applies };
    };
    const options = {
      env: { RAZER_COMPANION_EXE: executable, ...(readonly ? { RAZER_COMPANION_WRITES: '0' } : {}) },
      defaults: { backend: 'rust', writes: true }, args: ['--origin', origin], runtime,
      platform: 'synthetic-ownership', graceMs: 20,
      spawnChild(path, args, configuration) {
        if (path === 'powershell.exe') return new FakeChild();
        assert.equal(path, executable); assert.equal(configuration.windowsHide, true);
        assert.deepEqual(args, ['--origin', origin, readonly ? '--read-only' : '--allow-writes', '--managed-shutdown']);
        // This adapter derives Rust fixture permission exclusively from the selected executable argv.
        const writes = args.includes('--allow-writes') && !args.includes('--read-only');
        reset = target.command('reset', { backend: {}, origin: args[args.indexOf('--origin') + 1], token, fakeMode: writes ? 'approved-write' : 'read-only' });
        return child;
      },
      async fetcher(url, request) {
        if (url.endsWith('/api/info')) return { ok: true, json: async () => ({ app: 'razer-device-control' }) };
        if (++probes === 1) throw Object.assign(new Error('Synthetic unbound launcher port'), { cause: { code: 'ECONNREFUSED' } });
        await reset;
        const port = target.server.address().port; assert.notEqual(port, 17321);
        const response = await fetch(`http://127.0.0.1:${port}/api/pair`, request);
        const json = response.json.bind(response);
        response.json = async () => {
          const body = await json();
          setImmediate(() => {
            action = exercise().catch(error => { failure = error; }).finally(() => child.exit(failure ? 1 : 0));
          });
          return body;
        };
        return response;
      }
    };
    try { if (caller === 'start') await start(options); else await runBridge(options); }
    catch (error) { failure ||= error; }
    if (action) await action;
    if (failure) throw failure;
    assert.ok(result, 'Caller must reach the fake HTTP schema and apply checks');
    rows.push(result);
  }
  return rows;
}

export async function run(executable) {
  if (!isAbsolute(executable || '') || !existsSync(executable) || !statSync(executable).isFile()) throw new Error('Candidate test executable is missing or not an absolute file');
  const target = await startCandidate(executable);
  try {
    const rows = await verifyLauncherModes(target, executable);
    console.log(JSON.stringify({ evidence: 'actual Rust fake HTTP; synthetic launcher child ownership; no hardware', rows }, null, 2));
  } finally { await target.stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 4 || process.argv[2] !== '--candidate-test-server') throw new Error('Usage: --candidate-test-server <absolute Cargo contract-server executable>');
    await run(process.argv[3]);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
