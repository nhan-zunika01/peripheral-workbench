import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const driver = fileURLToPath(import.meta.url), moduleRoot = resolve(dirname(driver), '..');

export function parseOptions(args, cwd = process.cwd(), env = process.env) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i], value = args[++i];
    if (!['--output', '--source-root'].includes(name) || options[name] || !value || value.startsWith('--')) {
      throw new Error('Usage: node scripts/benchmark-macros.mjs --output NEW_DIRECTORY [--source-root DIRECTORY]');
    }
    options[name] = value;
  }
  if (!options['--output']) throw new Error('--output NEW_DIRECTORY is required');
  const number = (name, fallback, minimum) => {
    const raw = env[name] ?? String(fallback), value = Number(raw);
    if (!String(raw).trim() || !Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
    return value;
  };
  const warmup = number('MACRO_WARMUP', 20, 0), count = number('MACRO_SAMPLES', 100, 1), rounds = number('MACRO_ROUNDS', 3, 1);
  if (!Number.isSafeInteger(warmup + count)) throw new Error('Invalid MACRO_WARMUP or MACRO_SAMPLES');
  return { output: resolve(cwd, options['--output']), sourceRoot: options['--source-root'] ? resolve(cwd, options['--source-root']) : moduleRoot, warmup, count, rounds };
}

export const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
export const summary = samples => {
  const values = samples.map(s => s.ms), errorCounts = {};
  for (const sample of samples) if (sample.error) errorCounts[sample.error] = (errorCounts[sample.error] || 0) + 1;
  return { n: values.length, errors: errorCounts, ...(values.length >= 100 ? { p50: percentile(values, 0.50), p95: percentile(values, 0.95), p99: percentile(values, 0.99) } : {}), min: Math.min(...values), max: Math.max(...values) };
};

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

export async function captureSource(root) {
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'public', 'package-lock.json', 'package.json'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const entries = await Promise.all(files.map(async file => [file, await readFile(resolve(root, file))]));
  return {
    hashes: Object.fromEntries(entries.map(([file, bytes]) => [file, sha(bytes)])),
    publicFiles: new Map(entries.filter(([file]) => file.startsWith('public/')).map(([file, bytes]) => [file.slice('public'.length), bytes]))
  };
}

export function createBenchmarkServer(snapshot) {
  return createServer((request, response) => {
    let pathname;
    try { pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname); }
    catch { response.writeHead(404).end(); return; }
    if (pathname === '/bench') { response.writeHead(200, { 'Content-Type': 'text/html' }).end('<!doctype html><title>Isolated macro benchmark</title>'); return; }
    const file = pathname === '/' ? '/index.html' : pathname, data = snapshot.publicFiles.get(file);
    if (!data) { response.writeHead(404).end(); return; }
    response.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream' }).end(data);
  });
}

export async function isolatedContext(browser, base, report, redact = String) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await ctx.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === base) return route.continue();
    report.blockedOrigins[url.origin] = (report.blockedOrigins[url.origin] || 0) + 1;
    return route.abort('blockedbyclient');
  });
  await ctx.routeWebSocket('**/*', ws => ws.close());
  ctx.on('page', page => page.on('pageerror', error => report.errors.push({ kind: 'pageerror', message: redact(error.message) })));
  return ctx;
}

async function main() {
const { output, sourceRoot: root, warmup, count, rounds } = parseOptions(process.argv.slice(2));
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const { chromium } = await import('playwright');
const require = createRequire(import.meta.url);
const playwrightPackage = await readFile(require.resolve('playwright/package.json'));
const vector = Array.from({ length: 100 }, (_, i) => i + 1);
assert.equal(percentile(vector, 0.95), 95); assert.equal(percentile(vector, 0.99), 99);
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const command = (exe, args) => { try { return execFileSync(exe, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return 'unavailable'; } };
const npm = process.platform === 'win32' ? command(process.execPath, [resolve(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), '--version']) : command('npm', ['--version']);
const snapshot = await captureSource(root), hashes = snapshot.hashes;
hashes['benchmark-script'] = sha(await readFile(driver));
const driverCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: moduleRoot, encoding: 'utf8' }).trim();
const driverPackageLockSha256 = root === moduleRoot ? hashes['package-lock.json'] : sha(await readFile(resolve(moduleRoot, 'package-lock.json')));
const redact = message => [driver, output, root, os.homedir()].reduce((value, path) => value.replaceAll(pathToFileURL(path).href, '[path]').replaceAll(path, '[path]').replaceAll(path.replaceAll('\\', '/'), '[path]'), String(message));
const report = {
  metadata: {
    commit: git('rev-parse', 'HEAD'), gitStatus: git('status', '--porcelain=v1'), hashes,
    date: new Date().toISOString(), node: process.version, npm,
    driverCommit, driverPackageLockSha256,
    playwright: JSON.parse(playwrightPackage).version, playwrightPackageJsonSha256: sha(playwrightPackage),
    chromiumBinarySha256: sha(await readFile(chromium.executablePath())),
    os: `${os.type()} ${os.release()} ${os.arch()}`, cpu: os.cpus()[0]?.model,
    logicalProcessors: os.cpus().length, ramBytes: os.totalmem(),
    powerScheme: command('powercfg.exe', ['/getactivescheme']),
    battery: command('powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Battery | Select-Object BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress']),
    warmup, count, rounds,
    units: 'milliseconds, performance.now; error samples retained',
    method: 'Playwright bundled full Chromium in a fresh ephemeral browser context; localhost HTTP serves the captured public source bytes and ignores later disk changes; all other HTTP requests aborted. Synthetic input and hashchange events exercise actual app handlers, input-to-frame ends at the next animation frame before paint. Native storage uses a real isolated-origin localStorage; library microbench uses a fake initial read and writer access, not the Web Locks app policy. UI uses real Web Locks. Warmups precede every stage.',
    cases: '0, 1, or 100 macros; every macro has 500 key events and maximum valid names/inputs; escaped case uses lone U+D800 code units.',
    limits: 'No hardware, companion, browser default profile, or production storage.'
  }, results: [], errors: [], blockedOrigins: {}
};
const server = createBenchmarkServer(snapshot);
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
assert.notEqual(server.address().port, 17321);
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ executablePath: chromium.executablePath(), headless: true }).catch(async error => {
  await new Promise(resolveClose => server.close(resolveClose));
  throw error;
});
report.metadata.browserVersion = browser.version(); report.metadata.origin = base;
async function save() {
  report.metadata.updated = new Date().toISOString();
  await writeFile(resolve(output, 'raw.json'), JSON.stringify(report, null, 2));
}
const cases = [{ size: 0, charset: 'ascii' }, ...[1, 100].flatMap(size => ['ascii', 'escaped'].map(charset => ({ size, charset })))];
try {
  for (let round = 1; round <= rounds; round++) for (const scenario of cases) {
    console.log(`round ${round}/${rounds}: ${scenario.size} macros ${scenario.charset}`);
    const ctx = await isolatedContext(browser, base, report, redact), page = await ctx.newPage();
    try {
      await page.goto(`${base}/bench`);
      const micro = await page.evaluate(async ({ size, charset, warmup, count }) => {
        const { createMacroLibrary, parseMacroImport, macroStorageKey, macroLimits } = await import('/macros.js');
        const assert = (condition, message) => { if (!condition) throw new Error(message); };
        const char = charset === 'escaped' ? '\ud800' : 'A';
        const document = { version: 1, macros: Array.from({ length: size }, () => ({ name: char.repeat(64), events: Array.from({ length: 500 }, () => ({ kind: 'key', input: char.repeat(32), action: 'down', delayMs: 60000 })) })) };
        const pretty = JSON.stringify(document, null, 2), bytes = new TextEncoder().encode(pretty).length;
        assert(document.macros.length === size && document.macros.every(m => m.name.length === 64 && m.events.length === 500 && m.events.every(e => e.input.length === 32)), 'fixture shape');
        assert(bytes <= macroLimits.importBytes, 'fixture exceeds import limit');
        if (size === 100 && charset === 'escaped') assert(bytes === 15844036, 'wrong escaped maximum bytes');
        const withIds = () => ({ version: 1, macros: document.macros.map((m, i) => ({ id: `macro-${i}`, name: m.name, events: m.events })) });
        const storageValue = JSON.stringify(withIds());
        if (size) document.macros[0].name = 'B' + char.repeat(63);
        const alternateValue = JSON.stringify(withIds());
        if (size) document.macros[0].name = char.repeat(64);
        let stored = storageValue;
        const memory = { getItem: () => stored, setItem: (key, value) => { stored = value; } };
        const fake = createMacroLibrary(memory, { access: 'writer' });
        assert(fake.writable && fake.macros.length === size, 'fake writer setup');
        const native = createMacroLibrary({ getItem: () => storageValue, setItem: (key, value) => localStorage.setItem(key, value) }, { access: 'writer' });
        assert(native.writable && native.macros.length === size, 'native writer setup');
        const imported = parseMacroImport(pretty);
        assert(imported.length === size && new Set(imported.map(m => m.id)).size === size, 'parse result');
        assert(JSON.stringify(imported.map(({ name, events }) => ({ name, events }))) === JSON.stringify(document.macros), 'parse roundtrip');
        assert(fake.export() === pretty, 'library export fixture mismatch');
        const result = {}, longTasks = [], intervals = [];
        const longTaskSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
        const observer = longTaskSupported ? new PerformanceObserver(list => list.getEntries().forEach(e => longTasks.push({ startTime: e.startTime, duration: e.duration }))) : null;
        observer?.observe({ type: 'longtask', buffered: false });
        const wait = () => new Promise(resolveWait => setTimeout(resolveWait, 0));
        async function measure(name, action) {
          const samples = [], start = performance.now();
          for (let i = 0; i < warmup + count; i++) {
            const t = performance.now(); let error = null;
            try { error = action(i) || null; } catch (e) { error = `${e.name}: ${e.message}`; }
            const elapsed = performance.now() - t;
            if (i >= warmup) samples.push({ ms: elapsed, error });
            await wait();
          }
          intervals.push({ phase: name, start, end: performance.now() }); result[name] = samples;
        }
        await measure('parseMacroImport', () => { if (parseMacroImport(pretty).length !== size) return 'unexpected parsed count'; });
        await measure('JSON.stringify storage compact', () => { if (!JSON.stringify(withIds()).length) return 'empty stringify'; });
        await measure('JSON.stringify export pretty', () => { if (!JSON.stringify(document, null, 2).length) return 'empty stringify'; });
        await measure('library.export fake writer', () => { if (!fake.export().length) return 'empty export'; });
        await measure('library.save fake storage', i => {
          if (size) fake.macros[0].name = (i % 2 ? 'B' : 'C') + char.repeat(63);
          if (!fake.save()) return fake.error || 'save returned false';
        });
        await measure('localStorage.setItem native', i => {
          try { localStorage.setItem(macroStorageKey, i % 2 ? storageValue : alternateValue); }
          catch (error) { return `${error.name}: ${error.message}`; }
        });
        await measure('library.save native storage', i => {
          if (size) native.macros[0].name = (i % 2 ? 'B' : 'C') + char.repeat(63);
          if (!native.save()) return native.error || 'save returned false';
        });
        await wait(); await wait(); observer?.disconnect();
        return { bytes, storageBytes: new TextEncoder().encode(storageValue).length, longTaskSupported, longTasks, intervals, samples: result };
      }, { ...scenario, warmup, count });
      const uiPage = await ctx.newPage();
      await uiPage.goto(`${base}/bench`);
      await uiPage.evaluate(() => localStorage.setItem('device-control-macros-v1', '{"version":1,"macros":[]}'));
      await uiPage.goto(`${base}/#macros`);
      await uiPage.waitForFunction(async () => !!document.querySelector('#macro-create') && !document.querySelector('#macro-create').disabled && (await navigator.locks.query()).held.some(lock => lock.name === 'device-control-macros-v1'));
      assert.equal(await uiPage.evaluate(() => isSecureContext && typeof navigator.locks?.request === 'function'), true);
      if (scenario.size) {
        const fileBytes = await uiPage.evaluate(({ size, charset }) => {
          const char = charset === 'escaped' ? '\ud800' : 'A';
          const doc = { version: 1, macros: Array.from({ length: size }, () => ({ name: char.repeat(64), events: Array.from({ length: 500 }, () => ({ kind: 'key', input: char.repeat(32), action: 'down', delayMs: 60000 })) })) };
          const file = new File([JSON.stringify(doc, null, 2)], 'fixture.json', { type: 'application/json' });
          const transfer = new DataTransfer(); transfer.items.add(file);
          const picker = document.querySelector('#macro-import'); picker.files = transfer.files; picker.dispatchEvent(new Event('change', { bubbles: true }));
          return file.size;
        }, scenario);
        assert.equal(fileBytes, micro.bytes);
        await uiPage.waitForFunction(n => document.querySelectorAll('.macro-choice').length === n, scenario.size, { timeout: 60000 });
        assert.equal(await uiPage.locator('.macro-event').count(), 500);
        await uiPage.locator('#macro-name').fill('N'.repeat(64));
        await uiPage.locator('#macro-event-input').fill('K'.repeat(32));
        await uiPage.locator('#macro-event-delay').fill('59999');
        assert.equal(await uiPage.locator('#macro-event-delay').getAttribute('aria-invalid'), null);
      }
      const ui = await uiPage.evaluate(async ({ size, warmup, count }) => {
        const samples = {}, longTasks = [], intervals = [];
        const supported = PerformanceObserver.supportedEntryTypes.includes('longtask');
        const observer = supported ? new PerformanceObserver(list => list.getEntries().forEach(e => longTasks.push({ startTime: e.startTime, duration: e.duration }))) : null;
        observer?.observe({ type: 'longtask', buffered: false });
        const frame = () => new Promise(resolveFrame => requestAnimationFrame(resolveFrame));
        async function measure(name, action) {
          const sync = [], toFrame = [], start = performance.now();
          for (let i = 0; i < warmup + count; i++) {
            const t = performance.now(); action(i);
            if (name === 'render') document.querySelector('#view').getBoundingClientRect();
            const after = performance.now(); await frame();
            const end = performance.now();
            const invalid = document.querySelector('[aria-invalid=true]');
            if (invalid) throw new Error(`${name}: invalid ${invalid.id}`);
            const text = document.querySelector('#macro-status')?.textContent || '';
            const error = /could not save|không thể lưu/i.test(text) ? 'macroStorageWrite (UI status)' : null;
            if (i >= warmup) { sync.push({ ms: after - t, error }); toFrame.push({ ms: end - t, error }); }
          }
          intervals.push({ phase: name, start, end: performance.now() });
          samples[`${name}: handler${name === 'render' ? ' and layout' : ''}`] = sync;
          samples[`${name}: until next animation frame`] = toFrame;
        }
        await measure('render', () => dispatchEvent(new HashChangeEvent('hashchange')));
        if (size) {
          const edit = (id, value) => { const node = document.getElementById(id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); };
          await measure('name input', i => edit('macro-name', 'N'.repeat(63) + (i % 2 ? 'A' : 'B')));
          await measure('key input', i => edit('macro-event-input', 'K'.repeat(31) + (i % 2 ? 'A' : 'B')));
          await measure('delay input', i => edit('macro-event-delay', i % 2 ? '59999' : '60000'));
        }
        await frame(); await frame(); observer?.disconnect();
        return { longTaskSupported: supported, longTasks, intervals, status: document.querySelector('#macro-status')?.textContent, samples };
      }, { ...scenario, warmup, count });
      const row = { round, ...scenario, micro, ui };
      row.summary = Object.fromEntries([...Object.entries(micro.samples).map(([name, samples]) => [`micro: ${name}`, summary(samples)]), ...Object.entries(ui.samples).map(([name, samples]) => [`UI: ${name}`, summary(samples)])]);
      report.results.push(row); await save();
      for (const [name, samples] of Object.entries(micro.samples)) {
        const failures = samples.filter(sample => sample.error);
        if (name === 'localStorage.setItem native') assert.ok(failures.every(sample => sample.error.startsWith('QuotaExceededError:')), `${name}: unexpected failure`);
        else if (name === 'library.save native storage') assert.ok(failures.every(sample => sample.error === 'macroStorageWrite'), `${name}: unexpected failure`);
        else assert.equal(failures.length, 0, `${name}: unexpected failure`);
      }
      for (const samples of Object.values(ui.samples)) assert.ok(samples.every(sample => !sample.error || sample.error === 'macroStorageWrite (UI status)'), 'unexpected UI failure');
      if (scenario.size === 100 && scenario.charset === 'escaped') {
        assert.equal(micro.samples['localStorage.setItem native'].filter(sample => sample.error).length, count);
        assert.equal(micro.samples['library.save native storage'].filter(sample => sample.error).length, count);
        assert.match(ui.status, /could not save|không thể lưu/i);
      }
      const percentiles = count >= 100 ? `max p95 ${Math.max(...Object.values(row.summary).map(s => s.p95 || 0)).toFixed(1)} ms` : 'percentiles omitted for fewer than 100 samples';
      console.log(`  saved: ${micro.bytes} bytes; ${percentiles}; status ${ui.status}`);
    } finally { await ctx.close(); }
  }
  assert.equal(report.results.length, rounds * cases.length);
  assert.equal(report.errors.length, 0, JSON.stringify(report.errors));
  await save();
} catch (error) {
  report.errors.push({ kind: 'fatal', message: redact(error.stack || String(error)) });
  await save(); throw error;
} finally {
  await browser.close(); await new Promise(resolveClose => server.close(resolveClose));
}
console.log(`completed ${report.results.length} configurations, ${output}/raw.json`);
}

if (process.argv[1] && resolve(process.argv[1]) === driver) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
