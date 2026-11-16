import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

test('CI browser server owns an ephemeral loopback port and serves only public files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ci-server-'));
  const ready = join(directory, 'ready.json');
  const child = spawn(process.execPath, ['scripts/ci-static-server.mjs', 'public', ready], { windowsHide: true });
  try {
    let binding;
    for (let attempt = 0; attempt < 100; attempt++) {
      try { binding = JSON.parse(await readFile(ready, 'utf8')); break; }
      catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.equal(binding?.pid, child.pid);
    assert.match(binding.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const response = await fetch(binding.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.equal(await response.text(), await readFile('public/index.html', 'utf8'));
    assert.equal((await fetch(`${binding.url}/..%2fpackage.json`)).status, 404);
  } finally {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
    await rm(directory, { recursive: true, force: true });
  }
});
