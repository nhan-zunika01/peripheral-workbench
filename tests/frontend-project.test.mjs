import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMacroLibrary } from '../public/macros.js';
import { createReviewLedger } from '../public/review.js';
import { createStore } from '../public/state.js';

function storage(initial = null, failWrite = false) {
  let value = initial, blocked = failWrite;
  return {
    getItem() { return value; },
    setItem(_key, next) { if (blocked) throw new Error('storage disabled'); value = next; },
    get value() { return value; }, set blocked(value) { blocked = value; }
  };
}

const deviceSnapshot = (deviceId, value = 800) => ({
  selectedDeviceId: deviceId,
  connected: true,
  devices: [{ id: deviceId, name: 'Mouse' }],
  settings: [{ id: 'dpi', type: 'number', min: 100, max: 35000, integer: true, writable: true, value }]
});

test('macro import/export preserves only validated data and assigns fresh IDs', () => {
  const source = createMacroLibrary(storage()), macro = source.create();
  assert.equal(source.update(macro.id, {
    name: 'Click and wait',
    events: [{ kind: 'key', input: 'A', action: 'down', delayMs: 25 }, { kind: 'delay', delayMs: 100 }]
  }), true);
  const exported = source.export(), document = JSON.parse(exported);
  assert.deepEqual(Object.keys(document.macros[0]).sort(), ['events', 'name']);

  const target = createMacroLibrary(storage()), [imported] = target.import(exported);
  assert.notEqual(imported.id, macro.id);
  assert.deepEqual(imported.events, source.macros[0].events);
  assert.throws(() => target.import(JSON.stringify({ version: 1, macros: [{ name: 'bad', events: [], command: 'run' }] })), /macroFormat/);
});

test('macro library falls back to session data when browser storage fails', () => {
  let writes = 0;
  const unreadable = createMacroLibrary({ getItem() { throw new Error('blocked'); }, setItem() { writes++; } });
  assert.equal(unreadable.persistent, false);
  assert.equal(unreadable.error, 'macroStorageRead');
  assert.ok(unreadable.create());
  assert.equal(unreadable.writable, false);
  assert.equal(unreadable.save(), false);
  assert.equal(writes, 0, 'an unreadable store must never be overwritten');

  const store = storage(null, true), unwritable = createMacroLibrary(store);
  assert.ok(unwritable.create());
  assert.equal(unwritable.persistent, false);
  assert.equal(unwritable.error, 'macroStorageWrite');
  assert.equal(unwritable.writable, true);
  store.blocked = false;
  assert.equal(unwritable.save(), true);
  assert.equal(unwritable.persistent, true);
  assert.equal(unwritable.error, '');
  assert.deepEqual(createMacroLibrary(store).macros, unwritable.macros);
});

test('review operations include physical identity and cancel only matching pending changes', () => {
  const store = createStore(), ledger = createReviewLedger();
  store.ingest(deviceSnapshot('mouse-a')); store.edit('dpi', 1200);
  const first = ledger.stage('mouse-a', store.entry('dpi'));
  store.select('mouse-b'); store.ingest(deviceSnapshot('mouse-b')); store.edit('dpi', 1400);
  const second = ledger.stage('mouse-b', store.entry('dpi'));

  assert.match(first.id, /^mouse-a:dpi:/);
  assert.match(second.id, /^mouse-b:dpi:/);
  ledger.cancelSetting('mouse-a', 'dpi');
  assert.equal(first.status, 'cancelled');
  assert.equal(second.status, 'pending');
});

test('review keeps literal null as the reviewed value after an acknowledged write', () => {
  const store = createStore(), ledger = createReviewLedger(), deviceId = 'mouse-a';
  store.ingest({ ...deviceSnapshot(deviceId), settings: [{ id: 'smartTracking', type: 'number', options: [1, 2, 3], writable: true, value: null }] });
  store.edit('smartTracking', 2);
  const first = ledger.stage(deviceId, store.entry('smartTracking'));
  assert.equal(first.reviewedBefore, null);
  first.status = 'success';
  store.confirmApplied('smartTracking', 2, 'acknowledgement');
  store.edit('smartTracking', 3);
  const second = ledger.stage(deviceId, store.entry('smartTracking'));
  assert.equal(second.before, null);
  assert.equal(second.reviewedBefore, null);
});

test('reconciliation cannot clear uncertainty without a fresh matching schema readback', () => {
  const store = createStore(), deviceId = 'mouse-a';
  store.ingest(deviceSnapshot(deviceId)); store.edit('dpi', 1200);
  const entry = store.entry('dpi'); entry.uncertain = true;
  store.ingest({ selectedDeviceId: deviceId, connected: false, devices: [], settings: [] });
  assert.equal(entry.actualFresh, false);
  assert.equal(store.reconcile('dpi'), false);
  assert.equal(entry.uncertain, true);

  store.ingest({ ...deviceSnapshot(deviceId), settings: [{ ...deviceSnapshot(deviceId).settings[0], max: 30000, value: 900 }] });
  assert.equal(entry.stale, true);
  assert.equal(store.reconcile('dpi'), false);
  assert.equal(entry.uncertain, true);

  store.ingest(deviceSnapshot(deviceId, 900));
  assert.equal(entry.actualFresh, true);
  assert.equal(store.reconcile('dpi'), true);
  assert.equal(entry.uncertain, false);
  assert.equal(entry.baseline, 900);
});
