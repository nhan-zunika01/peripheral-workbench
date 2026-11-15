import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createTransport } from '../public/transport.js';
import { fixture } from './ui-fixture.mjs';

const token = 'a'.repeat(64);
const ok = data => ({ ok: true, status: 200, json: async () => data });

for (const marker of [undefined, '0', '1']) {
  test(`hosted read projects every setting read-only with writes marker ${marker ?? 'missing'}`, async () => {
    const snapshot = fixture(), original = structuredClone(snapshot);
    const transport = createTransport(async url => new URL(url).pathname === '/api/pair'
      ? ok({ token })
      : { ...ok(snapshot), headers: new Headers(marker === undefined ? {} : { 'x-razer-companion-writes': marker }) });
    const result = await transport.read(snapshot.selectedDeviceId);
    assert.ok(result.settings.length > 0);
    assert.ok(result.settings.every(setting => setting.writable === false));
    assert.notEqual(result, snapshot);
    assert.notEqual(result.settings, snapshot.settings);
    assert.deepEqual(snapshot, original);
  });
}

test('hosted apply rejects before pairing or fetching', async () => {
  const calls = [];
  const transport = createTransport(async (url, options) => { calls.push({ url, options }); return ok({ token }); });
  await assert.rejects(transport.apply('device', 'dpi', 1600), /read.only/i);
  assert.deepEqual(calls, []);
  assert.equal(transport.busy, false);
});

test('hosted apply rejects after renewal and while a read is pending without posting', async () => {
  const calls = [], snapshot = fixture();
  let rotate = false, hold, release;
  const transport = createTransport(async (url, options) => {
    const path = new URL(url).pathname; calls.push({ path, method: options.method });
    if (path === '/api/pair') return ok({ token });
    if (rotate) { rotate = false; return { ok: false, status: 401, json: async () => ({ error: 'Expired' }) }; }
    if (hold) await hold;
    return ok(snapshot);
  });
  await transport.read(snapshot.selectedDeviceId);
  rotate = true; await transport.read(snapshot.selectedDeviceId);
  assert.equal(calls.filter(call => call.path === '/api/pair').length, 2);
  const afterRenewal = await transport.apply('device', 'dpi', 1600).then(() => '', error => error.message);
  hold = new Promise(resolve => { release = resolve; });
  const pending = transport.read(snapshot.selectedDeviceId);
  let duringRead;
  try {
    duringRead = await transport.apply('device', 'dpi', 1600).then(() => '', error => error.message);
    assert.equal(await transport.poll(snapshot.selectedDeviceId, false), null);
  } finally { release(); await pending; }
  assert.match(afterRenewal, /read.only/i);
  assert.match(duringRead, /read.only/i);
  assert.equal(calls.some(call => call.method === 'POST'), false);
  assert.equal(transport.busy, false);
});

test('hosted browser keeps an old writable companion read-only and never posts', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(), page = await context.newPage();
    const snapshot = fixture(), posts = [], errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await context.route('http://qa.local/**', async route => {
      const pathname = new URL(route.request().url()).pathname;
      const file = new URL(`../public${pathname === '/' ? '/index.html' : pathname}`, import.meta.url);
      const contentType = pathname.endsWith('.js') ? 'application/javascript' : pathname.endsWith('.css') ? 'text/css' : pathname === '/' ? 'text/html' : 'image/svg+xml';
      try { await route.fulfill({ body: await readFile(file), contentType }); }
      catch { await route.fulfill({ status: 404, body: '' }); }
    });
    await context.route('http://127.0.0.1:17321/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      const headers = { 'access-control-allow-origin': 'http://qa.local', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-private-network': 'true', 'x-razer-companion-writes': '1' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (request.method() === 'POST') posts.push(path);
      if (path === '/api/pair') return route.fulfill({ json: { token }, headers });
      if (path === '/api/state') return route.fulfill({ json: snapshot, headers });
      if (path === '/api/settings') return route.fulfill({ json: { verified: true, state: snapshot }, headers });
      throw new Error(`Unexpected mock request: ${path}`);
    });
    await page.goto('http://qa.local/');
    await page.getByText('Companion connected', { exact: true }).waitFor();
    await page.locator('.device-card').first().getByRole('button').click();
    await page.evaluate(() => { location.hash = '#device/performance'; });
    await page.locator('form[data-setting="dpi"]').waitFor();
    const observed = await page.evaluate(async deviceId => {
      const forms = [...document.querySelectorAll('form[data-setting]')];
      const { createTransport } = await import('/transport.js');
      const transport = createTransport();
      await transport.read(deviceId);
      let rejection = '';
      try { await transport.apply(deviceId, 'dpi', { x: 2000, y: 2000 }); }
      catch (error) { rejection = error.message; }
      return { formCount: forms.length, readonlyCount: forms.filter(form => form.classList.contains('readonly')).length, applyCount: document.querySelectorAll('form[data-setting] .apply').length, rejection };
    }, snapshot.selectedDeviceId);
    assert.ok(observed.formCount > 0);
    assert.deepEqual({ readonlyCount: observed.readonlyCount, applyCount: observed.applyCount, rejected: /read.only/i.test(observed.rejection), posts },
      { readonlyCount: observed.formCount, applyCount: 0, rejected: true, posts: [] });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
