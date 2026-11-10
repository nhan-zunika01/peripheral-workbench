import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore, validate, settingTab, sleepScale, parseRoute } from '../public/state.js';
import { setLocale, t } from '../public/i18n.js';
import { resolveModel } from '../public/models.js';
const number = { type: 'number', min: 100, max: 35000, integer: true };
const dpi = { id: 'dpi', type: 'object', properties: { x: number, y: number }, writable: true, value: { x: 1600, y: 1600, vendorField: 'preserve' } };
const polling = { id: 'polling', type: 'number', options: [125, 500, 1000], writable: true, value: 1000 };
const snapshot = (settings = [dpi, polling], id = 'a') => ({ selectedDeviceId: id, connected: true, devices: [{ id, name: 'Mouse' }], settings: structuredClone(settings) });
test('Apply reconciles one setting while retaining other drafts and unknown fields', () => {
  const s = createStore(); s.ingest(snapshot());
  s.edit('dpi', { ...s.entry('dpi').draft, x: 1800 }); s.edit('polling', 500);
  assert.equal(s.canApply('dpi'), true);
  s.ingest(snapshot([{ ...dpi, value: { x: 1800, y: 1600, vendorField: 'preserve' } }, polling]), { applied: 'dpi' });
  assert.equal(s.entry('dpi').dirty, false); assert.equal(s.entry('dpi').draft.vendorField, 'preserve');
  assert.equal(s.entry('polling').draft, 500); assert.equal(s.entry('polling').dirty, true);
  s.select('b'); s.ingest(snapshot([dpi, polling], 'b')); assert.equal(s.entry('polling').draft, 1000);
  assert.throws(() => s.ingest(snapshot([dpi], 'a')), /identity/);
});
test('validation distinguishes null, zero, finite numbers, stage bounds and landing levels', () => {
  assert.ok(validate({ type: 'number' }, null).length); assert.deepEqual(validate({ type: 'number' }, 0), []);
  assert.ok(validate(number, Infinity).length); assert.ok(validate({ ...number, step: 50 }, 1234).length);
  const stages = { id: 'dpiStages', type: 'object', properties: { active: { type: 'number', min: 1, max: 5 }, stages: { type: 'array', minItems: 1, maxItems: 5, items: dpi } } };
  assert.ok(validate(stages, { active: 2, stages: [{ x: 400, y: 400 }] }).length);
  assert.ok(validate({ id: 'asymmetricTracking', type: 'object', properties: {} }, { liftOff: 2, landing: 2 }).length);
  assert.ok(validate({ type: 'json', format: 'curve' }, Array(249).fill(1)).length);
  assert.ok(validate({ type: 'json', format: 'curve' }, [...Array(249).fill(1), NaN]).length);
});

test('profile changes invalidate retained drafts even when values and schemas match', () => {
  const profile = { id: 'session.profile', type: 'string', options: ['A', 'B'], value: 'A', writable: true };
  const reset = { id: 'session.resetProfile', type: 'boolean', value: false, writable: true };
  for (const applied of [undefined, 'session.profile']) {
    const s = createStore(); s.ingest(snapshot([profile, reset, polling]));
    s.edit('session.resetProfile', true); s.edit('polling', 500);
    const changed = snapshot([{ ...profile, value: 'B' }, reset, polling]);
    s.ingest(changed, { applied }); s.ingest(changed);
    for (const id of ['session.resetProfile', 'polling']) {
      assert.equal(s.entry(id).dirty, true); assert.equal(s.entry(id).stale, true); assert.equal(s.canApply(id), false);
    }
    s.ingest(changed, { discard: true }); s.edit('session.resetProfile', true);
    assert.equal(s.canApply('session.resetProfile'), true);
  }
});
test('curve edits preserve other samples; read-only and quantized baselines stay honest', () => {
  const curve = { id: 'customCurve', type: 'array', minItems: 250, maxItems: 250, items: { type: 'number', min: 0.01, max: 200 }, value: Array.from({ length: 250 }, (_, i) => i / 10 + 1), writable: true };
  const s = createStore(); s.ingest(snapshot([curve, { id: 'lowPower', type: 'number', min: 5, max: 100, step: 5, value: 29, writable: true }]));
  const changed = [...s.entry('customCurve').draft]; changed[42] = 3; s.edit('customCurve', changed);
  assert.equal(s.entry('customCurve').draft.filter((v, i) => v !== curve.value[i]).length, 1);
  assert.equal(s.entry('lowPower').draft, 29); assert.deepEqual(s.entry('lowPower').errors, []);
  s.edit('lowPower', 31); assert.equal(s.canApply('lowPower'), false);
  s.ingest(snapshot([{ ...curve, writable: false }]), { discard: true }); s.edit('customCurve', changed); assert.equal(s.canApply('customCurve'), false);
});
test('routes, adapter units and locale do not change wire values', () => {
  assert.equal(sleepScale('sleep'), 60); assert.equal(sleepScale('session.sleep'), 1);
  assert.equal(settingTab('session.dpiStages'), 'performance'); assert.equal(settingTab('vendor.unknown'), 'advanced');
  assert.equal(settingTab('session.mouseMapping'), 'customize'); assert.equal(parseRoute('#unknown'), 'dashboard');
  assert.equal(parseRoute('#device/power'), 'power');
  setLocale('vi'); assert.equal(t('apply'), 'Áp dụng'); setLocale('en'); assert.equal(t('apply'), 'Apply');
});
test('model catalog matches exact model and never assigns the Viper image to another device', () => {
  assert.equal(resolveModel({ name: 'Razer Viper V3 Pro SE' }).id, 'razer-viper-v3-pro-se');
  assert.equal(resolveModel({ name: 'Razer Viper V3 Pro' }), null);
  assert.equal(resolveModel({ name: 'Razer BlackWidow V4' }), null);
});
