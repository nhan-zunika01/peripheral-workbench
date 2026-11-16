import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, sep, extname } from 'node:path';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const key = 'device-control-macros-v1', checks = [];
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/away') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><title>Away</title>'); return; }
  const file = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
  if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) { response.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    response.setHeader('Content-Type', { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, ignoreDefaultArgs: ['--disable-back-forward-cache'], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const contexts = [], errors = [];
async function context(init) {
  const value = await browser.newContext({ acceptDownloads: true }); contexts.push(value);
  if (init) await value.addInitScript(init);
  await value.route('http://127.0.0.1:17321/**', route => route.abort());
  value.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  return value;
}
async function open(context) {
  const page = await context.newPage(); await page.goto(`${base}/#macros`);
  await page.locator('#macro-status').waitFor(); return page;
}
const saved = page => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
const writable = page => page.waitForFunction(() => !document.querySelector('#macro-create').disabled);
const check = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
try {
  await check('focused name and delay drafts survive lifecycle restore', async () => {
    for (const field of ['name', 'delay']) {
      const shared = await context(), a = await open(shared); await writable(a);
      await a.evaluate(() => {
        const native = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key === 'device-control-macros-v1') throw new DOMException('Full', 'QuotaExceededError');
          return native.call(this, key, value);
        };
      });
      await a.locator('#macro-create').click();
      let selector, expected;
      if (field === 'name') { selector = '#macro-name'; expected = 'Unsaved field edit'; }
      else {
        await a.locator('#macro-insert-trigger').click(); await a.locator('[data-macro-action=add-key]').click();
        await a.locator('#macro-event-input').fill('A'); selector = '#macro-event-delay'; expected = '4321';
      }
      await a.locator(selector).fill(expected);
      await a.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
      await a.waitForFunction(async () => !(await navigator.locks.query()).held.some(lock => lock.name === 'device-control-macros-v1'));
      const b = await open(shared); await writable(b);
      await a.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
      await a.waitForFunction(() => /Export this tab/.test(document.querySelector('#macro-status').textContent));
      assert.equal(await a.locator(selector).inputValue(), expected, field);
      const downloading = a.waitForEvent('download'); await a.locator('[data-macro-action=export]').click();
      const chunks = []; for await (const chunk of await (await downloading).createReadStream()) chunks.push(chunk);
      const macro = JSON.parse(Buffer.concat(chunks).toString()).macros[0];
      assert.equal(field === 'name' ? macro.name : macro.events[0].delayMs, field === 'name' ? expected : Number(expected));
      await shared.close();
    }
  });
  await check('valid inline edits persist without losing focus, and invalid values are not saved', async () => {
    const shared = await context(), page = await open(shared); await writable(page); await page.locator('#macro-create').click();
    const name = page.locator('#macro-name');
    await name.fill('Inline name'); await name.evaluate(input => { globalThis.nameBeforeInput = input; input.setSelectionRange(2, 4); });
    await name.press('X');
    assert.equal(await name.evaluate(input => input === globalThis.nameBeforeInput && document.activeElement === input && input.selectionStart === 3), true);
    assert.equal((await saved(page)).macros[0].name, 'InXne name');
    await name.fill('');
    assert.equal((await saved(page)).macros[0].name, 'InXne name');
    assert.match(await page.locator('#macro-status').textContent(), /Check the macro name/);
    assert.doesNotMatch(await page.locator('#macro-status').textContent(), /Macro data saved in this browser/);
    await name.fill('Valid');
    await page.locator('#macro-insert-trigger').click(); await page.locator('[data-macro-action=add-delay]').click();
    const delay = page.locator('#macro-event-delay'); await delay.fill('4321');
    assert.equal((await saved(page)).macros[0].events[0].delayMs, 4321);
    assert.equal(await delay.evaluate(input => document.activeElement === input), true);
    await delay.fill('60001');
    assert.equal((await saved(page)).macros[0].events[0].delayMs, 4321);
    assert.match(await page.locator('#macro-status').textContent(), /Check the macro name/);
    assert.doesNotMatch(await page.locator('#macro-status').textContent(), /Macro data saved in this browser/);
    await name.fill('Another valid name');
    assert.equal(await delay.getAttribute('aria-invalid'), 'true');
    assert.match(await page.locator('#macro-status').textContent(), /Check the macro name/);
    assert.doesNotMatch(await page.locator('#macro-status').textContent(), /Macro data saved in this browser/);
    assert.equal(await page.locator('[data-macro-action=export]').isDisabled(), true);
    assert.equal(await page.locator('[data-macro-action=save]').isDisabled(), true);
    assert.equal((await saved(page)).macros[0].events[0].delayMs, 4321);
    await delay.fill('42');
    assert.match(await page.locator('#macro-status').textContent(), /Macro data saved in this browser/);
    assert.equal(await page.locator('[data-macro-action=export]').isEnabled(), true);
    await name.fill(''); await delay.fill('43');
    assert.equal(await name.getAttribute('aria-invalid'), 'true');
    assert.match(await page.locator('#macro-status').textContent(), /Check the macro name/);
    assert.doesNotMatch(await page.locator('#macro-status').textContent(), /Macro data saved in this browser/);
    assert.equal(await page.locator('[data-macro-action=export]').isDisabled(), true);
    assert.equal(await page.locator('[data-macro-action=save]').isDisabled(), true);
    await name.fill('Fixed');
    assert.match(await page.locator('#macro-status').textContent(), /Macro data saved in this browser/);
    assert.equal(await page.locator('[data-macro-action=save]').isEnabled(), true);
    await page.locator('#macro-insert-trigger').click(); await page.locator('[data-macro-action=add-key]').click();
    const keyInput = page.locator('#macro-event-input'), keyDelay = page.locator('#macro-event-delay'), keyCard = page.locator('#macro-event-1');
    await keyInput.fill('A'); await keyDelay.fill('4321'); await keyInput.fill('B');
    assert.match(await keyCard.locator('.macro-event-delay').textContent(), /4321 ms/);
    assert.match(await keyCard.getAttribute('aria-label'), /B, 4321 ms/);
    await keyInput.fill('C'); await keyDelay.fill('22');
    assert.match(await keyCard.locator('.macro-event-delay').textContent(), /22 ms/);
    assert.match(await keyCard.getAttribute('aria-label'), /C, 22 ms/);
    await keyDelay.fill('60001'); await keyInput.fill('D');
    assert.match(await keyCard.locator('.macro-event-delay').textContent(), /22 ms/);
    assert.match(await keyCard.getAttribute('aria-label'), /D, 22 ms/);
    await shared.close();
  });
  await check('retry rereads storage after a transient failure while keeping the lock', async () => {
    const shared = await context(() => {
      const native = Storage.prototype.getItem; globalThis.blockMacroRead = true;
      Storage.prototype.getItem = function(key) {
        if (key === 'device-control-macros-v1' && globalThis.blockMacroRead) throw new DOMException('Blocked', 'SecurityError');
        return native.call(this, key);
      };
    });
    const page = await open(shared);
    await page.waitForFunction(() => /Could not read macro data/.test(document.querySelector('#macro-status').textContent));
    await page.evaluate(() => { globalThis.blockMacroRead = false; });
    await page.locator('#macro-try-writer').click();
    await page.waitForFunction(() => !document.querySelector('#macro-try-writer'));
    await page.locator('#macro-create').click();
    assert.equal((await saved(page)).macros.length, 1);
    await shared.close();
  });
  await check('a failed backup does not expose the only draft to lifecycle replacement', async () => {
    const shared = await context(), page = await open(shared); await writable(page);
    await page.evaluate(() => {
      const native = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'device-control-macros-v1') throw new DOMException('Full', 'QuotaExceededError');
        return native.call(this, key, value);
      };
      URL.createObjectURL = () => { throw new Error('Cannot create download'); };
    });
    await page.locator('#macro-create').click();
    await page.locator('#macro-name').fill('Only unsaved copy'); await page.locator('#macro-name').press('Tab');
    await page.locator('[data-macro-action=export]').click();
    assert.match(await page.locator('#macro-status').textContent(), /Could not create the macro backup/);
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await page.waitForFunction(async () => !(await navigator.locks.query()).held.some(lock => lock.name === 'device-control-macros-v1'));
    await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.waitForFunction(() => /Export this tab|Macro data saved/i.test(document.querySelector('#macro-status').textContent));
    assert.equal(await page.locator('.macro-choice').count(), 1);
    assert.equal(await page.locator('#macro-name').inputValue(), 'Only unsaved copy');
    await shared.close();
  });
  await check('a follower retains search focus and selection and unrelated settings controls', async () => {
    const shared = await context(), a = await open(shared); await writable(a);
    await a.locator('#macro-create').click();
    const b = await open(shared); await b.waitForFunction(() => document.querySelector('#macro-create').disabled);
    await b.locator('#macro-search').fill('New');
    await b.locator('#macro-search').evaluate(input => input.setSelectionRange(1, 2));
    await a.locator('#macro-name').fill('New writer name'); await a.locator('#macro-name').press('Tab');
    await b.locator('.macro-choice').filter({ hasText: 'New writer name' }).waitFor();
    assert.deepEqual(await b.locator('#macro-search').evaluate(input => [document.activeElement === input, input.selectionStart, input.selectionEnd]), [true, 1, 2]);
    await b.evaluate(() => { location.hash = '#settings'; });
    await b.locator('#language-select').focus();
    await b.evaluate(() => { globalThis.originalLanguage = document.querySelector('#language-select'); globalThis.macroUpdate = false; addEventListener('storage', () => { globalThis.macroUpdate = true; }, { once: true }); });
    await a.locator('#macro-name').fill('Newer writer name'); await a.locator('#macro-name').press('Tab');
    await b.waitForFunction(() => globalThis.macroUpdate);
    assert.equal(await b.evaluate(() => document.activeElement === globalThis.originalLanguage && globalThis.originalLanguage.isConnected), true);
    await b.evaluate(() => { location.hash = '#profiles'; });
    await b.locator('.profiles-page').waitFor();
    await b.evaluate(() => { globalThis.originalProfiles = document.querySelector('.profiles-page'); });
    await a.close();
    await b.waitForFunction(async () => !(await navigator.locks.query()).held.some(lock => lock.name === 'device-control-macros-v1'));
    await b.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await b.waitForFunction(() => /Macro data saved in this browser/.test(document.querySelector('#profile-macro-status').textContent));
    assert.equal(await b.evaluate(() => globalThis.originalProfiles.isConnected), true);
    await shared.close();
  });
  await check('private browser context: one real Web Lock, storage events, close and takeover', async () => {
    const shared = await context(), a = await open(shared); await writable(a);
    assert.equal(await a.evaluate(() => isSecureContext && !!navigator.locks), true);
    const b = await open(shared);
    await b.waitForFunction(() => document.querySelector('#macro-create').disabled);
    await a.locator('#macro-create').click();
    await a.locator('#macro-name').fill('From writer A'); await a.locator('#macro-name').press('Tab');
    await b.locator('.macro-choice').filter({ hasText: 'From writer A' }).waitFor();
    assert.equal(await b.locator('#macro-name').isDisabled(), true);
    const first = (await saved(a)).macros[0].id;
    await a.close(); await b.locator('#macro-try-writer').click(); await writable(b);
    assert.equal((await saved(b)).macros[0].id, first);
    await b.locator('#macro-create').click(); assert.equal((await saved(b)).macros.length, 2);
    await shared.close();
  });
  await check('renderer crash releases the lock for another page', async () => {
    const shared = await context(), a = await open(shared); await writable(a);
    await a.locator('#macro-create').click(); const b = await open(shared);
    await b.waitForFunction(() => document.querySelector('#macro-create').disabled);
    const crashed = a.waitForEvent('crash');
    const session = await shared.newCDPSession(a); session.send('Page.crash').catch(() => {}); await crashed;
    await b.locator('#macro-try-writer').click(); await writable(b);
    assert.equal((await saved(b)).macros.length, 1);
    await shared.close();
  });
  await check('pagehide releases ownership and pageshow reloads before editing resumes', async () => {
    const shared = await context(), a = await open(shared); await writable(a);
    await a.locator('#macro-create').click(); const b = await open(shared);
    await a.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    await b.locator('#macro-try-writer').click(); await writable(b);
    await b.locator('#macro-create').click();
    await a.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await a.waitForFunction(() => document.querySelector('#macro-create').disabled);
    await b.close(); await a.locator('#macro-try-writer').click(); await writable(a);
    assert.equal(await a.locator('.macro-choice').count(), 2);
    await shared.close();
  });
  await check('missing or rejected Web Locks keeps edits in memory', async () => {
    for (const rejected of [false, true]) {
      const shared = await context(rejected
        ? () => Object.defineProperty(navigator, 'locks', { value: { request: () => Promise.reject(new Error('blocked')) } })
        : () => Object.defineProperty(navigator, 'locks', { value: undefined }));
      const page = await open(shared); await writable(page); await page.locator('#macro-create').click();
      assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
      assert.equal(await page.locator('[data-macro-action=export]').isEnabled(), true);
      assert.match(await page.locator('#macro-status').textContent(), /exclusive|lock|độc quyền|khóa/i);
      await shared.close();
    }
  });
  await check('memory-only import errors stay visible alongside persistence status through a full render', async () => {
    const shared = await context(() => {
      Object.defineProperty(navigator, 'locks', { value: undefined });
      const original = File.prototype.text;
      File.prototype.text = async function() { const value = await original.call(this); globalThis.macroReadComplete = true; return value; };
    });
    const page = await open(shared); await writable(page);
    for (const [name, buffer, expected] of [
      ['broken', Buffer.from('{broken'), 'Enter valid JSON.'],
      ['oversized', Buffer.alloc(32_000_001, 32), 'The import file is too large.']
    ]) {
      await page.locator('#macro-import').setInputFiles({ name: `${name}.json`, mimeType: 'application/json', buffer });
      if (name === 'broken') await page.waitForFunction(() => globalThis.macroReadComplete);
      assert.ok((await page.locator('#macro-status').textContent()).includes(expected), `${name} error must be visible`);
      assert.match(await page.locator('#macro-status').textContent(), /Changes stay in this tab only/);
      await page.evaluate(() => { location.hash = '#profiles'; });
      await page.locator('.profiles-page').waitFor();
      await page.evaluate(() => { location.hash = '#macros'; });
      await page.locator('#macro-status').waitFor();
      assert.ok((await page.locator('#macro-status').textContent()).includes(expected), `${name} error must survive a full render`);
      assert.match(await page.locator('#macro-status').textContent(), /Changes stay in this tab only/);
    }
    assert.equal(await page.evaluate(key => localStorage.getItem(key), key), null);
    await shared.close();
  });
  await check('a restored incomplete quota draft can be repaired and backed up while another tab owns storage', async () => {
    const shared = await context(), a = await open(shared); await writable(a);
    await a.evaluate(() => {
      const native = Storage.prototype.setItem; globalThis.failedMacroWrites = 0;
      Storage.prototype.setItem = function(key, value) {
        if (key === 'device-control-macros-v1') { globalThis.failedMacroWrites++; throw new DOMException('Full', 'QuotaExceededError'); }
        return native.call(this, key, value);
      };
    });
    await a.locator('#macro-create').click();
    await a.locator('#macro-insert-trigger').click(); await a.locator('[data-macro-action=add-key]').click();
    assert.equal(await a.locator('[data-macro-action=export]').isDisabled(), true);
    const writes = await a.evaluate(() => globalThis.failedMacroWrites);
    await a.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    const b = await open(shared); await writable(b); await b.locator('#macro-create').click();
    await b.locator('#macro-name').fill('Other writer'); await b.locator('#macro-name').press('Tab');
    await a.evaluate(() => dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await a.waitForFunction(() => /export|xuất/i.test(document.querySelector('#macro-status').textContent));
    assert.equal(await a.locator('#macro-event-input').isEnabled(), true, 'restore must keep the draft repairable');
    await a.locator('#macro-event-input').fill('Repaired');
    assert.equal(await a.locator('[data-macro-action=save]').isDisabled(), true);
    assert.equal(await a.evaluate(() => globalThis.failedMacroWrites), writes);
    assert.equal((await saved(b)).macros[0].name, 'Other writer');
    const downloading = a.waitForEvent('download'); await a.locator('[data-macro-action=export]').click();
    const stream = await (await downloading).createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).macros[0].events[0].input, 'Repaired');
    await b.close(); await a.locator('#macro-try-writer').click();
    await a.locator('#confirmation[open]').waitFor(); await a.locator('#dialog-cancel').click();
    assert.equal(await a.locator('#macro-event-input').inputValue(), 'Repaired');
    await a.locator('#macro-try-writer').click(); await a.locator('#dialog-confirm').click();
    await a.waitForFunction(() => document.querySelector('#macro-name').value === 'Other writer');
    assert.equal(await a.evaluate(() => globalThis.failedMacroWrites), writes);
    await shared.close();
  });
  await check('back navigation reacquires ownership and reloads the other writer', async () => {
    const shared = await context(), a = await open(shared); await writable(a);
    await a.locator('#macro-create').click(); const b = await open(shared);
    await a.goto(`${base}/away`);
    await b.locator('#macro-try-writer').click(); await writable(b); await b.locator('#macro-create').click();
    await b.close(); await a.goBack(); await writable(a);
    assert.equal(await a.locator('.macro-choice').count(), 2);
    await shared.close();
  });
  await check('blocked and corrupt storage never gets overwritten', async () => {
    for (const corrupt of [false, true]) {
      const shared = await context(corrupt
        ? () => { if (location.protocol === 'http:') localStorage.setItem('device-control-macros-v1', '{broken'); }
        : () => { const native = Storage.prototype.getItem; Storage.prototype.getItem = function(key) { if (key === 'device-control-macros-v1') throw new DOMException('Blocked', 'SecurityError'); return native.call(this, key); }; });
      const page = await open(shared); await writable(page); await page.locator('#macro-create').click();
      assert.match(await page.locator('#macro-status').textContent(), /read|đọc/i);
      assert.equal(await page.locator('[data-macro-action=export]').isEnabled(), true);
      if (corrupt) assert.equal(await page.evaluate(key => localStorage.getItem(key), key), '{broken');
      await shared.close();
    }
  });
  await check('picker imports and exports the full 100 × 500 Unicode library despite quota failure', async () => {
    const document = { version: 1, macros: Array.from({ length: 100 }, () => ({ name: '\ud800'.repeat(64), events: Array.from({ length: 500 }, () => ({ kind: 'key', input: '\ud800'.repeat(32), action: 'down', delayMs: 60000 })) })) };
    const backup = Buffer.from(JSON.stringify(document, null, 2)); assert.equal(backup.length, 15_844_036);
    const shared = await context(() => { if (location.protocol === 'http:') localStorage.setItem('device-control-macros-v1', '{"version":1,"macros":[]}'); });
    const page = await open(shared); await writable(page);
    await page.locator('#macro-import').setInputFiles({ name: 'maximum.json', mimeType: 'application/json', buffer: backup });
    await page.waitForFunction(() => document.querySelectorAll('.macro-choice').length === 100);
    assert.match(await page.locator('#macro-status').textContent(), /could not save|không thể lưu/i);
    assert.deepEqual(await saved(page), { version: 1, macros: [] });
    const download = page.waitForEvent('download'); await page.locator('[data-macro-action=export]').click();
    const stream = await (await download).createReadStream(), chunks = []; for await (const chunk of stream) chunks.push(chunk);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), document);
    assert.equal(await page.locator('#macro-name').evaluate(input => input.value.charCodeAt(0)), 0xd800);
    const other = await context(), target = await open(other); await writable(target);
    await target.locator('#macro-import').setInputFiles({ name: 'roundtrip.json', mimeType: 'application/json', buffer: Buffer.concat(chunks) });
    await target.waitForFunction(() => document.querySelectorAll('.macro-choice').length === 100);
    assert.equal(await target.locator('.macro-event').count(), 500);
    assert.notEqual(await page.locator('.macro-choice').first().getAttribute('data-macro-id'), await target.locator('.macro-choice').first().getAttribute('data-macro-id'));
    await shared.close(); await other.close();
  });
  await check('picker accepts exactly 32 MB and rejects the next byte before File.text', async () => {
    const shared = await context(), page = await open(shared); await writable(page);
    await page.evaluate(() => { globalThis.macroFileReads = 0; const text = File.prototype.text; File.prototype.text = function() { globalThis.macroFileReads++; return text.call(this); }; });
    const file = Buffer.alloc(32_000_001, 32); file.write('{"version":1,"macros":[]}');
    await page.locator('#macro-import').setInputFiles({ name: 'exact.json', mimeType: 'application/json', buffer: file.subarray(0, 32_000_000) });
    await page.waitForFunction(() => globalThis.macroFileReads === 1);
    await page.locator('#macro-import').setInputFiles({ name: 'over.json', mimeType: 'application/json', buffer: file });
    await page.waitForFunction(() => /too large|quá lớn/i.test(document.querySelector('#macro-status').textContent));
    assert.equal(await page.evaluate(() => globalThis.macroFileReads), 1);
    await shared.close();
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: checks.length, secureOrigin: base, errors }));
} finally {
  await Promise.all(contexts.map(context => context.close().catch(() => {})));
  await browser.close(); await new Promise(resolve => server.close(resolve));
}
