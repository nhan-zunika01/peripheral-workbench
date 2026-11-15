import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter, once } from 'node:events';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { fixture } from './ui-fixture.mjs';
import { createBridge } from '../bridge/server.mjs';

test('focused clean object editor preserves the newer sibling from a completed poll', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(), page = await context.newPage();
    let snapshot = fixture(); const writes = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('http://qa.local/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = pathname === '/transport.js' ? new URL('./fixtures/legacy-source/public/transport.js', import.meta.url) : new URL(`../public${pathname === '/' ? '/index.html' : pathname}`, import.meta.url);
      const contentType = pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname === '/' ? 'text/html' : 'image/svg+xml';
      try { await route.fulfill({ body: await readFile(file), contentType }); }
      catch { await route.fulfill({ status: 404, body: '' }); }
    });
    await context.route('http://127.0.0.1:17321/**', async route => {
      const request = route.request(), pathname = new URL(request.url()).pathname;
      const headers = { 'access-control-allow-origin': 'http://qa.local', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-private-network': 'true' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (pathname === '/api/pair') return route.fulfill({ json: { token: 'a'.repeat(64) }, headers });
      if (pathname === '/api/state') return route.fulfill({ json: snapshot, headers });
      if (pathname === '/api/settings') {
        const change = request.postDataJSON(); writes.push(change);
        snapshot.settings.find(setting => setting.id === change.id).value = change.value;
        return route.fulfill({ json: { verified: true, verification: 'hardware-readback', state: snapshot }, headers });
      }
      throw new Error(`Unexpected mock request: ${pathname}`);
    });
    await page.goto('http://qa.local/');
    await page.getByText('Companion connected', { exact: true }).waitFor();
    await page.locator('.device-card').first().getByRole('button').click();
    await page.evaluate(() => { location.hash = '#device/performance'; });
    assert.equal(await page.locator('.device-console').count(), 1);
    const settings = await page.locator('form[data-setting]').evaluateAll(forms => forms.map(form => form.dataset.setting));
    assert.equal(new Set(settings).size, settings.length);
    assert.deepEqual(settings.sort(), snapshot.settings.map(s => s.id).sort());
    const form = page.locator('[data-setting="dpi"]');
    await form.locator('input[type=number]').first().focus();
    snapshot.settings.find(setting => setting.id === 'dpi').value = { x: 1800, y: 2200 };
    const polled = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state' && response.request().method() === 'GET');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await polled;
    await page.waitForFunction(() => !document.querySelector('[data-action=refresh]').disabled);
    await form.locator('input[type=number]').first().fill('2000');
    await form.locator('.apply').click();
    assert.equal(writes.length, 0, 'Staging a review must not write the device');
    const applied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/settings' && response.request().method() === 'POST');
    await page.locator('#review-apply').click();
    await applied;
    assert.equal(writes.length, 1);
    assert.deepEqual(writes[0].value, { x: 2000, y: 2200 });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test('post-apply refresh cannot return a verified response for another physical identity', async () => {
  const selected = 'b'.repeat(24), other = 'c'.repeat(24), token = 'a'.repeat(64), origin = 'https://qa.example';
  let reads = 0;
  const server = createBridge({ origin, token, backend: {
    snapshot: async () => ++reads === 1 ? { selectedDeviceId: selected, connected: true, settings: [{ id: 'dpi', type: 'number', value: 800, writable: true }] } : { selectedDeviceId: other, connected: true, settings: [] },
    apply: async () => ({ verified: true, verification: 'hardware-readback' })
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/settings`, { method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: selected, id: 'dpi', value: 900 }) });
    const result = await response.json();
    assert.ok(response.status >= 400 || result.state?.selectedDeviceId === selected, `Received ${response.status} verified response with replacement identity ${result.state?.selectedDeviceId}`);
  } finally { server.close(); }
});

test('native adapter rejects checksum-valid DPI and stage responses with missing payload', async () => {
  const source = await readFile(new URL('../bridge/native-host.cjs', import.meta.url), 'utf8');
  const require = createRequire(import.meta.url), protocol = require('../bridge/protocol.cjs');
  const stdin = new EventEmitter(); stdin.setEncoding = () => {};
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const process = { env: {}, execPath: 'C:/mock/RazerAppEngine.exe', stdin, stdout: { write: value => finish(JSON.parse(value.slice('MOUSE_CONTROL_RESULT:'.length))) } };
  const mockHid = {
    devices: () => [{ vendorId: 0x1532, productId: 0xdf, interface: 0, path: 'mock-hid' }],
    HID: class {
      async sendFeatureReport(sent) { this.sent = Buffer.from(sent.slice(1)); return sent.length; }
      async getFeatureReport() {
        const reply = Buffer.from(this.sent); reply[0] = 2; reply.fill(0, 8, 88);
        if (reply[6] === 4 && [133, 134].includes(reply[7])) reply[5] = 0;
        reply[88] = protocol.checksum(reply);
        return [0, ...reply];
      }
      async close() {}
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, require: path => path.endsWith('node-rz-hid') ? mockHid : path === './protocol.cjs' ? protocol : require(path), process, Buffer, setTimeout: callback => queueMicrotask(callback), console });
  const request = { action: 'snapshot', deviceId: 'b'.repeat(24), target: ['mock-hid'] };
  if (!module.exports.handleRequest) { stdin.emit('data', JSON.stringify(request)); stdin.emit('end'); }
  const snapshot = module.exports.handleRequest ? await module.exports.handleRequest(request, mockHid) : await completed;
  assert.equal(snapshot.settings.some(setting => setting.id === 'dpi'), false, 'Malformed DPI payload was exposed as a setting');
  assert.equal(snapshot.settings.some(setting => setting.id === 'dpiStages'), false, 'Malformed stage payload was exposed as a setting');
  assert.ok(snapshot.unavailable.some(message => /DPI/i.test(message)));
});
