import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoRustSession } from '../bridge/server.mjs';
import { resolveCompanionConfig, launchCompanion, launchService, probeCompanion, runWithServices } from './bridge.mjs';
export { waitReady } from './bridge.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ui = 'http://127.0.0.1:8787';
export async function probe(url, origin, fetcher = fetch, config = { backend: 'legacy' }) {
  if (origin) return probeCompanion({ ...config, origin, url }, fetcher);
  try {
    const response = await fetcher(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return 'conflict';
    const data = await response.json();
    return data.app === 'razer-device-control' ? 'ready' : 'conflict';
  } catch (error) { return error.cause?.code === 'ECONNREFUSED' ? 'absent' : 'conflict'; }
}
export async function start({ env = process.env, runtime = process, spawnChild = spawn, fetcher = fetch, defaults, ...options } = {}) {
  const config = resolveCompanionConfig({ env, args: ['--origin', ui], defaults });
  if (config.backend === 'legacy') assertNoRustSession(env.LOCALAPPDATA);
  return runWithServices(async ({ onOwned, stopped }) => {
    const launchOptions = { ...options, spawnChild, fetcher, onOwned };
    await launchService({ executable: process.execPath, args: [fileURLToPath(new URL('../node_modules/wrangler/bin/wrangler.js', import.meta.url)), 'dev', '--ip', '127.0.0.1', '--port', '8787'], cwd: root, env }, () => probe(`${ui}/api/info`, null, fetcher), launchOptions);
    if (stopped()) return;
    await launchCompanion(config, launchOptions);
    if (stopped()) return;
    console.log(`Ready: ${ui}. Keep this terminal open; Ctrl+C stops services started here.`);
    const browser = spawnChild('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Start-Process 'http://127.0.0.1:8787'"], { windowsHide: true, stdio: 'ignore' });
    browser.on('error', () => console.log(`Open ${ui} in your browser.`));
  }, runtime);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) start().catch(error => { console.error(error.message); process.exitCode = 1; });
