import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { legacyTestTarget } from './companion-test-target.mjs';
import { basicSetting } from './companion-wire-support.mjs';
import { verifyLauncherModes } from '../scripts/verify-companion-launcher.mjs';

test('launcher runtime harness covers both callers with schema and dispatch assertions using a synthetic HTTP adapter', async () => {
  const target = legacyTestTarget();
  const adapter = {
    server: target.server,
    command(op, data = {}) {
      if (op === 'reset') data = { ...data, backend: { setting: { ...basicSetting, writable: data.fakeMode !== 'read-only' } } };
      return target.command(op, data);
    }
  };
  try {
    assert.deepEqual(await verifyLauncherModes(adapter, process.execPath), [
      { caller: 'start', mode: 'promoted', writable: true, status: 200, applies: 1 },
      { caller: 'start', mode: 'read-only-override', writable: false, status: 400, applies: 0 },
      { caller: 'bridge', mode: 'promoted', writable: true, status: 200, applies: 1 },
      { caller: 'bridge', mode: 'read-only-override', writable: false, status: 400, applies: 0 }
    ]);
  } finally { await target.stop(); }
});

test('explicit Rust launcher runtime harness refuses absent executables without a fallback', () => {
  const result = spawnSync(process.execPath, ['scripts/verify-companion-launcher.mjs', '--candidate-test-server', `${process.execPath}.missing`], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8', timeout: 5000, windowsHide: true
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Candidate test executable.*missing/);
});
