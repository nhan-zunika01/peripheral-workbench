import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture, deviceA, deviceB } from '../tests/ui-fixture.mjs';

const base = process.env.UI_URL || 'http://127.0.0.1:8787';
const outputOverride = process.env.UI_OUTPUT;
const outputPath = outputOverride ? resolve(outputOverride) : fileURLToPath(new URL('../docs/evidence/macro-redesign-2026-11-02/ui/', import.meta.url));
const existingEntry = outputOverride && existsSync(outputPath) && readdirSync(outputPath)[0];
if (existingEntry) throw new Error(`UI_OUTPUT ${outputPath}/${existingEntry} already exists; choose a new candidate output directory`);
mkdirSync(outputPath, { recursive: true });
const output = pathToFileURL(outputPath + sep);
const browser = await chromium.launch({ headless: true, ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [], writes = [], checks = [], screenshots = [];
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
const initialLowPower = initialSnapshot.settings.find(setting => setting.id === 'lowPower')?.value;
let snapshot = initialSnapshot, offline = false, writeFailure = false, writeConflict = null, readbackOverride = null, readCount = 0, delayRead = 0, pairing = 0;
page.on('pageerror', e => errors.push(e.message));
await context.addInitScript(() => {
  // Make the explicit mock obvious in every acceptance screenshot.
  document.addEventListener('DOMContentLoaded', () => {
    const note = document.createElement('p'); note.textContent = 'Mock companion — layout & interaction test';
    note.className = 'device-notice'; note.id = 'mock-notice'; document.querySelector('main').prepend(note);
  });
});
await context.route('http://127.0.0.1:17321/**', async route => {
  const request = route.request(), url = new URL(request.url());
  const headers = { 'access-control-allow-origin': base, 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-private-network': 'true' };
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
  if (offline) return route.abort('connectionrefused');
  if (url.pathname === '/api/pair') { pairing++; return route.fulfill({ json: { token: 'a'.repeat(64) }, headers }); }
  if (url.pathname === '/api/settings') {
    const body = request.postDataJSON(); writes.push(body);
    if (writeFailure) return route.fulfill({ status: 504, json: { error: 'Explicit mock timeout: result unknown' }, headers });
    assert.equal(body.deviceId, deviceA); const setting = snapshot.settings.find(s => s.id === body.id); assert.ok(setting?.writable);
    if (writeConflict) { setting.value = structuredClone(writeConflict); const actualValue = structuredClone(writeConflict); writeConflict = null; return route.fulfill({ status: 409, json: { error: 'Explicit mock state conflict', code: 'STATE_CONFLICT', actualValue }, headers }); }
    if (Object.hasOwn(body, 'expectedValue')) assert.deepEqual(body.expectedValue, setting.value);
    setting.value = body.value;
    if (readbackOverride) { setting.value = structuredClone(readbackOverride); readbackOverride = null; }
    return route.fulfill({ json: { verified: true, verification: body.id === 'smartTracking' ? 'hardware-acknowledgement' : 'hardware-readback', state: snapshot }, headers });
  }
  if (url.pathname === '/api/state') {
    readCount++; if (delayRead) await new Promise(resolve => setTimeout(resolve, delayRead));
    const id = url.searchParams.get('deviceId') || deviceA;
    const data = id === deviceB ? { ...snapshot, selectedDeviceId: deviceB, model: 'Test keyboard (detected only)', connected: false, settings: [], message: 'Explicit mock: no verified adapter for this keyboard.' } : snapshot;
    return route.fulfill({ json: data, headers });
  }
  return route.fulfill({ status: 404, json: {}, headers });
});
const go = async hash => { await page.evaluate(hash => { location.hash = hash; }, hash); await page.waitForTimeout(80); };
const form = id => page.locator(`[data-setting="${id}"]`);
const applySetting = async id => {
  const previous = await page.evaluate(() => location.hash);
  await form(id).locator('.apply').click(); await page.locator('#review-apply').waitFor();
  assert.equal(await page.locator('#review-apply').isEnabled(), true);
  await page.locator('#review-apply').click(); await page.waitForTimeout(100);
  if (previous !== '#review') await go(previous);
};
const capture = file => page.screenshot({ path: new URL(file, output).pathname.replace(/^\/([A-Z]:)/, '$1'), fullPage: true });
const check = (name, fn) => Promise.resolve().then(fn).then(() => { checks.push(name); process.stdout.write(`PASS ${name}\n`); });
try {
  await page.goto(base); await page.getByText('Companion connected', { exact: true }).waitFor();
  await check('auto-pair and real inventory cardinality', async () => { assert.equal(pairing, 1); assert.equal(await page.locator('.device-card').count(), 2); assert.equal(writes.length, 0); });
  await page.locator('.device-card').first().getByRole('button').click(); await page.locator('#section-customize[aria-current=location]').waitFor();
  await check('unsupported mappings are honest; console section navigation works', async () => {
    assert.equal(await page.locator('.assignment-panel form').count(), 0);
    await page.locator('#section-customize').focus(); await page.keyboard.press('ArrowRight'); assert.equal(await page.locator('#section-performance').evaluate(e => e === document.activeElement), true);
    await page.keyboard.press('Enter'); await page.locator('#section-performance[aria-current=location]').waitFor();
  });
  await check('DPI sliders edit drafts; clean and invalid Apply are disabled', async () => {
    assert.equal(await form('dpi').locator('.apply').isDisabled(), true);
    const target = dpiValue(1000);
    await form('dpi').locator('input[type=range]').first().fill(String(target.x));
    assert.equal(await form('dpi').locator('input[type=number]').first().inputValue(), String(target.x)); assert.equal(writes.length, 0);
    await form('dpi').locator('input[type=number]').first().fill('99'); assert.equal(await form('dpi').locator('.apply').isDisabled(), true);
    await form('dpi').locator('input[type=number]').first().fill(String(target.x)); assert.equal(await form('dpi').locator('.apply').isEnabled(), true);
  });
  await check('locale, navigation and Back keep drafts without POST', async () => {
    await go('#settings'); await page.locator('#language-select').selectOption('vi'); assert.equal(await page.locator('html').getAttribute('lang'), 'vi');
    const target = dpiValue(1000);
    await go('#device/performance'); assert.equal(await form('dpi').locator('input[type=number]').first().inputValue(), String(target.x));
    await go('#device/power'); await page.goBack(); await page.waitForTimeout(80); assert.equal(await form('dpi').locator('input[type=number]').first().inputValue(), String(target.x));
    await go('#settings'); await page.locator('#language-select').selectOption('en'); await go('#device/performance'); assert.equal(writes.length, 0);
  });
  await check('Apply writes one setting and retains another dirty draft', async () => {
    const target = dpiValue(1000);
    await form('polling').locator('select').selectOption('500'); await applySetting('dpi'); await page.getByText('Updated and verified by device readback.', { exact: true }).waitFor();
    assert.deepEqual(writes.at(-1), { deviceId: deviceA, id: 'dpi', value: target, expectedValue: initialDpi });
    assert.equal(await form('polling').locator('select').inputValue(), '500'); assert.equal(await form('polling').locator('.apply').isEnabled(), true); assert.equal(await form('dpi').locator('.apply').isDisabled(), true);
  });
  await check('verified readback differences stay visible without automatic retry', async () => {
    const count = writes.length, target = dpiValue(1100), readback = dpiValue(1150); readbackOverride = readback;
    await form('dpi').locator('input[type=number]').first().fill(String(target.x)); await form('dpi').locator('.apply').click();
    await page.locator('#review-apply').click();
    const row = page.locator('.review-row[data-setting="dpi"][data-status="success"]').last();
    await row.getByText('Device readback differs from the value at confirmation; the device value is shown above.').waitFor();
    assert.match(await row.locator('dd').nth(2).innerText(), new RegExp(String(readback.x))); assert.equal(writes.length, count + 1);
    await go('#device/performance');
  });
  await check('reload confirmation keeps edits on Escape and returns focus', async () => {
    await page.locator('[data-action=refresh]').click(); await page.locator('dialog[open]').waitFor(); assert.equal(await page.locator('#dialog-cancel').evaluate(e => e === document.activeElement), true);
    await capture('state-confirmation.png');
    await page.keyboard.press('Escape'); assert.equal(await form('polling').locator('select').inputValue(), '500');
    assert.equal(await page.locator('[data-action=refresh]').evaluate(e => e === document.activeElement), true);
  });
  await check('device switch requires confirmation and stays physically bound', async () => {
    await go('#dashboard'); await page.locator('.device-card').nth(1).getByRole('button').click(); await page.locator('#dialog-cancel').click(); assert.equal(await page.locator('.device-card').count(), 2);
    await page.locator('.device-card').nth(1).getByRole('button').click(); await page.locator('#dialog-confirm').click(); await page.getByRole('heading', { name: 'Test keyboard (detected only)', exact: true, level: 1 }).waitFor();
    await page.waitForFunction(() => !document.querySelector('[data-action=refresh]').disabled);
    await capture('state-detected-only.png');
    assert.equal(await page.locator('[data-setting]').count(), 0); await go('#dashboard'); await page.locator('.device-card').first().getByRole('button').click();
    await page.waitForFunction(() => !document.querySelector('[data-action=refresh]').disabled); await go('#device/performance');
    assert.equal(await form('polling').locator('select').inputValue(), '1000');
  });
  await check('stage removal clamps active only in draft and preserves other stage values', async () => {
    const stage = snapshot.settings.find(setting => setting.id === 'dpiStages');
    const originalStages = structuredClone(stage?.value?.stages || []), seed = originalStages.at(-1) || { x: initialDpi.x, y: initialDpi.y };
    stage.value = { ...(stage.value || {}), active: 5, stages: Array.from({ length: 5 }, (_, index) => structuredClone(originalStages[index] || seed)) };
    await page.locator('[data-action=refresh]').click(); if (await page.locator('#dialog-confirm').isVisible()) await page.locator('#dialog-confirm').click(); await page.waitForTimeout(100);
    await form('dpiStages').getByRole('button', { name: 'Stage 5', exact: true }).click(); await form('dpiStages').getByRole('button', { name: 'Remove last stage' }).click();
    assert.equal(await form('dpiStages').getByRole('button', { name: 'Stage 4', exact: true }).getAttribute('aria-pressed'), 'true');
    await applySetting('dpiStages'); assert.equal(writes.at(-1).id, 'dpiStages'); assert.equal(writes.at(-1).value.active, 4); assert.equal(writes.at(-1).value.stages.length, 4); assert.equal(writes.at(-1).value.stages[0].x, originalStages[0]?.x ?? seed.x);
  });
  await check('native sleep uses minutes and sends seconds; quantized low-power baseline is kept', async () => {
    await go('#device/power'); assert.equal(await form('sleep').locator('input[type=number]').inputValue(), '5'); assert.equal(await form('lowPower').locator('input[type=number]').inputValue(), String(initialLowPower));
    assert.equal(await form('lowPower').locator('[aria-invalid=true]').count(), 0);
    assert.equal(await form('lowPower').locator('input[type=range]').inputValue(), String(initialLowPower));
    await form('sleep').locator('input[type=number]').fill('6'); await applySetting('sleep'); assert.equal(writes.at(-1).value, 360);
  });
  await check('null smart tracking has placeholder; acknowledgement does not claim readback', async () => {
    await go('#device/calibration'); assert.equal(await form('smartTracking').locator('select').inputValue(), ''); assert.equal(await form('smartTracking').locator('.apply').isDisabled(), true);
    await form('asymmetricTracking').locator('input[type=number]').last().fill('3'); assert.equal(await form('asymmetricTracking').locator('.apply').isDisabled(), true);
    await form('smartTracking').locator('select').selectOption('2'); await applySetting('smartTracking'); await page.getByText('Device acknowledged the command; independent mode readback is unavailable.', { exact: true }).waitFor();
  });
  await check('curve changes only one sample and sends exactly 250 values', async () => {
    await go('#device/advanced');
    if (!await page.locator('#console-curve').evaluate(node => node.open)) await page.locator('#console-curve > summary').click();
    await form('customCurve').locator('summary').first().click(); const before = [...snapshot.settings.find(s => s.id === 'customCurve').value];
    await form('customCurve').getByRole('spinbutton', { name: 'Curve value 42', exact: true }).fill('2');
    await applySetting('customCurve'); const value = writes.at(-1).value;
    assert.equal(value.length, 250); assert.equal(value.filter((v, i) => v !== before[i]).length, 1); assert.equal(value[42], 2);
  });
  await check('write timeout retains draft, blocks reapply and does not retry', async () => {
    const target = dpiValue(1200); await go('#device/performance'); await form('dpi').locator('input[type=number]').first().fill(String(target.x)); writeFailure = true;
    const count = writes.length; await applySetting('dpi'); await page.getByText('The result is unknown. Refresh to check the device before applying again.', { exact: true }).waitFor();
    await capture('state-write-error.png');
    assert.equal(writes.length, count + 1); assert.equal(await form('dpi').locator('input[type=number]').first().inputValue(), String(target.x)); assert.equal(await form('dpi').locator('.apply').isDisabled(), true); writeFailure = false;
    await go('#review'); await page.locator('.review-row[data-status="uncertain"] [data-action=review-read]').click();
    await page.locator('.review-row[data-status="reconcile-ready"] [data-action=review-accept]').click();
    await page.locator('.review-row[data-status="pending"] button').filter({ hasText: 'Cancel this change' }).click();
    await go('#device/performance');
  });
  await check('automatic polls preserve dirty DOM and block stale schema', async () => {
    const target = dpiValue(1300); await form('dpi').locator('input[type=number]').first().fill(String(target.x)); await form('dpi').locator('input[type=number]').first().evaluate(e => { e.dataset.retained = 'yes'; });
    snapshot.settings.find(s => s.id === 'dpi').properties.x.max = 30000;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(150);
    assert.equal(await form('dpi').locator('input[data-retained=yes]').count(), 1); assert.equal(await form('dpi').locator('.apply').isDisabled(), true);
    await capture('state-schema-changed.png');
    await page.locator('[data-action=refresh]').click(); await page.locator('#dialog-confirm').click(); await page.waitForTimeout(100);
  });
  await check('pending read locks edits and navigation without a second request', async () => {
    delayRead = 300; const before = readCount; await page.locator('[data-action=refresh]').click(); await page.waitForTimeout(50);
    assert.equal(await form('dpi').locator('input[type=number]').first().isDisabled(), true);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(400); assert.equal(readCount, before + 1); delayRead = 0;
  });
  await check('disconnect/reconnect keep dirty values; hidden tabs pause polling', async () => {
    const target = dpiValue(1400); await form('dpi').locator('input[type=number]').first().fill(String(target.x)); offline = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(150);
    assert.equal(await form('dpi').locator('input[type=number]').first().inputValue(), String(target.x)); assert.equal(await form('dpi').locator('.apply').isDisabled(), true);
    offline = false; await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await page.waitForTimeout(150);
    assert.equal(await form('dpi').locator('input[type=number]').first().inputValue(), String(target.x)); assert.equal(await form('dpi').locator('.apply').isEnabled(), true);
    const reads = readCount;
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); }); await page.waitForTimeout(150);
    assert.equal(readCount, reads); await page.evaluate(() => { delete document.hidden; });
    await capture('state-dirty.png');
  });
  await check('session minutes and read-only fallback preserve runtime contracts', async () => {
    await page.locator('[data-action=refresh]').click(); await page.locator('#dialog-confirm').click(); await page.waitForTimeout(100);
    snapshot.settings.push({ id: 'session.sleep', type: 'number', min: 1, max: 15, value: 5, writable: true });
    snapshot.settings.push({ id: 'vendor.extension', label: 'Vendor extension', type: 'object', properties: { enabled: { type: 'boolean' } }, value: { enabled: true, metadata: { revision: 3 } }, writable: false });
    snapshot.settings.find(s => s.id === 'customCurve').writable = false;
    await page.locator('[data-action=refresh]').click(); await page.waitForTimeout(100); await go('#device/power');
    assert.equal(await form('session.sleep').locator('input[type=number]').inputValue(), '5');
    await form('session.sleep').locator('input[type=number]').fill('6'); await applySetting('session.sleep');
    assert.equal(writes.at(-1).id, 'session.sleep'); assert.equal(writes.at(-1).value, 6);
    await go('#device/advanced'); assert.equal(await form('customCurve').locator('input,button').count(), 0);
    assert.equal(await form('vendor.extension').locator('input,button').count(), 0); assert.equal(await page.getByRole('heading', { name: 'Additional controls' }).count(), 1);
  });
  // Reset fake data for visual acceptance; it stays isolated from the real companion.
  snapshot = fixture(); await page.locator('[data-action=refresh]').click(); await page.waitForTimeout(100);
  const routes = ['dashboard', 'device/customize', 'device/performance', 'device/power', 'device/calibration', 'device/advanced', 'settings', 'macros', 'profiles', 'catalog', 'catalog/keyboard', 'review'];
  for (const locale of ['en', 'vi']) {
    await go('#settings'); await page.locator('#language-select').selectOption(locale);
    for (const [width, height] of [[1440, 900], [1280, 800], [768, 1024], [390, 844]]) {
      await page.setViewportSize({ width, height });
      for (const route of routes) {
        await go(`#${route}`); await page.evaluate(() => scrollTo(0, 0));
        const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth, h1: document.querySelectorAll('h1').length, unlabelled: [...document.querySelectorAll('input,select,textarea')].filter(e => !e.getAttribute('aria-label') && !e.labels?.length).length }));
        assert.equal(dimensions.scroll, dimensions.width, `horizontal overflow ${width}/${locale}/${route}`); assert.equal(dimensions.h1, 1); assert.equal(dimensions.unlabelled, 0);
        const file = `${locale}-${width}-${route.replace('/', '-')}.png`; await page.screenshot({ path: new URL(file, output).pathname.replace(/^\/([A-Z]:)/, '$1'), fullPage: true }); screenshots.push(file);
      }
    }
  }
  await check('macro editor fits a phone and supports keyboard selection and reorder', async () => {
    await go('#settings'); await page.locator('#language-select').selectOption('en'); await page.setViewportSize({ width: 390, height: 844 }); await go('#macros');
    await page.locator('[data-macro-action=create]').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'macro-name');
    await page.locator('#macro-name').fill('Phone edit'); await page.locator('#macro-name').press('Tab');
    await page.locator('#macro-insert-trigger').click(); await page.locator('[data-macro-action=add-key]').click();
    await page.locator('[data-event-field=input]').fill('Q');
    await page.locator('#macro-insert-trigger').click(); await page.locator('[data-macro-action=add-delay]').click();
    assert.equal(await page.locator('.macro-event').count(), 2);
    const libraryPicker = page.locator('.macro-library-picker'); assert.equal(await libraryPicker.evaluate(node => node.open), false);
    await page.setViewportSize({ width: 1440, height: 900 }); assert.equal(await libraryPicker.locator('summary').isVisible(), true);
    await libraryPicker.locator('summary').click(); await capture('macro-editor-desktop.png');
    await page.setViewportSize({ width: 390, height: 844 }); await go('#settings'); await go('#macros');
    if (await libraryPicker.evaluate(node => node.open)) await libraryPicker.locator('summary').click();
    assert.equal(await libraryPicker.evaluate(node => node.open), false); await capture('macro-editor-mobile.png');
    await page.locator('.macro-event').nth(0).focus(); await page.locator('.macro-event').nth(0).press('ArrowDown');
    assert.equal(await page.locator('.macro-event').nth(1).getAttribute('aria-pressed'), 'true');
    await page.locator('.macro-event').nth(1).press('Alt+ArrowUp');
    assert.match(await page.locator('.macro-event').first().getAttribute('aria-label'), /^1\. Delay/);
    assert.equal(await libraryPicker.evaluate(node => node.open), false);
    await libraryPicker.locator('summary').click(); await page.locator('#macro-search').fill('missing');
    assert.equal(await page.locator('.macro-choice-item:visible').count(), 0);
    await page.locator('#macro-search').fill('Phone'); assert.equal(await page.locator('.macro-choice-item:visible').count(), 1);
    const choice = page.locator('.macro-choice').first(); await choice.focus(); await page.keyboard.press('Enter');
    assert.equal(await libraryPicker.evaluate(node => node.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.id), await choice.getAttribute('id'));
    assert.equal(await page.locator('.macro-choice-item:visible').count(), 1);
    await page.locator('[data-macro-action=save]').click();
    assert.equal(await page.evaluate(() => document.activeElement.id), 'save-macros');
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    assert.deepEqual(dimensions, { width: 390, scroll: 390 });
  });
  await check('mobile navigation, focus trap, Escape and reduced motion', async () => {
    await page.setViewportSize({ width: 568, height: 320 }); await page.locator('#menu-toggle').click();
    await page.locator('#main-nav [data-nav=settings]').click(); await page.locator('#language-select').waitFor();
    assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#menu-toggle').click(); assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'true');
    await page.keyboard.press('Escape'); assert.equal(await page.locator('#menu-toggle').getAttribute('aria-expanded'), 'false');
    await page.emulateMedia({ reducedMotion: 'reduce' }); await go('#device/performance');
    await page.locator('#section-performance').focus(); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await page.waitForTimeout(100);
    assert.equal(await page.locator('#section-advanced').getAttribute('aria-current'), 'location');
  });
  await check('empty inventory, loading and offline states have actions', async () => {
    await go('#settings'); await page.locator('#language-select').selectOption('en'); await go('#dashboard');
    snapshot = { ...fixture(), devices: [], connected: false, settings: [] };
    await page.locator('[data-action=refresh]').click(); await page.getByRole('heading', { name: 'No Razer devices detected' }).waitFor(); await capture('state-empty.png');
    delayRead = 800; await page.locator('[data-action=refresh]').click(); await capture('state-loading.png');
    await page.waitForFunction(() => !document.querySelector('[data-action=refresh]').disabled); delayRead = 0;
    offline = true; await page.locator('[data-action=refresh]').click(); await page.getByRole('heading', { name: 'Connect your Windows companion' }).waitFor(); await capture('state-offline.png');
  });
  assert.deepEqual(errors, []); checks.push('96 bilingual viewport/route screenshots: no overflow, one h1, all inputs labelled');
  writeFileSync(new URL('browser-report.json', output), JSON.stringify({ checks, writes: writes.map(({ id, deviceId }) => ({ id, deviceId })), screenshots, pageErrors: errors }, null, 2));
  process.stdout.write(`PASS ${checks.length} checks; ${screenshots.length} screenshots; 0 page errors\n`);
} catch (error) {
  process.stderr.write(`${await page.url()}\n${await page.locator('body').innerText()}\nPage errors: ${JSON.stringify(errors)}\n`);
  await page.screenshot({ path: new URL('failure.png', output).pathname.replace(/^\/([A-Z]:)/, '$1'), fullPage: true });
  throw error;
} finally { await browser.close(); }
