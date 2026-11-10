import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMacroLibrary, parseMacroImport } from '../public/macros.js';
import { createReviewLedger } from '../public/review.js';
import { createStore } from '../public/state.js';

test('macro import rejects executable or malformed events before changing the library', () => {
  const library = createMacroLibrary(null); library.create();
  const original = library.export();
  for (const event of [
    { kind: 'launch', input: 'cmd.exe', action: 'down', delayMs: 0 },
    { kind: 'key', input: 'A', action: 'down', delayMs: -1 },
    { kind: 'key', input: 'A', action: 'down', delayMs: 1.5 },
    { kind: 'mouse', input: 'left', action: 'click', delayMs: 0 },
    { kind: 'delay', delayMs: 0, command: 'whoami' }
  ]) {
    assert.throws(() => library.import(JSON.stringify({ version: 1, macros: [{ name: 'Unsafe', events: [event] }] })));
    assert.equal(library.export(), original);
  }
  assert.throws(() => parseMacroImport('{"version":1,"macros":[],"__proto__":{"polluted":true}}'));
  assert.equal({}.polluted, undefined);
  assert.throws(() => parseMacroImport(JSON.stringify({ version: 2, macros: [] })));
  assert.throws(() => parseMacroImport('x'.repeat(1_000_001)));
});

test('macro round-trip regenerates identity and keeps event values inert', () => {
  const library = createMacroLibrary(null), macro = library.create();
  const events = [{ kind: 'key', input: 'A', action: 'down', delayMs: 0 }, { kind: 'delay', delayMs: 12 }, { kind: 'key', input: 'A', action: 'up', delayMs: 1 }];
  assert.equal(library.update(macro.id, { name: '<img src=x onerror=alert(1)>', events }), true);
  const incoming = library.import(library.export());
  assert.equal(incoming.length, 1); assert.notEqual(incoming[0].id, macro.id);
  assert.deepEqual(incoming[0].events, events);
  assert.equal(incoming[0].name, '<img src=x onerror=alert(1)>');
});

test('blocked localStorage access preserves an available in-memory macro library', () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
  try {
    const library = createMacroLibrary();
    assert.equal(library.persistent, false); assert.ok(library.error);
    assert.ok(library.create()); assert.equal(library.macros.length, 1);
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'localStorage', descriptor);
    else delete globalThis.localStorage;
  }
});

test('storage quota failure retains drafts and surfaces a storage error', () => {
  const library = createMacroLibrary({ getItem: () => null, setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); } });
  const macro = library.create();
  assert.equal(library.macros.length, 1); assert.equal(library.macros[0].id, macro.id);
  assert.equal(library.persistent, false); assert.ok(library.error);
  assert.equal(library.update(macro.id, { name: 'Still editable' }), true);
  assert.equal(library.macros[0].name, 'Still editable');
});

test('stored duplicate macro identities are rejected before destructive CRUD', () => {
  const record = { id: 'same', name: 'One', events: [] };
  const library = createMacroLibrary({ getItem: () => JSON.stringify({ version: 1, macros: [record, { ...record, name: 'Two' }] }), setItem() {} });
  assert.equal(library.macros.length, 0); assert.ok(library.error);
});

test('review receipt identifiers stay unique across physical devices', () => {
  const ledger = createReviewLedger();
  const entry = { dirty: true, schema: { id: 'dpi', writable: true }, baseline: 800, draft: 900, errors: [] };
  const first = ledger.stage('a'.repeat(24), entry), second = ledger.stage('b'.repeat(24), entry);
  assert.notEqual(first.id, second.id);
  assert.equal(ledger.find(second.id).deviceId, 'b'.repeat(24));
});

test('missing setting or changed schema cannot reconcile an unknown write using historical readback', () => {
  const selected = 'b'.repeat(24), setting = { id: 'dpi', type: 'number', min: 100, max: 35000, value: 800, writable: true };
  for (const nextSettings of [[], [{ ...setting, max: 30000, value: 850 }]]) {
    const store = createStore(); store.ingest({ selectedDeviceId: selected, connected: true, settings: [setting] });
    store.edit('dpi', 900); store.entry('dpi').uncertain = true;
    store.ingest({ selectedDeviceId: selected, connected: true, settings: nextSettings });
    assert.equal(store.reconcile('dpi'), false);
    assert.equal(store.entry('dpi').uncertain, true); assert.equal(store.entry('dpi').stale, true);
    assert.equal(store.canApply('dpi'), false);
  }
});
