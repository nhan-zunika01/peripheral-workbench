import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const load = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)));

test('the historical MOCK fixture source is preserved with every frozen oracle hash', async () => {
  const { createHash } = await import('node:crypto');
  const path = new URL('./fixtures/legacy-source/tests/ui-fixture.mjs', import.meta.url);
  assert.ok(existsSync(path), 'original ui-fixture source bytes must be preserved');
  const actual = createHash('sha256').update(readFileSync(path)).digest('hex');
  for (const name of ['companion-contract', 'adapter-parity', 'inventory-parity']) {
    assert.equal(actual, load(name).provenance.sources['tests/ui-fixture.mjs'], name);
  }
});
test('PnP-only candidate expectation pins reviewed byte-order selection without changing the oracle', async () => {
  const { expectedInventory } = await import('../scripts/verify-companion-contract.mjs');
  const rows = load('inventory-parity').cases, before = structuredClone(rows);
  const expected = expectedInventory(rows.find(row => row.id === 'pnp-only'));
  assert.deepEqual(expected.groups.map(row => row.id), ['7c75ab08f9510d039d36b94c', 'c9d1393bfe20dd67e1589452']);
  assert.equal(expected.selectedDeviceId, '7c75ab08f9510d039d36b94c');
  assert.equal(expected.results[0].selectedDeviceId, '7c75ab08f9510d039d36b94c');
  assert.equal(expected.results[0].model, 'Razer USB');
  assert.deepEqual(expected.results[0].devices.map(row => row.id), ['7c75ab08f9510d039d36b94c', 'c9d1393bfe20dd67e1589452']);
  for (const row of rows.filter(row => row.id !== 'pnp-only')) assert.deepEqual(expectedInventory(row), row.candidateExpected || row.legacy);
  assert.deepEqual(rows, before);
});
test('frozen fixture provenance preserves source bytes or the explicitly extended MOCK fixture snapshot', async () => {
  const { createHash } = await import('node:crypto');
  for (const name of ['companion-contract', 'adapter-parity', 'inventory-parity']) {
    const { provenance } = load(name); assert.equal(provenance.physicalParity, false);
    for (const [path, expected] of Object.entries(provenance.sources)) {
      assert.ok(provenance.sourceLines[path].length);
      if (path === 'tests/ui-fixture.mjs') {
        const previous = process.env.UI_SCHEMA_FIXTURE;
        delete process.env.UI_SCHEMA_FIXTURE;
        try { assert.deepEqual((await import('./ui-fixture.mjs')).fixture(), load('adapter-parity').uiSnapshot); }
        finally { if (previous === undefined) delete process.env.UI_SCHEMA_FIXTURE; else process.env.UI_SCHEMA_FIXTURE = previous; }
      }
      const source = ['bridge/server.mjs', 'bridge/backend.mjs', 'bridge/native-host.cjs', 'public/transport.js', 'tests/ui-fixture.mjs'].includes(path) ? `./fixtures/legacy-source/${path}` : `../${path}`;
      const actual = createHash('sha256').update(readFileSync(new URL(source, import.meta.url))).digest('hex');
      assert.equal(actual, expected, `${name}: legacy oracle source changed: ${path}`);
    }
  }
});
test('review: response comparison accepts JSON spelling and key order while enforcing canonical zero', async () => {
  const { compareWire, semanticObservations } = await import('../scripts/verify-companion-contract.mjs');
  const expected = load('companion-contract').wire.find(row => row.id === 'numeric-spelling').legacy;
  const actual = structuredClone(expected);
  actual.bodyHex = Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(actual.body).reverse()), null, 2).replaceAll(': 800', ': 800.0')).toString('hex');
  assert.notEqual(actual.bodyHex, expected.bodyHex);
  assert.doesNotThrow(() => compareWire(actual, expected, 'equivalent encoding'));
  assert.deepEqual(semanticObservations({ responses: [actual] }), semanticObservations({ responses: [expected] }));
  actual.body.state.settings[0].value = 801; actual.bodyHex = Buffer.from(JSON.stringify(actual.body)).toString('hex');
  assert.throws(() => compareWire(actual, expected, 'changed value'));
  const extraField = structuredClone(expected); extraField.body.bodyHex = 'unexpected application field'; extraField.bodyHex = Buffer.from(JSON.stringify(extraField.body)).toString('hex');
  assert.notDeepEqual(semanticObservations({ responses: [extraField] }), semanticObservations({ responses: [expected] }));
  const zero = { ...structuredClone(expected), body: { value: 0, text: '0.0' }, bodyHex: Buffer.from('{"value":0,"text":"0.0"}').toString('hex') };
  assert.doesNotThrow(() => compareWire(zero, zero, 'canonical zero'));
  for (const literal of ['-0', '0.0', '0e0']) {
    const noncanonical = { ...zero, bodyHex: Buffer.from(`{"value":${literal},"text":"0.0"}`).toString('hex') };
    assert.throws(() => compareWire(noncanonical, zero, 'noncanonical zero'));
    assert.throws(() => semanticObservations({ responses: [noncanonical] }));
  }
});
test('review: missing Host preserves parser400 legacy but expects application403 before dispatch', async () => {
  const { expectedWire } = await import('../scripts/verify-companion-contract.mjs');
  const row = load('companion-contract').wire.find(row => row.id === 'absent-host');
  assert.equal(row.legacy.status, 400); assert.equal(row.legacy.bodyHex, '');
  const expected = expectedWire(row);
  assert.equal(expected.status, 403); assert.deepEqual(expected.body, { error: 'Host or UI origin not allowed' });
  assert.equal(expected.headers['content-type'], 'application/json'); assert.equal(expected.headers['cache-control'], 'no-store');
  assert.equal(expected.headers['x-content-type-options'], 'nosniff'); assert.equal(expected.headers['access-control-allow-origin'], undefined);
  assert.equal(expected.dispatches, 0); assert.deepEqual(expected.transcript, []);
});
test('review: Rust pairing markers are explicit and checked in write, read-only and renewal paths', async () => {
  const { expectedWire, compareWire, expectedScenario, semanticObservations } = await import('../scripts/verify-companion-contract.mjs');
  const fixture = load('companion-contract');
  for (const [id, writes] of [['pair', '1'], ['pair-read-only', '0']]) {
    const row = fixture.wire.find(row => row.id === id); assert.ok(row, `missing explicit fake mode: ${id}`);
    const expected = expectedWire(row);
    assert.equal(expected.headers['x-razer-companion-backend'], 'rust'); assert.equal(expected.headers['x-razer-companion-writes'], writes);
    assert.doesNotThrow(() => compareWire(expected, expected, id));
    for (const mutate of [value => { delete value.headers['x-razer-companion-backend']; }, value => { value.headers['x-razer-companion-writes'] = writes === '1' ? '0' : '1'; }, value => { value.headers['x-unexpected'] = 'bad'; }]) {
      const bad = structuredClone(expected); mutate(bad); assert.throws(() => compareWire(bad, expected, id));
    }
  }
  const row = fixture.scenarios.find(row => row.id === 'auth-apply-renew'), expected = expectedScenario(row);
  const pairs = expected.requests.filter(row => row.path === '/api/pair'); assert.equal(pairs.length, 2);
  for (const pair of pairs) { assert.equal(pair.response.headers['x-razer-companion-backend'], 'rust'); assert.equal(pair.response.headers['x-razer-companion-writes'], '1'); }
  const bad = structuredClone(expected); bad.requests[0].response.headers['x-unexpected'] = 'bad';
  assert.notDeepEqual(semanticObservations(bad), semanticObservations(expected));
});
test('review: duplicate Host and Origin freeze legacy observations and reject before candidate dispatch', async () => {
  const { expectedWire } = await import('../scripts/verify-companion-contract.mjs');
  const { captureWire } = await import('./companion-wire-support.mjs');
  for (const id of ['duplicate-host', 'duplicate-origin']) {
    const row = load('companion-contract').wire.find(row => row.id === id); assert.ok(row, `missing duplicate trust header: ${id}`);
    assert.deepEqual(await captureWire(row.input), row.legacy);
    const expected = expectedWire(row); assert.equal(expected.status, 400); assert.equal(expected.dispatches, 0);
    assert.deepEqual(expected.transcript, []); assert.deepEqual(expected.body, { error: 'Duplicate header' });
    assert.equal(expected.headers['access-control-allow-origin'], undefined);
  }
});
test('review: initial and renewed configured fake tokens are validated before scrubbing', async () => {
  const { legacyTestTarget } = await import('./companion-test-target.mjs');
  const { captureRemoteScenario } = await import('./companion-remote-support.mjs');
  for (const pairTokens of [['c'.repeat(64)], ['malformed'], [undefined, 'c'.repeat(64)]]) {
    const target = legacyTestTarget({ pairTokens });
    try { await assert.rejects(captureRemoteScenario(target, { kind: 'auth' }), /configured pairing token/i); }
    finally { await target.stop(); }
  }
  const { scrubPairToken } = await import('./companion-wire-support.mjs');
  const valid = { body: { token: 'a'.repeat(64) } }; scrubPairToken(valid, 'a'.repeat(64)); assert.equal(valid.body.token, '<TOKEN>');
  assert.throws(() => scrubPairToken({ body: { token: 'c'.repeat(64) } }, 'a'.repeat(64)), /configured pairing token/i);
});
test('review: shutdown rejects missing acknowledgement, nonzero exit and forced termination after cleanup', async () => {
  const { startCandidate } = await import('../scripts/verify-companion-contract.mjs');
  const { EventEmitter } = await import('node:events'), { PassThrough, Writable } = await import('node:stream');
  for (const mode of ['missing-ack', 'nonzero-exit', 'forced-kill']) {
    const child = new EventEmitter(), calls = []; let closed = false;
    child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.stdin = new Writable({ write(bytes, _, done) {
      const command = JSON.parse(bytes); calls.push(command.op);
      queueMicrotask(() => {
        if (mode === 'nonzero-exit') child.stdout.write(JSON.stringify({ id: command.id, ok: true, result: null }) + '\n');
        if (mode !== 'forced-kill') { closed = true; child.emit('close', mode === 'nonzero-exit' ? 7 : 0); }
      }); done();
    } });
    child.kill = () => { calls.push('kill'); setTimeout(() => { closed = true; child.emit('close', null, 'SIGTERM'); }, 5); return true; };
    const target = await startCandidate('test-target', () => { queueMicrotask(() => child.stdout.write('{"ready":true,"protocol":1,"port":32123}\n')); return child; }, { timeoutMs: 40 });
    await assert.rejects(target.stop(), /shutdown|acknowledgement|timed out|exit/i, mode);
    assert.equal(closed, true, `${mode}: close must be awaited`);
    assert.deepEqual(calls, mode === 'forced-kill' ? ['shutdown', 'kill'] : ['shutdown']);
  }
});
test('frozen wire oracle covers trust boundaries and replays exact HTTP observations', async () => {
  const fixture = load('companion-contract');
  for (const id of ['pair', 'absent-auth', 'invalid-auth', 'absent-origin', 'invalid-origin', 'invalid-host', 'preflight', 'unknown-route', 'strict-content-type', 'limit-16384', 'limit-16385', 'fragmented-utf8']) {
    assert.ok(fixture.wire.some(row => row.id === id), `missing frozen wire capability: ${id}`);
  }
  const { captureWire } = await import('./companion-wire-support.mjs');
  for (const row of fixture.wire) {
    const expected = structuredClone(row.legacy);
    if (row.input.path === '/api/pair' && expected.status === 200) expected.headers['x-razer-companion-backend'] = 'legacy';
    assert.deepEqual(await captureWire(row.input), expected, row.id);
  }
});
test('transport renewal, read coalescing and timed-out lease retain real dispatch order', async () => {
  const fixture = load('companion-contract');
  for (const id of ['auth-apply-renew', 'auth-read-renew', 'auth-renew-fails', 'auth-omitted-expected', 'auth-null-expected', 'shared-explicit', 'shared-omitted-explicit', 'shared-different', 'lease-retained']) assert.ok(fixture.scenarios?.some(row => row.id === id), `missing orchestration capability: ${id}`);
  const { captureScenario } = await import('./companion-scenario-support.mjs');
  for (const row of fixture.scenarios) {
    const expected = structuredClone(row.legacy);
    for (const request of expected.requests || []) if (request.path === '/api/pair') request.response.headers['x-razer-companion-backend'] = 'legacy';
    assert.deepEqual(await captureScenario(row.input), expected, row.id);
  }
  const renew = fixture.scenarios.find(row => row.id === 'auth-apply-renew').legacy.requests.filter(row => row.path === '/api/settings');
  assert.deepEqual(renew.map(row => [row.response.status, row.dispatches]), [[401, 0], [200, 1]]);
  assert.equal(renew[0].requestHex, renew[1].requestHex);
  const readRenew = fixture.scenarios.find(row => row.id === 'auth-read-renew').legacy.requests.filter(row => row.path.startsWith('/api/state'));
  assert.deepEqual(readRenew.map(row => [row.response.status, row.snapshots]), [[401, 0], [200, 1]]);
  const omitted = fixture.scenarios.find(row => row.id === 'auth-omitted-expected').legacy.requests.find(row => row.path === '/api/settings');
  const explicitNull = fixture.scenarios.find(row => row.id === 'auth-null-expected').legacy.requests.find(row => row.path === '/api/settings');
  assert.equal(Object.hasOwn(JSON.parse(Buffer.from(omitted.requestHex, 'hex').toString()), 'expectedValue'), false);
  assert.equal(JSON.parse(Buffer.from(explicitNull.requestHex, 'hex').toString()).expectedValue, null);
  for (const [id, count] of [['shared-explicit', 2], ['shared-omitted-explicit', 3], ['shared-different', 3]]) {
    const scenario = fixture.scenarios.find(row => row.id === id).legacy;
    assert.equal(scenario.snapshots, count); assert.equal(scenario.snapshotsBeforeRelease, 1);
  }
  const failed = fixture.scenarios.find(row => row.id === 'auth-renew-fails').legacy;
  assert.equal(failed.requests.length, 4); assert.equal(failed.transcript.length, 0);
  const lease = fixture.scenarios.find(row => row.id === 'lease-retained').legacy;
  assert.deepEqual(lease.responses.map(row => row.status), [504, 400, 415, 409, 409, 200, 200]);
  assert.equal(lease.elapsedVirtualMs, 75000); assert.equal(lease.writesBeforeRelease, 1);
});
test('explicit differential requires an absolute existing test executable and never silently skips', async () => {
  const { spawnSync } = await import('node:child_process');
  const script = new URL('../scripts/verify-companion-contract.mjs', import.meta.url);
  const { fileURLToPath } = await import('node:url');
  for (const args of [[], ['--candidate-test-server', 'relative.exe'], ['--candidate-test-server', fileURLToPath(new URL('./missing-contract-server.exe', import.meta.url))]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1); assert.match(result.stderr, /candidate test executable/i);
  }
});
test('candidate scenario driver observes real loopback responses through its private control protocol', async () => {
  const { legacyTestTarget } = await import('./companion-test-target.mjs');
  const { captureRemoteScenario } = await import('./companion-remote-support.mjs');
  const { semanticObservations, expectedScenario } = await import('../scripts/verify-companion-contract.mjs');
  const target = legacyTestTarget();
  try {
    for (const row of load('companion-contract').scenarios) assert.deepEqual(semanticObservations(await captureRemoteScenario(target, row.input)), semanticObservations(expectedScenario(row)), row.id);
  } finally { await target.stop(); }
});
test('differential client rejects altered body bytes, security headers and dispatch counts and shuts its child down', async () => {
  const { compareWire, startCandidate } = await import('../scripts/verify-companion-contract.mjs');
  const row = load('companion-contract').wire.find(row => row.id === 'numeric-spelling');
  compareWire(row.legacy, row.legacy, row.id);
  for (const mutate of [value => { value.bodyHex = '00'; }, value => { value.headers['cache-control'] = 'public'; }, value => { value.dispatches = 0; }]) {
    const changed = structuredClone(row.legacy); mutate(changed);
    assert.throws(() => compareWire(changed, row.legacy, row.id));
  }
  const { EventEmitter } = await import('node:events');
  const { PassThrough, Writable } = await import('node:stream');
  const calls = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(bytes, _, done) {
    const command = JSON.parse(bytes); calls.push(command);
    queueMicrotask(() => { child.stdout.write(JSON.stringify({ id: command.id, ok: true, result: null }) + '\n'); if (command.op === 'shutdown') child.emit('close', 0); }); done();
  } });
  const target = await startCandidate('test-target', (_, argv, options) => {
    assert.deepEqual(argv, ['--serve-contract-fixture']); assert.equal(options.windowsHide, true);
    queueMicrotask(() => child.stdout.write('{"ready":true,"protocol":1,"port":32123}\n')); return child;
  });
  assert.equal(target.server.address().port, 32123); await target.command('observe'); await target.stop();
  assert.deepEqual(calls.map(row => row.op), ['observe', 'shutdown']);
});
test('raw HTTP client rejects a malformed candidate response through its promise', { timeout: 3000 }, async t => {
  const http = await import('node:http'), { once } = await import('node:events');
  const { request, closeBridge } = await import('./companion-wire-support.mjs');
  const server = http.createServer((_, response) => { response.end('not JSON'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => closeBridge(server));
  await assert.rejects(request(server), SyntaxError);
});
test('browser controls match frozen schemas when getters or conditional settings are unavailable', async () => {
  const { chromium } = await import('playwright');
  const { readFile } = await import('node:fs/promises');
  const frozen = load('adapter-parity'); let snapshot;
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(), page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.host === '127.0.0.1:17321') {
        const headers = { 'access-control-allow-origin': 'http://qa.local', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-private-network': 'true' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        return route.fulfill({ json: url.pathname === '/api/pair' ? { token: 'a'.repeat(64) } : snapshot, headers });
      }
      assert.equal(url.host, 'qa.local', 'No external network in schema fixture test');
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const contentType = pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname.endsWith('.html') ? 'text/html' : 'image/svg+xml';
      try { await route.fulfill({ body: await readFile(new URL(`../public${pathname}`, import.meta.url)), contentType }); }
      catch { await route.fulfill({ status: 404, body: '' }); }
    });
    for (const id of ['available', 'old-14-schema', 'unavailable-pollingWired', 'unavailable-pollingWireless', 'unavailable-dynamicMode', 'unavailable-calibrationState']) {
      snapshot = { ...frozen.uiSnapshot, ...frozen.cases.find(row => row.id === id).legacy.result };
      await page.goto('http://qa.local/'); await page.getByText('Companion connected', { exact: true }).waitFor();
      await page.locator('.device-card').first().getByRole('button').click();
      await page.evaluate(() => { location.hash = '#device/performance'; });
      const rendered = await page.locator('form[data-setting]').evaluateAll(forms => forms.map(form => form.dataset.setting));
      assert.deepEqual(rendered.sort(), snapshot.settings.map(row => row.id).sort(), id);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
test('inventory oracle binds exact identities, endpoint grouping, selected paths and unknown SKU isolation', async () => {
  const fixture = load('inventory-parity');
  for (const id of ['container-group', 'no-container', 'two-identical', 'stale-selection', 'unknown-sku', 'deterministic-sort', 'connected-warning', 'disconnected-warning']) assert.ok(fixture.cases.some(row => row.id === id), `missing inventory capability: ${id}`);
  const { captureInventory } = await import('./companion-inventory-support.mjs');
  for (const row of fixture.cases) {
    const expected = structuredClone(row.legacy);
    // T04 closes production capabilities; historical adapter protocol fixtures stay writable.
    for (const result of expected.results) for (const setting of result.settings || []) setting.writable = false;
    if (['stale-selection', 'unknown-sku'].includes(row.id)) {
      expected.results[expected.results.length - 1] = { error: 'Legacy transport is read-only; hardware writes have not been verified', status: 400 };
      expected.transcript.pop(); // Direct apply is rejected before the historical inventory read.
    }
    assert.deepEqual(await captureInventory(row.input), expected, row.id);
  }
  const two = fixture.cases.find(row => row.id === 'two-identical').legacy.groups;
  assert.equal(new Set(two.map(row => row.id)).size, 2);
  const stale = fixture.cases.find(row => row.id === 'stale-selection').legacy;
  assert.equal(stale.results[1].connected, false); assert.match(stale.results[2].error, /no longer attached/);
  assert.equal(stale.transcript.filter(row => row.action === 'apply').length, 0);
  const unknown = fixture.cases.find(row => row.id === 'unknown-sku').legacy;
  assert.equal(unknown.exchanges.length, 0); assert.equal(unknown.results[0].connected, false);
  assert.ok(fixture.cases.find(row => row.id === 'deterministic-sort').candidateDifference);
});
test('adapter oracle freezes every candidate schema, unavailable getter, write and partial failure', async () => {
  const fixture = load('adapter-parity');
  const ids = ['firmware', 'dpi', 'dpiStages', 'polling', 'pollingWired', 'pollingWireless', 'battery', 'sleep', 'lowPower', 'rotation', 'dynamicState', 'dynamicMode', 'customCurve', 'calibrationState', 'asymmetricTracking', 'smartTracking'];
  assert.deepEqual(fixture.cases.find(row => row.id === 'available')?.legacy.result?.settings.map(row => row.id), ids, 'missing complete 16-schema adapter oracle');
  const { captureAdapter } = await import('./companion-adapter-support.mjs');
  for (const id of ids) assert.ok(fixture.cases.some(row => row.id === `unavailable-${id}`), `missing unavailable getter: ${id}`);
  for (const row of fixture.cases) assert.deepEqual(await captureAdapter(row.input), row.legacy, row.id);
  assert.equal(fixture.oldReceipt.settingIds.length, 14);
  assert.equal(fixture.oldReceipt.unavailable.length, 2);
  assert.equal(fixture.uiSnapshot.settings.length, 16);
  assert.deepEqual(fixture.cases.find(row => row.id === 'old-14-schema').legacy.result.settings.map(row => row.id), fixture.oldReceipt.settingIds);
  for (const id of ids.filter(id => id !== 'firmware')) {
    const missing = fixture.cases.find(row => row.id === `unavailable-${id}`).legacy.result;
    assert.ok(!missing.settings.some(row => row.id === id), `unavailable getter synthesized a setting: ${id}`);
  }
  for (const id of ids.filter(id => !['firmware', 'battery', 'calibrationState'].includes(id))) assert.ok(fixture.cases.some(row => row.id === `apply-${id}` && row.legacy.result?.verified), `missing successful setter: ${id}`);
  const partial = fixture.cases.find(row => row.id === 'curve-partial-failure').legacy;
  assert.match(partial.error, /uncertain chunk/);
  assert.deepEqual(partial.transcript.filter(row => row.command?.join() === '37,11,19').map(row => row.data[3]), [0, 8, 16]);
  assert.match(fixture.cases.find(row => row.id === 'readback-mismatch').legacy.error, /differs/);
});
test('raw numeric, equality and schema boundary corpus preserves legacy results and intentional differences', async () => {
  const fixture = load('companion-contract');
  const expected = { 'signed-zero': [409, 0], 'numeric-spelling': [200, 1], 'rounded-large-integer': [200, 1], 'overflow-expected': [409, 0], 'missing-expected': [200, 1], 'null-expected': [409, 0], 'null-actual': [409, 0], 'object-order': [200, 1], 'array-order': [409, 0], 'invalid-utf8': [200, 1], 'duplicate-keys': [200, 1], 'number-min': [200, 1], 'number-below-min': [400, 0], 'curve-short': [400, 0] };
  for (const [id, [status, dispatches]] of Object.entries(expected)) {
    const row = fixture.wire.find(row => row.id === id);
    assert.ok(row, `missing raw/schema capability: ${id}`);
    assert.equal(row.legacy.status, status, id); assert.equal(row.legacy.dispatches, dispatches, id);
  }
  assert.match(fixture.wire.find(row => row.id === 'signed-zero').input.raw, /-0/);
  assert.match(fixture.wire.find(row => row.id === 'rounded-large-integer').input.raw, /9007199254740993/);
  for (const id of ['overflow-expected', 'invalid-utf8', 'duplicate-keys', 'duplicate-authorization']) {
    assert.ok(fixture.wire.find(row => row.id === id).candidateDifference, `undocumented candidate difference: ${id}`);
  }
  const conflict = fixture.wire.find(row => row.id === 'null-actual').legacy.body;
  assert.ok(Object.hasOwn(conflict, 'actualValue')); assert.equal(conflict.actualValue, null);
});
