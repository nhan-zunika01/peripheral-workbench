import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { fixture } from '../tests/ui-fixture.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const source = resolve(process.env.QA_SOURCE_ROOT || projectRoot);
const outputOverride = process.env.QA_OUTPUT;
const output = outputOverride ? resolve(outputOverride) : resolve(projectRoot, 'docs/evidence/console-implementation-2026-11-08/qa');
const existingEntry = outputOverride && existsSync(output) && readdirSync(output)[0];
if (existingEntry) throw new Error(`QA_OUTPUT ${output}/${existingEntry} already exists; choose a new candidate output directory`);
await mkdir(output, { recursive: true });
const receipt = async () => Object.fromEntries(await Promise.all(['app.js', 'state.js', 'views.js', 'editors.js', 'macros.js', 'macro-view.js', 'review.js', 'project-views.js', 'i18n.js', 'style.css', 'index.html'].map(async file => [file, createHash('sha256').update(await readFile(resolve(source, 'public', file))).digest('hex')])));
const sourceReceipts = await receipt();
const servedTransportPath = resolve(source, 'tests/fixtures/legacy-source/public/transport.js');
const transportReceipt = async () => ({
  transportMode: 'historical-mock', servedTransportPath,
  servedTransportSha256: createHash('sha256').update(await readFile(servedTransportPath)).digest('hex'),
  productionTransportSha256: createHash('sha256').update(await readFile(resolve(source, 'public/transport.js'))).digest('hex')
});
const transportReceipts = await transportReceipt();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
const checks = [], failures = [], writes = [], errors = [], screenshots = [];
const initialSnapshot = fixture();
const initialDpi = structuredClone(initialSnapshot.settings.find(setting => setting.id === 'dpi')?.value || { x: 800, y: 800 });
const dpiSetting = initialSnapshot.settings.find(setting => setting.id === 'dpi');
const dpiAxis = (axis, delta) => {
  const schema = dpiSetting?.properties?.[axis] || dpiSetting || {};
  const baseValue = Number(initialDpi[axis]);
  let value = baseValue + delta;
  if (value > Number(schema.max)) value = baseValue - delta;
  return Math.max(Number(schema.min ?? 0), Math.min(Number(schema.max ?? Number.MAX_SAFE_INTEGER), value));
};
const dpiValue = delta => ({ x: dpiAxis('x', delta), y: dpiAxis('y', 0) });
let snapshot = initialSnapshot, failSetting = '', conflictSetting = '', conflictActual, currentWrites = 0, concurrentWrite = false, reads = 0;
page.on('pageerror', error => errors.push(error.stack || error.message));
await context.route('http://localhost/**', async route => {
  const pathname = new URL(route.request().url()).pathname;
  const file = pathname === '/transport.js' ? servedTransportPath : resolve(source, 'public', `.${pathname === '/' ? '/index.html' : pathname}`);
  const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }[extname(file)] || 'application/octet-stream';
  try { await route.fulfill({ body: await readFile(file), contentType: mime }); }
  catch { await route.fulfill({ status: 404, body: '' }); }
});
await context.route('http://127.0.0.1:17321/**', async route => {
  const request = route.request(), url = new URL(request.url());
  const headers = { 'access-control-allow-origin': 'http://localhost', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-private-network': 'true' };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
  if (url.pathname === '/api/pair') return route.fulfill({ json: { token: 'a'.repeat(64) }, headers });
  if (url.pathname === '/api/state') { reads++; return route.fulfill({ json: structuredClone(snapshot), headers }); }
  assert.equal(url.pathname, '/api/settings', 'Unexpected mocked endpoint');
  const change = request.postDataJSON(); writes.push(change);
  assert.equal(change.deviceId, snapshot.selectedDeviceId, 'Writes must remain on the selected physical device');
  const setting = snapshot.settings.find(setting => setting.id === change.id); assert.ok(setting?.writable);
  assert.ok(Object.hasOwn(change, 'expectedValue'), 'Review must send its reviewed baseline');
  assert.deepEqual(change.expectedValue, setting.value, 'Review expectedValue must match its latest read, including literal null for ACK-only settings');
  currentWrites++; concurrentWrite ||= currentWrites > 1;
  try {
    await new Promise(resolve => setTimeout(resolve, 25));
    if (conflictSetting === change.id) {
      conflictSetting = ''; setting.value = structuredClone(conflictActual);
      return route.fulfill({ status: 409, json: { error: 'Explicit mock: device state changed before dispatch', code: 'STATE_CONFLICT', actualValue: conflictActual }, headers });
    }
    if (failSetting === change.id) { failSetting = ''; return route.fulfill({ status: 504, json: { error: 'Explicit mock: write outcome unknown' }, headers }); }
    if (change.id !== 'smartTracking') setting.value = structuredClone(change.value);
    return route.fulfill({ json: { verified: true, verification: change.id === 'smartTracking' ? 'hardware-acknowledgement' : 'hardware-readback', state: structuredClone(snapshot) }, headers });
  } finally { currentWrites--; }
});

const form = id => page.locator(`form[data-setting="${id}"]`);
const row = (id, status) => page.locator(`.review-row[data-setting="${id}"]${status ? `[data-status="${status}"]` : ''}`);
const check = async (name, action) => {
  try { await action(); checks.push(name); process.stdout.write(`PASS ${name}\n`); }
  catch (error) {
    failures.push({ name, error: error.stack }); process.stdout.write(`FAIL ${name}: ${error.message.split('\n')[0]}\n`);
    const filename = `failure-${failures.length}`; await capture(`${filename}.png`);
    await writeFile(resolve(output, `${filename}.json`), JSON.stringify({ name, error: error.stack, pageErrors: errors, body: await page.locator('body').innerText(), writes }, null, 2));
  }
};
const go = async hash => {
  await page.evaluate(hash => { location.hash = hash; }, hash);
  const key = hash.slice(1);
  if (key.startsWith('device/')) await page.locator(`#section-${key.slice(7)}[aria-current=location]`).waitFor();
  else await page.locator(`#view .${{ macros: 'macros-page', profiles: 'profiles-page', catalog: 'catalog-page', 'catalog/keyboard': 'keyboard-reference', review: 'review-page', settings: 'settings-page', dashboard: 'dashboard' }[key]}`).waitFor();
};
const language = async locale => { await go('#settings'); await page.locator('#language-select').selectOption(locale); };
const reload = async () => {
  snapshot = fixture(); failSetting = ''; conflictSetting = '';
  await page.goto('http://localhost/'); await page.locator('#connection-dot.online').waitFor(); await language('en');
};
const poll = async () => {
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/state' && response.request().method() === 'GET');
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await response;
  await page.waitForFunction(() => !document.querySelector('[data-action=refresh]')?.disabled);
};
const stage = async id => { await form(id).locator('.apply').click(); await page.locator('#review-apply').waitFor(); };
const apply = async () => {
  const button = page.locator('#review-apply'), previous = await button.elementHandle();
  await button.click(); await page.waitForFunction(previous => !previous.isConnected, previous);
};
const capture = async filename => { await page.screenshot({ path: resolve(output, filename), fullPage: true }); screenshots.push(filename); };
const optionalDialog = async () => { if (await page.locator('#confirmation[open]').count()) await page.locator('#dialog-confirm').click(); };

try {
  await reload();
  await check('profile actions cannot share aggregate or individually staged batches', async () => {
    snapshot.settings.unshift(
      { id: 'session.profile', type: 'string', value: 'A', options: ['A', 'B'], writable: true },
      { id: 'session.resetProfile', type: 'boolean', value: false, writable: true }
    );
    await go('#device/performance'); await poll();
    await form('session.profile').locator('select').selectOption('B');
    await form('session.resetProfile').locator('input[type=checkbox]').check();
    const before = writes.length;
    await page.locator('[data-action=review-drafts]').click();
    assert.equal(await page.locator('.device-console').count(), 1);
    assert.match(await page.locator('#app-status').innerText(), /profile actions separately/);
    assert.equal(writes.length, before);
    await stage('session.profile'); await go('#device/performance'); await stage('session.resetProfile');
    await apply();
    assert.match(await page.locator('#review-status').innerText(), /profile actions separately/);
    assert.equal(await page.locator('#confirmation[open]').count(), 0);
    assert.equal(writes.length, before, 'A profile switch must never precede another operation in a batch');
  });
  await reload();
  await check('an external profile switch blocks a reviewed reset with unchanged readback', async () => {
    snapshot.settings.unshift(
      { id: 'session.profile', type: 'string', value: 'A', options: ['A', 'B'], writable: true },
      { id: 'session.resetProfile', type: 'boolean', value: false, writable: true }
    );
    await go('#device/performance'); await poll(); await form('session.resetProfile').locator('input[type=checkbox]').check();
    await stage('session.resetProfile'); const before = writes.length;
    snapshot.settings.find(setting => setting.id === 'session.profile').value = 'B';
    await page.locator('#review-apply').click(); await page.locator('#dialog-confirm').click();
    await row('session.resetProfile', 'needs-review').waitFor(); assert.equal(writes.length, before);
  });
  await check('dependent sensor modes cannot silently replace another reviewed setting', async () => {
    for (const [first, second] of [['dynamicMode', 'customCurve'], ['asymmetricTracking', 'smartTracking']]) {
      await reload(); await go('#device/advanced');
      if (first === 'dynamicMode') {
        await form(first).locator('select').selectOption('1');
        await page.locator('#console-curve > summary').click(); await page.locator('.sample-disclosure > summary').click();
        await form(second).locator('tbody input').first().fill('1.5');
      } else {
        const schema = snapshot.settings.find(setting => setting.id === first), landing = Number(schema?.properties?.landing?.min ?? 1), liftOff = Math.max(Number(schema?.properties?.liftOff?.min ?? 2), landing + 1);
        await form(first).getByLabel('Landing level', { exact: true }).fill(String(landing));
        await form(first).getByLabel('Lift-off level', { exact: true }).fill(String(liftOff));
        await form(second).locator('select').selectOption('2');
      }
      const before = writes.length; await page.locator('[data-action=review-drafts]').click();
      assert.equal(await page.locator('.device-console').count(), 1); assert.equal(writes.length, before);
      await stage(first); await go('#device/advanced');
      if (second === 'customCurve' && !await page.locator('#console-curve').evaluate(node => node.open)) await page.locator('#console-curve > summary').click();
      await stage(second); await apply();
      assert.match(await page.locator('#review-status').innerText(), /separately/); assert.equal(writes.length, before);
    }
  });
  await reload();
  await check('current section activation and sparse schemas always have a focusable target', async () => {
    await go('#device/performance'); await page.locator('#section-performance').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'console-section-performance');
    await page.locator('#section-performance').focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'console-section-performance');
    snapshot.settings = snapshot.settings.filter(setting => setting.id === 'customCurve'); await poll();
    for (const section of ['customize', 'performance', 'power', 'calibration', 'advanced']) {
      await go(`#device/${section}`); await page.locator(`#section-${section}`).click();
      assert.equal(await page.evaluate(() => document.activeElement.id), `console-section-${section}`);
    }
    assert.equal(await page.locator('form[data-setting]').count(), 1);
  });
  await reload();
  await check('console renders schemas once and global Review stages valid drafts without writes', async () => {
    await go('#device/performance');
    snapshot.settings.push({ id: 'vendor.alpha-beta', type: 'number', value: 0, writable: false }, { id: 'vendor.alpha.beta', type: 'number', value: 1, writable: false });
    await page.locator('[data-action=refresh]').click(); await page.waitForFunction(() => !document.querySelector('[data-action=refresh]').disabled);
    assert.equal(await page.locator('.device-console').count(), 1);
    const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(node => node.id)); assert.equal(new Set(ids).size, ids.length);
    const settings = await page.locator('form[data-setting]').evaluateAll(nodes => nodes.map(node => node.dataset.setting));
    assert.deepEqual(settings.sort(), snapshot.settings.map(setting => setting.id).sort());
    await form('dpi').locator('input[type=number]').first().fill('99');
    await form('polling').locator('select').selectOption('500');
    assert.equal(await page.locator('[data-action=review-drafts]').isDisabled(), true);
    const target = dpiValue(1000);
    await form('dpi').locator('input[type=number]').first().fill(String(target.x));
    assert.match(await page.locator('[data-console-count]').innerText(), /2/);
    assert.equal(writes.length, 0); await page.locator('[data-action=review-drafts]').click(); await page.locator('#review-apply').waitFor();
    assert.equal(writes.length, 0); assert.equal(await page.locator('.review-row[data-status=pending]').count(), 2);
    await apply(); assert.equal(writes.length, 2);
    assert.deepEqual(writes.map(w=>w.id), ['dpi','polling']);
    assert.ok(writes.every(w=>w.deviceId===snapshot.selectedDeviceId));
    assert.deepEqual(writes[0].expectedValue, initialDpi); assert.equal(writes[1].expectedValue,1000);
  });
  await reload();
  await check('curve disclosures survive a background refresh without a focused editor', async () => {
    const before = writes.length;
    await go('#device/advanced');
    await page.locator('#console-curve > summary').click(); await page.locator('.sample-disclosure > summary').click();
    await page.locator('h1').click(); await poll();
    assert.equal(await page.locator('#console-curve').evaluate(n=>n.open),true);
    assert.equal(await page.locator('.sample-disclosure').evaluate(n=>n.open),true);
    assert.equal(await page.locator('.sample-disclosure tbody tr').count(),250); assert.equal(writes.length,before);
    for (const selector of ['#console-curve > summary', '.sample-disclosure > summary', '#console-device-info > summary']) {
      await page.locator(selector).focus(); const id = await page.locator(selector).getAttribute('id'); await poll();
      assert.equal(await page.evaluate(() => document.activeElement.id), id, 'A background poll must retain disclosure summary focus');
    }
  });
  await reload();
  await check('focused clean poll updates sibling; dirty typing survives polling; staging is inert', async () => {
    await go('#device/performance'); await form('dpi').locator('input[type=number]').first().focus();
    const polled = { x: dpiValue(1000).x, y: dpiAxis('y', 1200) };
    const dirty = { x: dpiValue(2000).x, y: polled.y };
    snapshot.settings.find(setting => setting.id === 'dpi').value = polled;
    await poll();
    assert.equal(await form('dpi').locator('input[type=number]').last().inputValue(), String(polled.y));
    await form('dpi').locator('input[type=number]').first().fill(String(dirty.x));
    await form('dpi').locator('input[type=number]').first().evaluate(input => { input.dataset.qaRetained = 'yes'; });
    await poll();
    assert.equal(await form('dpi').locator('[data-qa-retained=yes]').count(), 1);
    assert.equal(await form('dpi').locator('input[type=number]').first().inputValue(), String(dirty.x));
    const count = writes.length; await stage('dpi'); assert.equal(writes.length, count);
    await apply(); await row('dpi', 'success').waitFor();
    assert.deepEqual(writes.at(-1).value, dirty);
  });

  await check('external baseline change stops a staged operation before POST', async () => {
    const target = dpiValue(1000); await reload(); await go('#device/performance'); await form('dpi').locator('input[type=number]').first().fill(String(target.x));
    await stage('dpi'); const count = writes.length;
    snapshot.settings.find(setting => setting.id === 'dpi').value = { x: dpiValue(1100).x, y: initialDpi.y };
    await apply(); await row('dpi', 'needs-review').waitFor(); assert.equal(writes.length, count);
  });

  await check('server state conflict returns to review and never retries the rejected write', async () => {
    const target = dpiValue(1000); await reload(); await go('#device/performance'); await form('dpi').locator('input[type=number]').first().fill(String(target.x)); await stage('dpi');
    const count = writes.length; conflictSetting = 'dpi'; conflictActual = { x: dpiValue(1300).x, y: initialDpi.y };
    await apply(); await row('dpi', 'needs-review').waitFor();
    assert.equal(writes.length, count + 1); await page.waitForTimeout(80); assert.equal(writes.length, count + 1);
    assert.equal(await page.locator('#review-apply').isDisabled(), true);
    assert.match(await row('dpi', 'needs-review').innerText(), new RegExp(String(conflictActual.x)));
  });

  await check('batch stops on uncertainty, blocks remaining writes, and requires fresh explicit reconciliation', async () => {
    await reload(); await go('#device/performance');
    const target = dpiValue(1000); await form('dpi').locator('input[type=number]').first().fill(String(target.x)); await stage('dpi');
    await go('#device/performance'); await form('polling').locator('select').selectOption('500'); await stage('polling');
    const count = writes.length; failSetting = 'dpi'; await apply(); await row('dpi', 'uncertain').waitFor();
    assert.equal(writes.length, count + 1); assert.equal(await page.locator('#review-apply').isDisabled(), true);
    await page.waitForTimeout(80); assert.equal(writes.length, count + 1);
    snapshot.settings = snapshot.settings.filter(setting => setting.id !== 'dpi');
    await page.locator('[data-action=review-read]').click(); await page.waitForTimeout(80);
    assert.equal(await page.locator('[data-action=review-accept]').count(), 0, 'Missing getter must not reuse historical readback');
    assert.equal(await page.locator('#review-apply').isDisabled(), true);
    snapshot.settings.unshift({ ...fixture().settings.find(setting => setting.id === 'dpi'), value: { x: dpiValue(1500).x, y: initialDpi.y } });
    await page.locator('[data-action=review-read]').click(); await page.locator('[data-action=review-accept]').waitFor();
    assert.equal(writes.length, count + 1); await page.locator('[data-action=review-accept]').click();
    await apply(); await row('polling', 'success').waitFor();
    await page.waitForFunction(() => [...document.querySelectorAll('.review-row')].filter(row => row.dataset.setting === 'dpi' && row.dataset.status === 'success').length === 1);
    assert.deepEqual(writes.slice(count).map(write => write.id), ['dpi', 'polling', 'dpi']);
    assert.equal(concurrentWrite, false, 'Hardware operations must run serially');
  });

  await check('smart tracking ACK is explicit; unknown ACK-only operation retires without replay', async () => {
    await reload(); await go('#device/calibration'); await form('smartTracking').locator('select').selectOption('2'); await stage('smartTracking');
    let count = writes.length; await apply(); await row('smartTracking', 'success').waitFor();
    assert.match(await row('smartTracking', 'success').innerText(), /acknowledg/i);
    assert.equal(writes.length, count + 1);
    await go('#device/calibration'); await form('smartTracking').locator('select').selectOption('3'); await stage('smartTracking');
    failSetting = 'smartTracking'; count = writes.length; await apply(); await row('smartTracking', 'uncertain').waitFor();
    await page.locator('[data-action=review-read]').click(); await page.waitForTimeout(80);
    assert.equal(await page.locator('[data-action=review-accept]').count(), 0);
    await page.locator('[data-action=review-retire]').click(); await optionalDialog();
    await row('smartTracking', 'unresolved').waitFor(); assert.equal(writes.length, count + 1);
    assert.doesNotMatch(await row('smartTracking', 'unresolved').innerText(), /verified by.*readback/i);
    assert.equal(await row('smartTracking', 'pending').count(), 0, 'Retirement must not restage the failed operation');
    await go('#device/performance'); await form('polling').locator('select').selectOption('500'); await stage('polling');
    await apply(); await row('polling', 'success').waitFor(); assert.equal(writes.at(-1).id, 'polling');
    const beforeNewDraft = writes.length;
    await page.locator('[data-action=review-new-draft]').click();
    assert.equal(writes.length, beforeNewDraft); assert.equal(await row('smartTracking', 'pending').count(), 0);
    await go('#device/calibration'); assert.equal(await form('smartTracking').locator('select').isDisabled(), true);
    await poll(); assert.equal(writes.length, beforeNewDraft);
    await form('smartTracking').locator('select').selectOption('1'); await stage('smartTracking');
    assert.match(await row('smartTracking', 'pending').innerText(), /unknown|not read|not available|unverified/i);
    assert.equal(writes.filter(write => write.id === 'smartTracking').length, 2, 'No smart-tracking replay without a new explicit confirmation');
    failSetting = 'smartTracking'; await apply(); await row('smartTracking', 'uncertain').waitFor();
    await go('#device/performance'); await form('polling').locator('select').selectOption('1000');
    assert.equal(await page.locator('[data-action=review-drafts]').isDisabled(), true, 'An old retired attempt must not hide a later uncertain attempt');
    await stage('polling'); assert.equal(await page.locator('#review-apply').isDisabled(), true);
  });

  await check('macro editor preserves events, supports reorder/search/duplicate/import and never POST', async () => {
    await page.evaluate(() => localStorage.removeItem('device-control-macros-v1'));
    await reload(); await go('#macros'); const count = writes.length;
    await page.locator('#macro-import').setInputFiles({ name: 'unsafe.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, macros: [{ name: 'Unsafe', events: [{ kind: 'launch', delayMs: 0 }] }] })) });
    await page.waitForFunction(() => document.querySelector('#macro-status')?.textContent.includes('supported data format'));
    assert.equal(await page.locator('.macro-choice').count(), 0);
    await page.locator('[data-macro-action=create]').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'macro-name');
    await page.locator('#macro-name').fill('QA <img src=x>'); await page.locator('#macro-name').press('Tab');
    for (const kind of ['key', 'mouse', 'delay']) { await page.locator('#macro-insert-trigger').click(); await page.locator(`[data-macro-action=add-${kind}]`).click(); }
    const events = page.locator('.macro-event'); assert.equal(await events.count(), 3);
    await page.locator('#macro-insert-trigger').click(); await poll();
    assert.equal(await page.locator('.macro-insert-menu').evaluate(node => node.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'macro-insert-trigger');
    await page.locator('#macro-insert-trigger').click();
    await events.nth(0).click();
    await page.locator('#macro-event-kind').selectOption('delay');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'macro-event-kind');
    await page.locator('#macro-event-kind').selectOption('key');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'macro-event-kind');
    await page.locator('[data-event-field=input]').fill('A');
    await page.locator('[data-event-field=delay]').fill('12'); await page.locator('[data-event-field=delay]').press('Tab');
    await page.locator('.macro-event').nth(1).click(); await page.locator('[data-event-field=input]').selectOption('right');
    await page.locator('.macro-event').nth(2).click(); await page.locator('[data-event-field=delay]').fill('42'); await page.locator('[data-event-field=delay]').press('Tab');
    const exported = page.waitForEvent('download'); await page.locator('[data-action=export-macros]').click();
    const download = await exported, data = JSON.parse(await readFile(await download.path(), 'utf8'));
    const macro = data.macros.find(macro => macro.name === 'QA <img src=x>'); assert.ok(macro);
    assert.deepEqual(macro.events.map(event => event.kind), ['key', 'mouse', 'delay']);
    assert.equal(macro.events[0].input, 'A'); assert.equal(macro.events[0].delayMs, 12);
    assert.equal(macro.events[1].input, 'right'); assert.equal(macro.events[2].delayMs, 42);
    assert.equal(await page.locator('.macro-sequence img[src=x]').count(), 0);
    assert.equal(await page.locator('[data-runtime]').evaluateAll(controls => controls.every(control => control.disabled)), true);
    assert.match(await page.locator('.macro-total').innerText(), /54 ms/);
    await page.locator('.macro-event').nth(2).click(); await page.locator('[data-macro-action=move-up]').click();
    assert.deepEqual(await page.locator('.macro-event-title').allInnerTexts(), ['Key down', 'Delay', 'Right click press']);
    assert.equal(await page.locator('[data-event-field=input]').count(), 0);
    await page.locator('[data-macro-action=move-down]').click();
    assert.deepEqual(await page.locator('.macro-event-title').allInnerTexts(), ['Key down', 'Right click press', 'Delay']);
    const originalId = await page.locator('.macro-choice.selected').getAttribute('data-macro-id');
    await page.locator('#macro-search').fill('does-not-match'); assert.equal(await page.locator('.macro-choice-item:visible').count(), 0);
    await page.locator('#macro-search').fill('QA'); assert.equal(await page.locator('.macro-choice-item:visible').count(), 1);
    const originalChoice = page.locator(`.macro-choice[data-macro-id="${originalId}"]`);
    await originalChoice.click();
    assert.equal(await page.locator('.macro-choice-item:visible').count(), 1);
    assert.equal(await page.locator('#macro-search').inputValue(), 'QA');
    assert.equal(await page.evaluate(() => document.activeElement.id), `macro-choice-${originalId}`);
    await page.locator('#macro-name').fill('QA revised'); await page.locator('#macro-name').press('Tab');
    assert.equal(await page.locator('.macro-choice-item:visible').count(), 1);
    assert.equal(await page.locator('#macro-search').inputValue(), 'QA');
    await page.locator('.macro-event').nth(2).click(); await page.locator('[data-macro-action=move-up]').click();
    assert.equal(await page.locator('.macro-choice-item:visible').count(), 1);
    assert.equal(await page.locator('#macro-search').inputValue(), 'QA');
    await page.locator('#macro-insert-trigger').click(); await page.locator('[data-macro-action=add-delay]').click();
    assert.equal(await page.locator('.macro-choice-item:visible').count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'macro-event-3');
    await page.locator('[data-macro-action=duplicate]').click();
    const copyId = await page.locator('.macro-choice.selected').getAttribute('data-macro-id'); assert.notEqual(copyId, originalId);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'macro-name');
    assert.equal(await page.locator('.macro-event').count(), 4);
    assert.equal(await page.locator('.macro-event').first().getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-event-field=input]').inputValue(), 'A');
    assert.equal(await page.locator('.macro-choice-item:visible').count(), 2);
    assert.equal(await page.locator('#macro-search').inputValue(), 'QA');
    await page.locator('[data-macro-action=save]').click(); assert.match(await page.locator('#macro-status').innerText(), /saved/i);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'save-macros');
    const libraryCount = await page.locator('.macro-choice').count();
    for (const unsafe of [{ kind: 'launch', input: 'cmd.exe', action: 'down', delayMs: 0 }, { kind: 'key', input: 'A', action: 'down', delayMs: 0, script: 'alert(1)' }]) {
      await page.locator('#macro-import').setInputFiles({ name: 'unsafe.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, macros: [{ name: 'Unsafe', events: [unsafe] }] })) });
      await page.waitForTimeout(60); assert.equal(await page.locator('.macro-choice').count(), libraryCount);
    }
    await page.locator('#macro-import').setInputFiles({ name: 'safe.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, macros: [macro] })) });
    await page.waitForFunction(count => document.querySelectorAll('.macro-choice').length === count + 1, libraryCount);
    assert.equal(await page.locator('.macro-event').count(), 3);
    await page.locator('[data-macro-action=delete]').click(); await page.locator('#dialog-confirm').click();
    await page.waitForFunction(count => document.querySelectorAll('.macro-choice').length === count, libraryCount);
    assert.equal(await page.locator('.macro-choice').count(), libraryCount); assert.equal(await page.evaluate(() => document.activeElement.id), 'macro-name'); assert.equal(writes.length, count);
  });

  await check('new routes render EN/VI at desktop/mobile without overflow, missing labels, or page errors', async () => {
    const routes = ['#dashboard', '#macros', '#profiles', '#catalog', '#catalog/keyboard', '#review'];
    const layoutErrors = [];
    for (const locale of ['en', 'vi']) {
      await language(locale); assert.equal(await page.locator('html').getAttribute('lang'), locale);
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        await page.setViewportSize({ width, height });
        for (const hash of routes) {
          await go(hash);
          const state = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth, headings: document.querySelectorAll('h1').length, unlabelled: [...document.querySelectorAll('input,select,textarea')].filter(input => !input.getAttribute('aria-label') && !input.labels?.length).map(input => input.outerHTML) }));
          if (state.scroll !== state.viewport || state.headings !== 1 || state.unlabelled.length) {
            const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].map(element => ({ tag: element.tagName, id: element.id, cls: element.className, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, width: element.getBoundingClientRect().width, overflow: getComputedStyle(element).overflowX })).filter(element => element.left < -1 || element.right > innerWidth + 1).slice(0, 20));
            layoutErrors.push({ locale, width, hash, ...state, overflow });
          }
          await capture(`${locale}-${width}-${hash.slice(1).replaceAll('/', '-')}.png`);
        }
      }
    }
    assert.deepEqual(layoutErrors, []);
    assert.deepEqual(errors, []);
  });
  assert.deepEqual(await receipt(), sourceReceipts, 'Source changed during acceptance; rerun the stable candidate');
  assert.deepEqual(await transportReceipt(), transportReceipts, 'Transport changed during acceptance; rerun the stable candidate');
  await writeFile(resolve(output, 'report.json'), JSON.stringify({ source, sourceReceipts, ...transportReceipts, checks, failures, screenshots, writes: writes.map(({ deviceId, id }) => ({ deviceId, id })), reads, concurrentWrite, pageErrors: errors }, null, 2));
  assert.deepEqual(failures, [], 'Browser acceptance has failing scenarios');
  process.stdout.write(`PASS ${checks.length} independent checks, ${screenshots.length} screenshots; all companion responses mocked\n`);
} catch (error) {
  await capture('failure.png');
  await writeFile(resolve(output, 'failure.json'), JSON.stringify({ source, sourceReceipts, ...transportReceipts, checks, writes, reads, pageErrors: errors, error: error.stack, body: await page.locator('body').innerText() }, null, 2));
  throw error;
} finally { await browser.close(); }
