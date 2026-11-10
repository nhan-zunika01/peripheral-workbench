import { statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { assertNoRustSession } from '../bridge/server.mjs';

export const DEFAULT_BACKEND = 'legacy';
export const DEFAULT_RUST_WRITES = false;
const root = fileURLToPath(new URL('../', import.meta.url));

export function resolveCompanionConfig({ env = process.env, args = [], defaults = { backend: DEFAULT_BACKEND, writes: DEFAULT_RUST_WRITES } } = {}) {
  if (args.length && (args.length !== 2 || args[0] !== '--origin')) throw new Error('Usage: npm run bridge -- --origin https://your-worker.example');
  const origin = args[1] ?? env.UI_ORIGIN ?? 'http://127.0.0.1:8787';
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('UI_ORIGIN must be an exact HTTP(S) origin without a trailing slash');
  const backend = env.RAZER_COMPANION_BACKEND ?? defaults.backend;
  if (!['legacy', 'rust'].includes(backend)) throw new Error('RAZER_COMPANION_BACKEND must be legacy or rust');
  if (env.RAZER_COMPANION_WRITES !== undefined && !['0', '1'].includes(env.RAZER_COMPANION_WRITES)) throw new Error('RAZER_COMPANION_WRITES must be 0 or 1');
  const writes = backend === 'rust' && (env.RAZER_COMPANION_WRITES === undefined ? defaults.writes : env.RAZER_COMPANION_WRITES === '1');
  let executable = process.execPath;
  let command = [join(root, 'bridge/server.mjs'), '--origin', origin];
  if (backend === 'rust') {
    if (env.SYNAPSE_INSPECTOR_URL !== undefined) throw new Error('SYNAPSE_INSPECTOR_URL is incompatible with the Rust companion');
    executable = env.RAZER_COMPANION_EXE ?? join(root, 'bridge/rust/target/release/razer-companion.exe');
    if (!isAbsolute(executable)) throw new Error('RAZER_COMPANION_EXE must be an absolute path');
    let exists = false;
    try { exists = statSync(executable).isFile(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!exists) throw new Error(`Rust companion executable is missing: ${executable}. Build it or set RAZER_COMPANION_EXE to its absolute path.`);
    command = ['--origin', origin, writes ? '--allow-writes' : '--read-only', '--managed-shutdown'];
  }
  return { backend, writes, origin, executable, args: command, cwd: root, env };
}

export async function probeCompanion({ origin, backend, writes, url = 'http://127.0.0.1:17321/api/pair' }, fetcher = fetch) {
  try {
    const response = await fetcher(url, { headers: { Origin: origin }, signal: AbortSignal.timeout(1500) });
    if (!response.ok || response.headers?.get('X-Razer-Companion-Backend') !== backend) return 'conflict';
    if (backend === 'rust' && response.headers.get('X-Razer-Companion-Writes') !== (writes ? '1' : '0')) return 'conflict';
    const data = await response.json();
    return /^[a-f0-9]{64}$/.test(data.token) ? 'ready' : 'conflict';
  } catch (error) { return error.cause?.code === 'ECONNREFUSED' ? 'absent' : 'conflict'; }
}

export async function waitReady(check, child, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode) throw new Error('Service exited before it became ready. See its output above.');
    const state = await check();
    if (child.exitCode !== null || child.signalCode) throw new Error('Service exited before it became ready. See its output above.');
    if (state === 'ready') return;
    if (state === 'conflict') throw new Error('Service port is occupied by another app or a companion with a different origin, backend or write mode.');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Service did not become ready within 30 seconds. Check port availability and the output above.');
}

export async function launchService(config, check, { spawnChild = spawn, platform = process.platform, graceMs = 90000, onOwned = () => {} } = {}) {
  const state = await check();
  if (state === 'conflict') throw new Error('Service port is occupied by another app or a companion with a different origin, backend or write mode.');
  if (state === 'ready') return { reused: true, stop: async () => {} };
  // Windows libuv's default job kills children before a crashed launcher's pipe can drain.
  const child = spawnChild(config.executable, config.args, { cwd: config.cwd, env: config.env, windowsHide: true, detached: config.backend === 'rust' && platform === 'win32', stdio: config.backend === 'rust' ? ['pipe', 'inherit', 'inherit'] : 'inherit' });
  let closed = false, stopping;
  const exited = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }); }));
  const failed = new Promise((_, reject) => child.on('error', reject));
  child.stdin?.on('error', () => {});
  const forceKill = async () => {
    if (closed || !child.pid) return;
    if (platform !== 'win32') { child.kill('SIGKILL'); return; }
    await new Promise((resolve, reject) => {
      const killer = spawnChild('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', reject);
      killer.once('close', code => code === 0 || closed ? resolve() : reject(new Error('Could not stop the owned service process tree.')));
    });
  };
  const stop = () => stopping ||= (async () => {
    if (closed) return exited;
    if (config.backend === 'rust') {
      try { child.stdin.end('shutdown\n'); } catch {}
      let timer;
      try { await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, graceMs); })]); }
      finally { clearTimeout(timer); }
    }
    if (!closed) await forceKill();
    return exited;
  })();
  const service = { child, reused: false, exited, stop };
  onOwned(service);
  try { await Promise.race([waitReady(check, child), failed]); }
  catch (error) { await stop(); throw error; }
  return service;
}

export async function launchCompanion(config, options = {}) {
  if (config.backend === 'legacy') assertNoRustSession(config.env.LOCALAPPDATA);
  return launchService(config, () => probeCompanion(config, options.fetcher), options);
}

export async function runWithServices(run, runtime = process) {
  const owned = []; let stopping = false;
  const stop = () => { stopping = true; return Promise.all(owned.map(service => service.stop())); };
  const onSignal = () => { stop().catch(error => { console.error(error.message); runtime.exitCode = 1; }); };
  runtime.once('SIGINT', onSignal); runtime.once('SIGTERM', onSignal);
  try {
    await run({
      onOwned(service) { owned.push(service); if (stopping) onSignal(); },
      stopped: () => stopping
    });
    if (owned.length) {
      const status = await Promise.race(owned.map(service => service.exited));
      if (!stopping && status.code !== 0) throw new Error(`Owned service exited unexpectedly (${status.code ?? status.signal}).`);
    }
  } finally {
    try { await stop(); }
    finally { runtime.removeListener('SIGINT', onSignal); runtime.removeListener('SIGTERM', onSignal); }
  }
}

export async function runBridge({ env = process.env, args = process.argv.slice(2), runtime = process, defaults, ...options } = {}) {
  const config = resolveCompanionConfig({ env, args, defaults });
  return runWithServices(async ({ onOwned }) => {
    const service = await launchCompanion(config, { ...options, onOwned });
    console.log(`${service.reused ? 'Reusing' : 'Ready:'} ${config.backend} companion for ${config.origin}.`);
  }, runtime);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runBridge().catch(error => { console.error(error.message); process.exitCode = 1; });
