import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import nativeHost from './native-host.cjs';

// Experimental transport: native remains the default until hardware parity is verified.
export function rustRequest(request, { executable = process.env.RAZER_RUST_HELPER, allowWrites = process.env.RAZER_RUST_ALLOW_WRITES === '1', spawnHelper = spawn } = {}) {
  if (!executable || !isAbsolute(executable)) return Promise.reject(new Error('RAZER_RUST_HELPER must be an absolute path to the compiled Rust helper'));
  if (request.action === 'apply' && !allowWrites) return Promise.reject(Object.assign(new Error('Experimental Rust transport is read-only; hardware write parity has not been verified'), { status: 400 }));
  return new Promise((resolve, reject) => {
    const child = spawnHelper(executable, allowWrites ? ['--allow-writes'] : [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let pending, output = '', settled = false, finishing = false;
    const uncertain = () => Object.assign(new Error('Rust helper failed or timed out; the setting may have changed. Inspect the device before retrying.'), { status: 502 });
    const finish = (error, result) => {
      if (settled || finishing) return;
      finishing = true; clearTimeout(timer);
      if (pending) { pending.reject(error || uncertain()); pending = undefined; }
      // The HTTP queue must stay occupied until the HID process has actually closed.
      child.once('close', () => { settled = true; if (error) reject(error); else resolve(result); });
      child.kill();
    };
    const timer = setTimeout(() => finish(Object.assign(uncertain(), { status: 504 })), 9000);
    child.on('error', error => finish(Object.assign(error, { status: 502 })));
    child.on('exit', () => { if (!settled) finish(uncertain()); });
    child.stderr.resume();
    child.stdin.on('error', () => finish(uncertain()));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      output += chunk;
      if (Buffer.byteLength(output) > 256 * 1024) { finish(uncertain()); return; }
      let end;
      while ((end = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        const waiter = pending; pending = undefined;
        if (!waiter) { finish(uncertain()); return; }
        try {
          const result = JSON.parse(line);
          if (typeof result.error === 'string') waiter.reject(Object.assign(new Error(result.error), { status: 502 }));
          else if (!Object.hasOwn(result, 'result')) waiter.reject(uncertain());
          else waiter.resolve(result.result);
        } catch { waiter.reject(uncertain()); }
      }
    });
    const call = value => new Promise((resolve, reject) => {
      if (settled || finishing || pending) { reject(uncertain()); return; }
      pending = { resolve, reject };
      child.stdin.write(`${JSON.stringify(value)}\n`);
    });
    (async () => {
      const devices = await call({ action: 'enumerate' });
      const hid = { devices: () => devices, HID: class {
        constructor(path) { this.opened = call({ action: 'open', path }); }
        async exchange(command, data) { await this.opened; return call({ action: 'exchange', command, data }); }
        async close() { await this.opened.catch(() => {}); return call({ action: 'close' }); }
      } };
      const result = await nativeHost.handleRequest(request, hid);
      if (request.action === 'snapshot') {
        if (!allowWrites) result.settings = result.settings.map(setting => ({ ...setting, writable: false }));
        result.message = `Experimental Rust HID transport${allowWrites ? '' : ' (read-only; hardware write parity is unverified)'}. ${result.message}`;
      }
      return result;
    })().then(result => finish(null, result), error => finish(error));
  });
}
