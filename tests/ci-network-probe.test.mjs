import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const probe = fileURLToPath(new URL('../scripts/ci-network-probe.mjs', import.meta.url));
const run = promisify(execFile);

test('probe reports fresh-process TCP and owned loopback results', async () => {
  const server = net.createServer(socket => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  try {
    const { stdout } = await run(process.execPath, [probe, '127.0.0.1', String(port)]);
    const row = JSON.parse(stdout);
    assert.equal(row.address, '127.0.0.1');
    assert.equal(row.port, port);
    assert.equal(row.connected, true);
    assert.equal(row.loopback, true);
    assert.notEqual(row.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(row.utc)));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  const { stdout } = await run(process.execPath, [probe, '127.0.0.1', String(port)]);
  const row = JSON.parse(stdout);
  assert.equal(row.connected, false);
  assert.equal(row.loopback, true);
  assert.ok(row.error);
});

test('probe rejects non-IPv4 targets', () => {
  const result = spawnSync(process.execPath, [probe, '::1', '443'], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /IPv4/);
});
