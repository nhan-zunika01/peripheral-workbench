import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

test('Chromium preparation attests the process it opened and redacts failed probe output', t => {
  const root = mkdtempSync(join(tmpdir(), 't00-browser-fixture-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const probe = join(root, 'browser-probe.mjs');
  const cache = join(root, 'cache');
  const executable = join('chromium_headless_shell-1248', 'chrome-headless-shell-win64', 'chrome-headless-shell.exe');
  const browserFile = join(cache, executable);
  const temp = join(root, 'temp');
  const profile = join(temp, 'playwright_chromiumdev_profile-private');
  const packageDir = join(root, 'node_modules', 'playwright');
  for (const dir of [dirname(browserFile), profile, packageDir]) mkdirSync(dir, { recursive: true });
  writeFileSync(browserFile, 'fixture executable');
  copyFileSync(new URL('../scripts/ci-browser-probe.mjs', import.meta.url), probe);
  writeFileSync(join(packageDir, 'package.json'), '{"name":"playwright","type":"module","exports":"./index.js"}');
  writeFileSync(join(packageDir, 'index.js'), `
    const mode = process.env.T00_FIXTURE_MODE;
    export const chromium = {
      async launchServer({ headless, host, executablePath }) {
        if (headless !== true || host !== '127.0.0.1' || executablePath) throw Error('fixture launch arguments');
        return {
          process: () => ({ spawnfile: mode === 'wrong-executable' ? 'chrome.exe' : ${JSON.stringify(browserFile)},
            spawnargs: ['--user-data-dir=' + (mode === 'outside-profile' ? ${JSON.stringify(cache)} : ${JSON.stringify(profile)})] }),
          wsEndpoint: () => 'ws://127.0.0.1:12345/private-sentinel',
          async close() { if (mode === 'failed-close') throw Error('private-sentinel'); },
        };
      },
      async connect() {
        return { version: () => '156.0.8078.4',
          async newPage() { return { async setContent() {}, locator() {
            return { async textContent() { return mode === 'wrong-dom' ? 'private-sentinel' : 't00-chromium'; } };
          } }; },
          async close() {},
        };
      },
    };
  `);
  const run = mode => spawnSync(process.execPath, [probe, executable], {
    env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: cache, TEMP: temp, TMP: temp, TMPDIR: temp, T00_FIXTURE_MODE: mode },
    encoding: 'utf8', timeout: 5000,
  });
  const pass = run('pass');
  assert.equal(pass.status, 0, pass.stderr);
  assert.deepEqual(JSON.parse(pass.stdout), {
    version: '156.0.8078.4', executable,
    sha256: createHash('sha256').update('fixture executable').digest('hex'), profilePrivate: true, dom: true,
  });
  for (const mode of ['wrong-executable', 'outside-profile', 'wrong-dom', 'failed-close']) {
    const fail = run(mode);
    assert.equal(fail.status, 1, mode);
    assert.equal(fail.stdout, '', mode);
    assert.doesNotMatch(fail.stderr, /private-sentinel/, mode);
  }
});
