import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const fixtureModule = new URL('./tests/ui-fixture.mjs', root);
const readFixture = async () => import(`${fixtureModule.href}?test=${Date.now()}-${Math.random()}`);

test('fixture defaults remain the synthetic MOCK snapshot when no schema override is set', async () => {
  const previous = process.env.UI_SCHEMA_FIXTURE;
  delete process.env.UI_SCHEMA_FIXTURE;
  try {
    const { fixture, deviceA, deviceB } = await readFixture();
    const snapshot = fixture();
    assert.deepEqual(snapshot.devices.map(device => device.id), [deviceA, deviceB]);
    assert.match(snapshot.message, /MOCK/i);
    assert.equal(snapshot.settings.find(setting => setting.id === 'dpi').value.x, 1600);
  } finally {
    if (previous === undefined) delete process.env.UI_SCHEMA_FIXTURE;
    else process.env.UI_SCHEMA_FIXTURE = previous;
  }
});

test('fixture merges an absolute Rust snapshot settings export without replacing synthetic identity metadata', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-fixture-'));
  const schemaPath = join(dir, 'rust-snapshot.json');
  writeFileSync(schemaPath, JSON.stringify({
    selectedDeviceId: 'rust-id-must-not-leak',
    model: 'Rust model must not leak',
    connected: false,
    settings: [
      { id: 'dpi', type: 'number', min: 100, max: 35000, integer: true, value: 2400, writable: false },
      { id: 'polling', type: 'number', options: [125, 500, 1000], value: 500, writable: true }
    ],
    unavailable: ['Rust getter unavailable']
  }));
  const previous = process.env.UI_SCHEMA_FIXTURE;
  process.env.UI_SCHEMA_FIXTURE = schemaPath;
  try {
    const { fixture, deviceA, deviceB } = await readFixture();
    const snapshot = fixture();
    assert.equal(snapshot.selectedDeviceId, deviceA);
    assert.deepEqual(snapshot.devices.map(device => device.id), [deviceA, deviceB]);
    assert.equal(snapshot.model, 'Razer Viper V3 Pro SE');
    assert.equal(snapshot.connected, true);
    assert.match(snapshot.message, /MOCK/i);
    assert.deepEqual(snapshot.settings, [
      { id: 'dpi', type: 'number', min: 100, max: 35000, integer: true, value: 2400, writable: false },
      { id: 'polling', type: 'number', options: [125, 500, 1000], value: 500, writable: true }
    ]);
    assert.deepEqual(snapshot.unavailable, ['Rust getter unavailable']);
  } finally {
    if (previous === undefined) delete process.env.UI_SCHEMA_FIXTURE;
    else process.env.UI_SCHEMA_FIXTURE = previous;
  }
});

test('fixture rejects a relative schema override', async () => {
  const previous = process.env.UI_SCHEMA_FIXTURE;
  process.env.UI_SCHEMA_FIXTURE = 'tests/fixtures/rust.json';
  try {
    const { fixture } = await readFixture();
    assert.throws(() => fixture(), /UI_SCHEMA_FIXTURE must be an absolute path/);
  } finally {
    if (previous === undefined) delete process.env.UI_SCHEMA_FIXTURE;
    else process.env.UI_SCHEMA_FIXTURE = previous;
  }
});

test('verify-ui refuses to overwrite a candidate output report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-output-'));
  writeFileSync(join(dir, 'browser-report.json'), '{}');
  const result = spawnSync(process.execPath, ['scripts/verify-ui.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, UI_OUTPUT: dir, UI_URL: 'http://127.0.0.1:1' },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /UI_OUTPUT.*browser-report\.json.*already exists/i);
});

test('verify-project-qa honors QA_OUTPUT and refuses to overwrite a candidate report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qa-output-'));
  writeFileSync(join(dir, 'report.json'), '{}');
  const result = spawnSync(process.execPath, ['scripts/verify-project-qa.mjs'], {
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, QA_OUTPUT: dir },
    encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /QA_OUTPUT.*report\.json.*already exists/i);
});

test('candidate UI and QA output refuse interrupted artifacts while empty directories remain usable', () => {
  for (const [script, variable] of [['verify-ui.mjs', 'UI_OUTPUT'], ['verify-project-qa.mjs', 'QA_OUTPUT']]) {
    for (const artifact of ['failure-1.png', 'failure-1.json', undefined]) {
      const dir = mkdtempSync(join(tmpdir(), 'razer-output-reservation-'));
      try {
        if (artifact) writeFileSync(join(dir, artifact), 'preserve this interrupted evidence');
        const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `
          import { chromium } from 'playwright';
          chromium.launch = async () => { throw new Error('TEST_PREFLIGHT_PASSED_WITHOUT_BROWSER'); };
          await import('./scripts/${script}');
        `], { cwd: root, env: { ...process.env, [variable]: dir }, encoding: 'utf8', timeout: 5000, windowsHide: true });
        const message = `${result.stdout}\n${result.stderr}`;
        assert.notEqual(result.status, 0);
        if (artifact) {
          assert.match(message, new RegExp(`${variable}.*${artifact}.*already exists`, 'i'));
          assert.doesNotMatch(message, /TEST_PREFLIGHT_PASSED_WITHOUT_BROWSER/);
          assert.deepEqual(readdirSync(dir), [artifact]);
        } else assert.match(message, /TEST_PREFLIGHT_PASSED_WITHOUT_BROWSER/);
      } finally { rmSync(dir, { recursive: true }); }
    }
  }
});
