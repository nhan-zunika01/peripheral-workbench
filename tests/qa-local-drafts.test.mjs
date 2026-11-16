import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMacroLibrary, parseMacroImport, macroLimits } from '../public/macros.js';
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
  assert.throws(() => parseMacroImport('x'.repeat(macroLimits.importBytes + 1)), /importSize/);
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
  const library = createMacroLibrary({ getItem: () => null, setItem: () => { throw new DOMException('Full', 'QuotaExceededError'); } }, { access: 'writer' });
  const macro = library.create();
  assert.equal(library.macros.length, 1); assert.equal(library.macros[0].id, macro.id);
  assert.equal(library.persistent, false); assert.ok(library.error);
  assert.equal(library.update(macro.id, { name: 'Still editable' }), true);
  assert.equal(library.macros[0].name, 'Still editable');
});

test('the largest v1 Unicode backup round-trips below the shared finite import cap', () => {
  // Lone surrogates need six JSON bytes per UTF-16 unit, more than any other allowed character.
  const document = { version: 1, macros: Array.from({ length: 100 }, () => ({
    name: '\ud800'.repeat(64), events: Array.from({ length: 500 }, () => ({ kind: 'key', input: '\ud800'.repeat(32), action: 'down', delayMs: 60000 }))
  })) };
  const source = JSON.stringify(document, null, 2);
  assert.equal(new TextEncoder().encode(source).length, 15_844_036);
  assert.equal(macroLimits.importBytes, 32_000_000);
  const library = createMacroLibrary(null), incoming = library.import(source);
  assert.equal(incoming.length, 100);
  assert.deepEqual(JSON.parse(library.export()), document);
  const other = createMacroLibrary(null), copied = other.import(library.export());
  assert.notEqual(copied[0].id, incoming[0].id);
  assert.deepEqual(copied[99].events, incoming[99].events);
});

test('parser accepts the exact UTF-8 byte cap and rejects the next byte before parsing', () => {
  const source = '{"version":1,"macros":[]}';
  assert.deepEqual(parseMacroImport(source.padEnd(32_000_000)), []);
  assert.throws(() => parseMacroImport(source.padEnd(32_000_001)), /importSize/);
  const unicode = '{"version":1,"macros":[{"name":"界","events":[]}]}';
  const bytes = new TextEncoder().encode(unicode).length;
  assert.equal(parseMacroImport(unicode.padEnd(unicode.length + 32_000_000 - bytes)).length, 1);
  assert.throws(() => parseMacroImport(unicode.padEnd(unicode.length + 32_000_001 - bytes)), /importSize/);
  assert.throws(() => parseMacroImport('['.repeat(100_000) + ']'.repeat(100_000)), /macroFormat/);
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
