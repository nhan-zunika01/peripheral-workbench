import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(repo, 'scripts', 'benchmark-macros.mjs');
const tempPrefix = join(tmpdir(), 'macro-harness-test-');
const cleanEnv = { ...process.env };
delete cleanEnv.MACRO_WARMUP; delete cleanEnv.MACRO_SAMPLES; delete cleanEnv.MACRO_ROUNDS;
delete cleanEnv.NODE_TEST_CONTEXT;

async function withTemp(run) {
  const dir = await mkdtemp(tempPrefix);
  try { await run(dir); } finally {
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep));
    await rm(dir, { recursive: true, force: true });
  }
}

function run(args, cwd, env = {}) {
  return spawnSync(process.execPath, [script, ...args], { cwd, env: { ...cleanEnv, ...env }, encoding: 'utf8' });
}

test('requires an explicit output directory', async () => withTemp(async dir => {
  const result = run([], dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--output/);
  assert.deepEqual(await readdir(dir), []);
}));

test('refuses existing output directories without changing their contents', async () => withTemp(async dir => {
  for (const name of ['empty', 'occupied']) await mkdir(join(dir, name));
  await writeFile(join(dir, 'occupied', 'sentinel'), 'keep this');
  for (const name of ['empty', 'occupied']) {
    const result = run(['--output', join(dir, name)], dir);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EEXIST|already exists/i);
  }
  assert.deepEqual(await readdir(join(dir, 'empty')), []);
  assert.deepEqual(await readdir(join(dir, 'occupied')), ['sentinel']);
  assert.equal(await readFile(join(dir, 'occupied', 'sentinel'), 'utf8'), 'keep this');
}));

test('creates missing parent directories for new output', async () => withTemp(async dir => {
  const output = join(dir, 'parent', 'run');
  const result = run(['--output', output, '--source-root', join(dir, 'missing-source')], dir);
  assert.notEqual(result.status, 0);
  assert.deepEqual(await readdir(output), []);
}));

test('rejects invalid sampling settings before creating output', async () => withTemp(async dir => {
  for (const [name, value] of [['MACRO_WARMUP', '-1'], ['MACRO_WARMUP', ''], ['MACRO_SAMPLES', '0'], ['MACRO_SAMPLES', '1.5'], ['MACRO_ROUNDS', 'NaN']]) {
    const output = join(dir, `${name}-${value || 'empty'}`);
    const result = run(['--output', output], dir, { [name]: value });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, new RegExp(name));
  }
  assert.deepEqual(await readdir(dir), []);
}));

test('resolves the default source from the module and an explicit source from the caller', async () => withTemp(async dir => {
  const { parseOptions } = await import('../scripts/benchmark-macros.mjs');
  assert.deepEqual(parseOptions(['--output', 'results'], dir, {}), {
    output: join(dir, 'results'), sourceRoot: repo, warmup: 20, count: 100, rounds: 3
  });
  assert.equal(parseOptions(['--output', 'results', '--source-root', 'other'], dir, {}).sourceRoot, join(dir, 'other'));
}));

test('uses nearest-rank percentiles and omits percentiles for small samples', async () => {
  const { percentile, summary } = await import('../scripts/benchmark-macros.mjs');
  const vector = Array.from({ length: 100 }, (_, i) => 100 - i);
  assert.equal(percentile(vector, 0.95), 95);
  assert.equal(percentile(vector, 0.99), 99);
  const partial = summary([{ ms: 2, error: 'quota' }, { ms: 4, error: null }]);
  assert.deepEqual(partial.errors, { quota: 1 });
  assert.equal(partial.n, 2);
  assert.equal('p99' in partial, false);
  assert.equal('p95' in partial, false);
  const full = summary(vector.map(ms => ({ ms, error: null })));
  assert.equal(full.p95, 95); assert.equal(full.p99, 99);
});

test('serves captured public bytes and rejects files added after capture', async () => withTemp(async dir => {
  const { captureSource, createBenchmarkServer } = await import('../scripts/benchmark-macros.mjs');
  assert.equal(typeof captureSource, 'function', 'source capture is available');
  assert.equal(typeof createBenchmarkServer, 'function', 'snapshot server is available');
  assert.equal(spawnSync('git', ['init', '-q', dir]).status, 0);
  await mkdir(join(dir, 'public'));
  await writeFile(join(dir, 'package.json'), 'source package A');
  await writeFile(join(dir, 'package-lock.json'), 'source lock A');
  await writeFile(join(dir, 'public', 'index.html'), 'version A');
  await writeFile(join(dir, 'public', 'old.js'), 'old asset');
  await mkdir(join(dir, 'public', 'assets'));
  await writeFile(join(dir, 'public', 'assets', 'space file.svg'), '<svg></svg>');
  const snapshot = await captureSource(dir);
  assert.equal(snapshot.hashes['public/index.html'], '29d00a28617eba751825e0a25e75732e3ff01b41badfdbc428fb6e3c753a44fa');
  assert.equal(snapshot.hashes['package-lock.json'], '374ba75880c91ff59ffeb823e7fe49146abad499b587db15467a93cf23e8abaf');
  await writeFile(join(dir, 'package-lock.json'), 'source lock B');
  await writeFile(join(dir, 'public', 'index.html'), 'version B');
  await rm(join(dir, 'public', 'old.js'));
  await writeFile(join(dir, 'public', 'new.js'), 'new asset');
  const server = createBenchmarkServer(snapshot);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const index = await fetch(`${base}/`);
    assert.equal(index.status, 200);
    assert.equal(await index.text(), 'version A');
    assert.equal(await (await fetch(`${base}/old.js`)).text(), 'old asset');
    const asset = await fetch(`${base}/assets/space%20file.svg`);
    assert.equal(asset.status, 200);
    assert.equal(await asset.text(), '<svg></svg>');
    assert.equal((await fetch(`${base}/new.js`)).status, 404);
    assert.equal((await fetch(`${base}/%zz`)).status, 404);
  } finally {
    await new Promise(done => server.close(done));
  }
}));

test('reports a missing browser instead of skipping the isolation gate', async () => withTemp(async dir => {
  const browsers = join(dir, 'no-browsers');
  await mkdir(browsers);
  const result = spawnSync(process.execPath, ['--test', '--test-name-pattern=^isolates storage', fileURLToPath(import.meta.url)], {
    cwd: repo, env: { ...cleanEnv, PLAYWRIGHT_BROWSERS_PATH: browsers }, encoding: 'utf8'
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /browserType\.launch|executable.*(?:exist|missing)/i);
}));

test('the command fails if its browser is missing', async () => withTemp(async dir => {
  const browsers = join(dir, 'no-browsers'), output = join(dir, 'run');
  await mkdir(browsers);
  const result = run(['--output', output], dir, { PLAYWRIGHT_BROWSERS_PATH: browsers, MACRO_WARMUP: '0', MACRO_SAMPLES: '1', MACRO_ROUNDS: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ENOENT|executable.*(?:exist|missing)/i);
  assert.deepEqual(await readdir(output), []);
}));

test('isolates storage and blocks non-owned HTTP before page scripts run', async () => {
  const { chromium } = await import('playwright');
  const { isolatedContext } = await import('../scripts/benchmark-macros.mjs');
  let outsideRequests = 0;
  const outside = createServer((req, res) => { outsideRequests++; res.end('unexpected'); });
  await new Promise(done => outside.listen(0, '127.0.0.1', done));
  const outsideOrigin = `http://127.0.0.1:${outside.address().port}`;
  const owned = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' }).end(`<script>window.probe = fetch('${outsideOrigin}').then(() => 'reached', () => 'blocked')</script>`);
  });
  await new Promise(done => owned.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${owned.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const report = { blockedOrigins: {}, errors: [] };
    const first = await isolatedContext(browser, base, report);
    const page = await first.newPage();
    await page.goto(base);
    assert.equal(await page.evaluate(() => window.probe), 'blocked');
    await page.evaluate(() => localStorage.setItem('synthetic', 'first context'));
    const second = await isolatedContext(browser, base, report);
    const freshPage = await second.newPage();
    await freshPage.goto(base);
    assert.equal(await freshPage.evaluate(() => window.probe), 'blocked');
    assert.equal(await freshPage.evaluate(() => localStorage.getItem('synthetic')), null);
    assert.equal(outsideRequests, 0);
    assert.equal(report.blockedOrigins[outsideOrigin], 2);
    await first.close(); await second.close();
  } finally {
    await browser?.close();
    await Promise.all([new Promise(done => owned.close(done)), new Promise(done => outside.close(done))]);
  }
});
