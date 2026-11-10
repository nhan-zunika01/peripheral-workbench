// Fake subprocesses only: no server, inventory or hardware imports.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { launchService } from '../../scripts/bridge.mjs';

const [mode, output] = process.argv.slice(2);
if (mode === 'child') {
  let input = '';
  const finish = result => { clearTimeout(deadline); writeFileSync(output, JSON.stringify({ pid: process.pid, input, ...result })); process.stdin.destroy(); };
  const deadline = setTimeout(() => finish({ bounded: true }), Number(process.env.RAZER_FIXTURE_DEADLINE_MS || 5000));
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', bytes => { input += bytes; });
  process.stdin.on('end', () => finish({ eof: true }));
  process.stdin.on('error', error => finish({ error: error.code }));
  process.stdin.resume();
  console.log('FAKE_CHILD_READY');
} else if (mode === 'owner') {
  let probes = 0;
  const service = await launchService({ executable: process.execPath, args: [fileURLToPath(import.meta.url), 'child', output], backend: 'rust' }, async () => ++probes === 1 ? 'absent' : 'ready');
  if (process.env.RAZER_FIXTURE_OWNER_FAIL_SETUP === '1') throw new Error('Explicit fake-owner setup failure');
  process.send({ pid: service.child.pid });
  process.on('message', async message => {
    if (message === 'stop') { await service.stop(); process.disconnect(); }
    if (message === 'crash') process.exit(23);
  });
} else throw new Error('Fixture mode required');
