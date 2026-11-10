import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as bridge from '../bridge/server.mjs';
import { start } from '../scripts/start.mjs';
test('legacy startup refuses every existing Rust guard before creating a backend', () => {
  assert.equal(typeof bridge.assertNoRustSession, 'function');
  const root = mkdtempSync(join(tmpdir(), 'razer-legacy-guard-'));
  assert.doesNotThrow(() => bridge.assertNoRustSession(root));
  mkdirSync(join(root, 'RazerDeviceControl'));
  const guard = join(root, 'RazerDeviceControl', 'companion-session.json');
  writeFileSync(guard, 'invalid metadata still blocks legacy');
  assert.throws(() => bridge.assertNoRustSession(root), /read-only recovery/);
  const child = spawnSync(process.execPath, ['bridge/server.mjs'], { cwd: new URL('..', import.meta.url), env: { ...process.env, LOCALAPPDATA: root }, encoding: 'utf8', timeout: 5000, windowsHide: true });
  assert.equal(child.status, 1); assert.match(child.stderr, /read-only recovery/);
  assert.doesNotMatch(child.stdout, /listening/);
});
test('npm start checks the guard before launching or probing either service', async () => {
  const root = mkdtempSync(join(tmpdir(), 'razer-start-guard-')); mkdirSync(join(root, 'RazerDeviceControl'));
  writeFileSync(join(root, 'RazerDeviceControl', 'companion-session.json'), 'guard');
  const previous = process.env.LOCALAPPDATA, fetcher = globalThis.fetch;
  const listeners = new Map(['SIGINT', 'SIGTERM', 'exit'].map(event => [event, new Set(process.listeners(event))]));
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('Offline fixture refuses network before any launch'); }; process.env.LOCALAPPDATA = root;
  try { await assert.rejects(start(), /read-only recovery/); assert.equal(calls, 0); }
  finally {
    globalThis.fetch = fetcher; if (previous === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previous;
    for (const [event, before] of listeners) for (const listener of process.listeners(event)) if (!before.has(listener)) process.removeListener(event, listener);
  }
});
test('legacy startup also refuses an owner claim left before guard replacement', () => {
  const root = mkdtempSync(join(tmpdir(), 'razer-recovery-owner-')); mkdirSync(join(root, 'RazerDeviceControl'));
  writeFileSync(join(root, 'RazerDeviceControl', 'companion-session.recovery-owner.json'), '{');
  assert.throws(() => bridge.assertNoRustSession(root), /read-only recovery/);
});
