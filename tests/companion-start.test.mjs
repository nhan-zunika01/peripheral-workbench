import { test } from 'node:test';
import assert from 'node:assert/strict';
import { probe, start } from '../scripts/start.mjs';
import { createBridge } from '../bridge/server.mjs';
import { once } from 'node:events';
import * as launcher from '../scripts/bridge.mjs';
import { FakeChild } from './companion-launcher-support.mjs';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const pair = (backend, writes = '0') => async () => ({
  ok: true,
  headers: new Headers({ 'X-Razer-Companion-Backend': backend, 'X-Razer-Companion-Writes': writes }),
  json: async () => ({ token: 'a'.repeat(64) })
});

test('pairing refuses a token from a different requested backend', async () => {
  assert.equal(await probe('http://fixture/api/pair', 'https://mouse.example', pair('legacy'), { backend: 'rust', writes: false }), 'conflict');
});

test('Rust reuse requires the same explicit write mode and a present backend marker', async () => {
  for (const [backend, writes, requested, expected] of [
    ['rust', '0', false, 'ready'], ['rust', '1', true, 'ready'],
    ['rust', '1', false, 'conflict'], ['rust', '0', true, 'conflict'],
    ['rust', '', false, 'conflict'], ['', '0', false, 'conflict']
  ]) assert.equal(await probe('http://fixture/api/pair', 'https://mouse.example', pair(backend, writes), { backend: 'rust', writes: requested }), expected);
});

test('legacy reuse rejects stale or writable listeners and accepts only an explicit read-only marker', async () => {
  for (const [writes, expected] of [[undefined, 'conflict'], ['1', 'conflict'], ['0', 'ready']]) {
    const fetcher = async () => ({ ok: true,
      headers: new Headers({ 'X-Razer-Companion-Backend': 'legacy', ...(writes === undefined ? {} : { 'X-Razer-Companion-Writes': writes }) }),
      json: async () => ({ token: 'a'.repeat(64) })
    });
    assert.equal(await probe('http://fixture/api/pair', 'https://mouse.example', fetcher), expected, `start marker ${writes}`);
    assert.equal(await launcher.probeCompanion({ origin: 'https://mouse.example', backend: 'legacy', writes: false }, fetcher), expected, `bridge marker ${writes}`);
  }
});

for (const caller of ['start', 'bridge']) test(`${caller} refuses production write opt-in before probing or spawning an older Rust companion`, async () => {
  let probes = 0, spawned = 0;
  const options = {
    env: { RAZER_COMPANION_BACKEND: 'rust', RAZER_COMPANION_WRITES: '1', RAZER_COMPANION_EXE: process.execPath },
    runtime: new EventEmitter(),
    fetcher: async url => {
      probes++;
      return url.endsWith('/api/info') ? { ok: true, json: async () => ({ app: 'razer-device-control' }) } : pair('rust', '1')();
    },
    spawnChild() { spawned++; return new FakeChild(); }
  };
  let failure;
  try { await (caller === 'start' ? start(options) : launcher.runBridge(options)); }
  catch (error) { failure = error; }
  assert.equal(probes, 0, 'unsafe configuration must fail before an old listener is contacted');
  assert.equal(spawned, 0);
  assert.match(failure?.message || '', /read-only|unverified/i);
});

test('legacy pairing announces its backend without dispatching device work', async () => {
  const server = createBridge({ origin: 'https://mouse.example', token: 'a'.repeat(64), port: 0, backend: {
    writes: false,
    snapshot() { assert.fail('pair must not enumerate'); }, apply() { assert.fail('pair must not write'); }
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/pair`, { headers: { Origin: 'https://mouse.example' } });
    assert.equal(response.headers.get('X-Razer-Companion-Backend'), 'legacy');
    assert.equal(await probe(`http://127.0.0.1:${server.address().port}/api/pair`, 'https://mouse.example'), 'ready');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('shared selector preserves production read-only and synthetic promoted defaults', () => {
  const resolve = options => launcher.resolveCompanionConfig?.(options);
  const legacy = resolve({ env: { RAZER_TRANSPORT: 'rust', RAZER_RUST_ALLOW_WRITES: '1' } });
  assert.equal(legacy?.backend, 'legacy');
  assert.equal(legacy.writes, false);
  assert.equal(legacy.executable, process.execPath);
  assert.match(legacy.args[0], /bridge[\\/]server\.mjs$/);
  for (const [value, writes, flag] of [[undefined, false, '--read-only'], ['0', false, '--read-only']]) {
    const config = resolve({ env: { RAZER_COMPANION_BACKEND: 'rust', RAZER_COMPANION_EXE: process.execPath, ...(value === undefined ? {} : { RAZER_COMPANION_WRITES: value }) }, args: ['--origin', 'https://mouse.example'] });
    assert.equal(config.backend, 'rust'); assert.equal(config.writes, writes);
    assert.equal(config.executable, process.execPath);
    assert.deepEqual(config.args, ['--origin', 'https://mouse.example', flag, '--managed-shutdown']);
  }
  const promoted = resolve({ env: { RAZER_COMPANION_EXE: process.execPath }, defaults: { backend: 'rust', writes: true } });
  assert.equal(promoted.backend, 'rust'); assert.equal(promoted.writes, true);
  assert.deepEqual(promoted.args, ['--origin', 'http://127.0.0.1:8787', '--allow-writes', '--managed-shutdown']);
  assert.equal(resolve({ env: { RAZER_COMPANION_EXE: process.execPath, RAZER_COMPANION_WRITES: '0' }, defaults: { backend: 'rust', writes: true } }).writes, false);
  assert.equal(resolve({ env: { RAZER_COMPANION_WRITES: '1' } }).writes, false);
});

test('selector rejects invalid configuration before starting any process and never falls back', () => {
  for (const env of [
    { RAZER_COMPANION_BACKEND: 'other' }, { RAZER_COMPANION_WRITES: 'true' },
    { RAZER_COMPANION_BACKEND: 'rust', RAZER_COMPANION_WRITES: '1', RAZER_COMPANION_EXE: process.execPath },
    { RAZER_COMPANION_BACKEND: 'rust', RAZER_COMPANION_EXE: 'relative.exe' },
    { RAZER_COMPANION_BACKEND: 'rust', RAZER_COMPANION_EXE: `${process.execPath}.missing` },
    { RAZER_COMPANION_BACKEND: 'rust', RAZER_COMPANION_EXE: process.execPath, SYNAPSE_INSPECTOR_URL: '' },
    { UI_ORIGIN: 'https://mouse.example/' }, { UI_ORIGIN: 'https://user@mouse.example' }
  ]) assert.throws(() => launcher.resolveCompanionConfig?.({ env }));
  for (const args of [['--origin'], ['--other', 'https://mouse.example'], ['--origin', 'https://mouse.example', '--allow-writes']]) {
    assert.throws(() => launcher.resolveCompanionConfig?.({ env: {}, args }));
  }
  assert.equal(launcher.resolveCompanionConfig?.({ env: { UI_ORIGIN: 'https://old.example' }, args: ['--origin', 'https://new.example'] }).origin, 'https://new.example');
});

test('npm package commands keep both entry points on the shared selector', () => {
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts.start, 'node scripts/start.mjs');
  assert.equal(scripts.bridge, 'node scripts/bridge.mjs');
});

test('launch reuses only an exact match, forwards executable and argv, and refuses a conflicting listener', async () => {
  const config = launcher.resolveCompanionConfig({ env: { RAZER_COMPANION_BACKEND: 'rust', RAZER_COMPANION_EXE: process.execPath }, args: ['--origin', 'https://mouse.example'] });
  let spawned = 0;
  const reused = await launcher.launchCompanion?.(config, { fetcher: pair('rust'), spawnChild() { spawned++; assert.fail('must reuse'); } });
  assert.equal(reused?.reused, true); assert.equal(spawned, 0);
  await reused.stop();
  await assert.rejects(launcher.launchCompanion(config, { fetcher: pair('legacy'), spawnChild() { spawned++; assert.fail('conflict must not launch'); } }), /occupied|conflict/i);
  let attempts = 0; const child = new FakeChild();
  const owned = await launcher.launchCompanion(config, {
    fetcher: async (...args) => { if (++attempts === 1) throw Object.assign(new Error('absent'), { cause: { code: 'ECONNREFUSED' } }); return pair('rust')(...args); },
    spawnChild(executable, args, options) {
      spawned++; assert.equal(executable, process.execPath); assert.deepEqual(args, config.args);
      assert.equal(options.windowsHide, true); assert.deepEqual(options.stdio, ['pipe', 'inherit', 'inherit']);
      assert.equal(options.env, config.env); return child;
    }
  });
  assert.equal(owned.reused, false); assert.equal(owned.child, child); assert.equal(spawned, 1);
  child.exit(); await owned.stop();
});

test('managed stop writes one private frame, waits for exit, then hard-kills only its owned tree after the grace period', async () => {
  const config = launcher.resolveCompanionConfig({ env: { RAZER_COMPANION_BACKEND: 'rust', RAZER_COMPANION_EXE: process.execPath } });
  let attempts = 0; const child = new FakeChild(50002), killed = [];
  const managed = await launcher.launchCompanion?.(config, {
    graceMs: 20, platform: 'win32',
    fetcher: async (...args) => { if (++attempts === 1) throw Object.assign(new Error(), { cause: { code: 'ECONNREFUSED' } }); return pair('rust')(...args); },
    spawnChild(executable, args, options) {
      if (executable !== 'taskkill.exe') return child;
      killed.push(args); assert.equal(options.windowsHide, true);
      const killer = new FakeChild(50003); setImmediate(() => { child.exit(null, 'SIGKILL'); killer.exit(); }); return killer;
    }
  });
  assert.equal(managed?.reused, false);
  let stopped = false; const stopping = managed.stop().then(() => { stopped = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(stopped, false); assert.deepEqual(killed, []); assert.deepEqual(child.frames, ['shutdown\n']);
  await Promise.all([stopping, managed.stop()]);
  assert.deepEqual(killed, [['/PID', '50002', '/T', '/F']]); assert.equal(stopped, true);
});

test('npm bridge command fails missing Rust executable without probing a listener or falling back', () => {
  const result = spawnSync(process.execPath, ['scripts/bridge.mjs', '--origin', 'https://mouse.example'], {
    cwd: new URL('..', import.meta.url), env: { ...process.env, RAZER_COMPANION_BACKEND: 'rust', RAZER_COMPANION_EXE: `${process.execPath}.missing` },
    encoding: 'utf8', timeout: 5000, windowsHide: true
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /executable is missing/); assert.doesNotMatch(result.stdout, /listening/);
});

test('npm start shares Rust selection and leaves reused UI and existing Rust guard alone', async () => {
  const appData = mkdtempSync(join(tmpdir(), 'razer-launcher-'));
  mkdirSync(join(appData, 'RazerDeviceControl')); writeFileSync(join(appData, 'RazerDeviceControl/companion-session.json'), 'existing Rust guard');
  const previous = process.env.LOCALAPPDATA; process.env.LOCALAPPDATA = appData;
  const calls = [], runtime = new EventEmitter(), child = new FakeChild(50004); let pairs = 0, failure;
  try {
    await start({ env: { LOCALAPPDATA: appData, RAZER_COMPANION_BACKEND: 'rust', RAZER_COMPANION_EXE: process.execPath }, runtime,
      fetcher: async (url, options) => {
        if (url.endsWith('/api/info')) return { ok: true, json: async () => ({ app: 'razer-device-control' }) };
        assert.equal(options.headers.Origin, 'http://127.0.0.1:8787');
        if (++pairs === 1) throw Object.assign(new Error(), { cause: { code: 'ECONNREFUSED' } });
        setImmediate(() => child.exit()); return pair('rust')();
      },
      spawnChild(executable, args, options) {
        calls.push({ executable, args, options });
        return executable === process.execPath ? child : new FakeChild(50005);
      }
    }).catch(error => { failure = error; });
    assert.equal(failure, undefined);
    assert.deepEqual(calls.filter(row => row.executable === process.execPath).map(row => row.args), [['--origin', 'http://127.0.0.1:8787', '--read-only', '--managed-shutdown']]);
    assert.equal(calls.some(row => row.executable === 'taskkill.exe'), false);
    assert.equal(runtime.listenerCount('SIGINT'), 0); assert.equal(runtime.listenerCount('SIGTERM'), 0);
  } finally { if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous; rmSync(appData, { recursive: true }); }
});

test('both commands forward the selected legacy, explicit Rust and future promoted defaults through the same launcher', async () => {
  const appData = mkdtempSync(join(tmpdir(), 'razer-command-'));
  try {
    for (const command of ['start', 'bridge']) for (const mode of ['legacy', 'rust', 'promoted', 'promoted-read-only']) {
      const runtime = new EventEmitter(), child = new FakeChild(), calls = []; let pairs = 0;
      const rust = mode !== 'legacy', writes = mode === 'promoted';
      const options = {
        env: { LOCALAPPDATA: appData, RAZER_COMPANION_EXE: process.execPath, ...(mode.startsWith('promoted') ? {} : { RAZER_COMPANION_BACKEND: mode }), ...(mode === 'promoted-read-only' ? { RAZER_COMPANION_WRITES: '0' } : {}) },
        args: ['--origin', 'https://mouse.example'], defaults: mode.startsWith('promoted') ? { backend: 'rust', writes: true } : undefined, runtime,
        fetcher: async (url, request) => {
          if (url.endsWith('/api/info')) return { ok: true, json: async () => ({ app: 'razer-device-control' }) };
          assert.equal(request.headers.Origin, command === 'start' ? 'http://127.0.0.1:8787' : 'https://mouse.example');
          if (++pairs === 1) throw Object.assign(new Error(), { cause: { code: 'ECONNREFUSED' } });
          setImmediate(() => child.exit()); return pair(rust ? 'rust' : 'legacy', writes ? '1' : '0')();
        },
        spawnChild(executable, args, config) {
          calls.push({ executable, args, config });
          const spawned = executable === process.execPath ? child : new FakeChild();
          if (executable === 'taskkill.exe') setImmediate(() => { child.exit(); spawned.exit(); });
          return spawned;
        }
      };
      if (command === 'start') await start(options); else await launcher.runBridge(options);
      const owned = calls.find(row => row.executable === process.execPath);
      const origin = command === 'start' ? 'http://127.0.0.1:8787' : 'https://mouse.example';
      assert.equal(owned.config.windowsHide, true);
      if (rust) assert.deepEqual(owned.args, ['--origin', origin, writes ? '--allow-writes' : '--read-only', '--managed-shutdown']);
      else { assert.match(owned.args[0], /bridge[\\/]server\.mjs$/); assert.deepEqual(owned.args.slice(1), ['--origin', origin]); }
    }
  } finally { rmSync(appData, { recursive: true }); }
});

test('private inherited pipe delivers shutdown and closes on a real fake-launcher crash', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'razer-pipe-'));
  try {
    for (const mode of ['graceful', 'crash', 'hard-crash']) {
      const output = join(dir, `${mode}.json`), owner = spawn(process.execPath, [fileURLToPath(new URL('./support/launcher-pipe-fixture.mjs', import.meta.url)), 'owner', output], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let childPid, timer;
      let stderr = ''; owner.stderr.on('data', bytes => { stderr += bytes; });
      const closed = once(owner, 'close');
      const ready = new Promise((resolve, reject) => {
        let text = '';
        const check = () => { if (childPid && text.includes('FAKE_CHILD_READY')) resolve(); };
        owner.on('message', message => { childPid = message.pid; check(); });
        owner.stdout.on('data', bytes => { text += bytes; check(); }); owner.on('error', reject);
      });
      try {
        await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fake launcher did not become ready')), 5000); })]);
        clearTimeout(timer);
        if (mode === 'hard-crash') owner.kill(); else owner.send(mode === 'graceful' ? 'stop' : 'crash');
        await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('fake pipe child did not exit')), 5000); })]);
        const deadline = Date.now() + 5000;
        while (!existsSync(output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
        assert.ok(existsSync(output), `owned fake child did not record pipe closure: ${stderr}`);
        const result = JSON.parse(readFileSync(output, 'utf8'));
        assert.deepEqual(result, { pid: childPid, input: mode === 'graceful' ? 'shutdown\n' : '', eof: true });
      } finally {
        clearTimeout(timer); owner.kill();
        await closed;
      }
    }
  } finally { rmSync(dir, { recursive: true }); }
});

test('fake pipe child exits within its own deadline when an owner never closes stdin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'razer-pipe-bounded-')), output = join(dir, 'bounded.json');
  const child = spawn(process.execPath, [fileURLToPath(new URL('./support/launcher-pipe-fixture.mjs', import.meta.url)), 'child', output], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, RAZER_FIXTURE_DEADLINE_MS: '100' }
  });
  const closed = once(child, 'close'); let timer;
  try {
    const result = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve('timed-out'), 2000); })]);
    assert.notEqual(result, 'timed-out', 'fake child must stop itself while stdin remains open');
    assert.equal(JSON.parse(readFileSync(output, 'utf8')).bounded, true);
  } finally { clearTimeout(timer); child.kill(); await closed; rmSync(dir, { recursive: true }); }
});

test('failed fake-owner setup closes its owned pipe without numeric PID cleanup', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'razer-pipe-setup-')), output = join(dir, 'setup.json');
  const owner = spawn(process.execPath, [fileURLToPath(new URL('./support/launcher-pipe-fixture.mjs', import.meta.url)), 'owner', output], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, RAZER_FIXTURE_OWNER_FAIL_SETUP: '1' }
  });
  owner.stdout.resume(); owner.stderr.resume();
  const closed = once(owner, 'close'); let timer;
  try {
    const result = await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => resolve('timed-out'), 2000); })]);
    assert.deepEqual(result, [1, null], 'setup failure must exit and close only its owned pipe');
    const deadline = Date.now() + 1000;
    while (!existsSync(output) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    const receipt = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(receipt.input, ''); assert.equal(receipt.eof, true);
  } finally { clearTimeout(timer); owner.kill(); await closed; rmSync(dir, { recursive: true }); }
});
