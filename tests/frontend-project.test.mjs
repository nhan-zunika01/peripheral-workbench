import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMacroLibrary } from '../public/macros.js';
import * as macroModule from '../public/macros.js';
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

  const store = storage(null, true), unwritable = createMacroLibrary(store, { access: 'writer' });
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

test('only an explicitly granted writer can persist, and takeover reloads the current library', () => {
  const shared = storage(), a = createMacroLibrary(shared, { access: 'writer' }), b = createMacroLibrary(shared, { access: 'readonly' });
  const first = a.create();
  assert.equal(b.create(), null);
  assert.equal(b.save(), false);
  assert.equal(b.update(first.id, { name: 'Overwrite' }), false);
  assert.equal(b.remove(first.id), false);
  assert.throws(() => b.import(a.export()), /macroReadOnly/);
  assert.ok(JSON.parse(shared.value).macros.some(m => m.id === first.id));
  assert.equal(b.setAccess('writer'), true);
  assert.equal(b.macros[0].id, first.id);
  b.create();
  assert.equal(JSON.parse(shared.value).macros.length, 2);
});

test('exporting a memory-only draft does not permit silent replacement', () => {
  const shared = storage(), library = createMacroLibrary(shared), draft = library.create();
  assert.equal(shared.value, null);
  assert.equal(library.setAccess('writer'), false);
  assert.equal(library.macros[0].id, draft.id);
  assert.equal(library.error, 'macroExportFirst');
  const backup = library.export();
  assert.match(backup, /New macro/);
  assert.equal(library.setAccess('writer'), false);
  assert.equal(library.macros[0].id, draft.id);
  assert.equal(library.setAccess('writer', { replaceDraft: true }), true);
  assert.equal(library.macros.length, 0);
});

test('public reload cannot discard a protected draft', () => {
  const library = createMacroLibrary(storage()), draft = library.create();
  assert.equal(library.reload(true), false);
  assert.equal(library.macros[0].id, draft.id);
});

test('Web Locks serialize writers, reload on takeover, and release on pagehide', async () => {
  assert.equal(typeof macroModule.createMacroWriter, 'function');
  let owner = false;
  const locks = { async request(name, options, callback) {
    assert.equal(name, 'device-control-macros-v1');
    assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
    if (owner) return callback(null);
    owner = true;
    try { return await callback({ name }); } finally { owner = false; }
  } };
  const shared = storage(), a = createMacroLibrary(shared), b = createMacroLibrary(shared);
  const targetA = new EventTarget(), targetB = new EventTarget();
  const writerA = macroModule.createMacroWriter(a, { locks, target: targetA });
  const writerB = macroModule.createMacroWriter(b, { locks, target: targetB });
  assert.equal(await writerA.acquire(), true);
  const first = a.create();
  assert.equal(await writerB.acquire(), false);
  assert.equal(b.editable, false); assert.equal(b.create(), null);
  targetB.dispatchEvent(Object.assign(new Event('storage'), { key: 'device-control-macros-v1' }));
  assert.equal(b.macros[0].id, first.id);
  targetA.dispatchEvent(new Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.save(), false);
  assert.equal(await writerB.acquire(), true);
  assert.equal(b.macros[0].id, first.id);
  b.create(); assert.equal(JSON.parse(shared.value).macros.length, 2);
  targetB.dispatchEvent(new Event('pagehide'));
  await new Promise(resolve => setImmediate(resolve));
  targetA.dispatchEvent(new Event('pageshow'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.macros.length, 2); assert.equal(a.writable, true);
  targetA.dispatchEvent(new Event('pagehide'));
});

test('restored unsaved drafts remain repairable in memory until exported before takeover', async () => {
  for (const input of ['', 'A']) {
    let saved = null, writes = 0, available = true;
    const shared = { getItem: () => saved, setItem() { writes++; throw new DOMException('Full', 'QuotaExceededError'); } };
    const library = createMacroLibrary(shared), target = new EventTarget();
    const writer = macroModule.createMacroWriter(library, { target, locks: { request: async (_name, _options, callback) => callback(available ? {} : null) } });
    assert.equal(await writer.acquire(), true);
    const macro = library.create();
    library.update(macro.id, { events: [{ kind: 'key', input, action: 'down', delayMs: 0 }] });
    const writesBeforeRestore = writes;
    target.dispatchEvent(new Event('pagehide'));
    available = false;
    saved = '{"version":1,"macros":[{"id":"other","name":"Other writer","events":[]}]}';
    target.dispatchEvent(new Event('pageshow'));
    await writer.acquire();
    assert.equal(library.editable, true, 'an incomplete draft must remain repairable without a lock');
    assert.equal(library.writable, false);
    assert.equal(library.update(macro.id, { events: [{ kind: 'key', input: 'Repaired', action: 'down', delayMs: 0 }] }), true);
    assert.equal(library.save(), false); assert.equal(writes, writesBeforeRestore);
    assert.equal(library.reload(), false); assert.equal(library.macros[0].id, macro.id);
    available = true;
    assert.equal(await writer.acquire(), false, 'a protected draft must be backed up before takeover');
    assert.equal(JSON.parse(library.export()).macros[0].events[0].input, 'Repaired');
    assert.equal(await writer.acquire(), false);
    assert.equal(await writer.acquire({ replaceDraft: true }), true);
    assert.equal(library.macros[0].id, 'other', 'takeover loads the other writer instead of merging or overwriting it');
    assert.equal(writes, writesBeforeRestore);
    target.dispatchEvent(new Event('pagehide'));
  }
});

test('confirmed replacement retains the draft until the lock and readable storage are available', async () => {
  let saved = null, lockAvailable = true, blockedRead = false;
  const storage = {
    getItem() { if (blockedRead) throw new Error('blocked'); return saved; },
    setItem() { throw new Error('quota'); }
  };
  const library = createMacroLibrary(storage), target = new EventTarget();
  const writer = macroModule.createMacroWriter(library, { target, locks: { request: async (_name, _options, callback) => callback(lockAvailable ? {} : null) } });
  assert.equal(await writer.acquire(), true);
  const draft = library.create();
  target.dispatchEvent(new Event('pagehide'));
  lockAvailable = false;
  target.dispatchEvent(new Event('pageshow'));
  await writer.acquire();
  library.export();
  assert.equal(await writer.acquire({ replaceDraft: true }), false);
  assert.equal(library.macros[0].id, draft.id);
  lockAvailable = true; blockedRead = true;
  assert.equal(await writer.acquire({ replaceDraft: true }), false);
  assert.equal(library.macros[0].id, draft.id);
  assert.equal(library.editable, true);
  blockedRead = false;
  saved = '{"version":1,"macros":[{"id":"other","name":"Other writer","events":[]}]}';
  assert.equal(await writer.acquire({ replaceDraft: true }), true);
  assert.equal(library.macros[0].id, 'other');
  target.dispatchEvent(new Event('pagehide'));
});

test('a new edit made while replacement waits for the lock is retained', async () => {
  let grant;
  const gate = new Promise(resolve => { grant = resolve; });
  const library = createMacroLibrary(storage()), target = new EventTarget();
  library.create();
  const writer = macroModule.createMacroWriter(library, { target, locks: { request: async (_name, _options, callback) => { await gate; return callback({}); } } });
  const pending = writer.acquire({ replaceDraft: true });
  library.create();
  grant();
  assert.equal(await pending, false);
  assert.equal(library.macros.length, 2);
  assert.equal(await writer.acquire({ replaceDraft: true }), true);
  assert.equal(library.macros.length, 0);
  target.dispatchEvent(new Event('pagehide'));
});

test('retry rereads recovered storage while retaining its writer lock', async () => {
  let blocked = true, writes = 0, requests = 0;
  const data = '{"version":1,"macros":[{"id":"saved","name":"Saved","events":[]}]}';
  const storage = { getItem() { if (blocked) throw new Error('blocked'); return data; }, setItem() { writes++; } };
  const library = createMacroLibrary(storage, { access: 'readonly' }), target = new EventTarget();
  const writer = macroModule.createMacroWriter(library, { target, locks: { request: async (_name, _options, callback) => { requests++; return callback({}); } } });
  assert.equal(await writer.acquire(), true);
  assert.equal(library.writable, false);
  blocked = false;
  assert.equal(await writer.acquire(), true);
  assert.equal(library.writable, true);
  assert.equal(library.macros[0].id, 'saved');
  assert.equal(requests, 1);
  assert.equal(writes, 0);
  target.dispatchEvent(new Event('pagehide'));
});

test('retrying an unreadable held lock protects a draft until explicit replacement succeeds', async () => {
  let saved = null, blocked = true, writes = 0;
  const storage = { getItem() { if (blocked) throw new Error('blocked'); return saved; }, setItem() { writes++; } };
  const library = createMacroLibrary(storage, { access: 'readonly' }), target = new EventTarget();
  const writer = macroModule.createMacroWriter(library, { target, locks: { request: async (_name, _options, callback) => callback({}) } });
  assert.equal(await writer.acquire(), true);
  const draft = library.create();
  blocked = false; saved = '{corrupt';
  assert.equal(await writer.acquire(), false);
  assert.equal(await writer.acquire({ replaceDraft: true }), false);
  assert.equal(library.macros[0].id, draft.id);
  assert.equal(library.writable, false);
  saved = '{"version":1,"macros":[{"id":"saved","name":"Saved","events":[]}]}';
  assert.equal(await writer.acquire({ replaceDraft: true }), true);
  assert.equal(library.macros[0].id, 'saved');
  assert.equal(library.writable, true);
  assert.equal(writes, 0);
  target.dispatchEvent(new Event('pagehide'));
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
