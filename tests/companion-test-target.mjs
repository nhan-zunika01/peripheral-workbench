// Test-only in-process implementation of the private control protocol, exercising the
// differential client against real legacy HTTP sockets before the Rust target exists.
import { setImmediate as tick } from 'node:timers/promises';
import { controlledFactory } from './companion-scenario-support.mjs';
import { startBridge, closeBridge, fakeBackend, deviceId } from './companion-wire-support.mjs';

export function legacyTestTarget(options = {}) {
  let server, backend, config, release, hold, requests = 0, clock, pairIndex = 0;
  const waitFor = async predicate => {
    const deadline = Date.now() + 3000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error('Legacy protocol checkpoint timed out'); await tick(); }
  };
  const open = async () => {
    server = await startBridge(backend, { token: config.token, factory: clock.factory, ...(config.origin ? { origin: config.origin } : {}) });
    server.prependListener('request', (request, response) => {
      if (request.method === 'GET' && request.url === '/api/pair') {
        const writeHead = response.writeHead;
        response.writeHead = function (...args) {
          this.setHeader('X-Razer-Companion-Backend', 'rust');
          this.setHeader('X-Razer-Companion-Writes', config.fakeMode === 'read-only' ? '0' : '1');
          return writeHead.apply(this, args);
        };
        const replacement = options.pairTokens?.[pairIndex++];
        if (replacement !== undefined) {
          const end = response.end;
          response.end = function (chunk, ...rest) { const body = JSON.parse(String(chunk)); body.token = replacement; return end.call(this, JSON.stringify(body), ...rest); };
        }
      }
    });
    server.on('request', () => { requests++; });
  };
  return { server: { address: () => server.address() },
    async command(op, data = {}) {
      if (op === 'reset') {
        if (server) await closeBridge(server);
        config = data; backend = fakeBackend(data.backend); requests = 0; pairIndex = 0; clock = controlledFactory();
        hold = new Promise(resolve => { release = resolve; });
        const snapshot = backend.snapshot, apply = backend.apply;
        if (data.hold === 'first-snapshot') backend.snapshot = async id => {
          const first = backend.transcript.length === 0;
          backend.transcript.push({ action: 'snapshot', ...(id ? { deviceId: id } : {}) });
          if (first) await hold;
          return { connected: true, selectedDeviceId: id || deviceId, settings: [] };
        };
        else backend.snapshot = snapshot;
        if (data.hold === 'apply') backend.apply = async (...args) => { const result = await apply(...args); await hold; return result; };
        await open(); return null;
      }
      if (op === 'set-token') { await closeBridge(server); config.token = data.token; await open(); return null; }
      if (op === 'observe') return { transcript: structuredClone(backend.transcript) };
      if (op === 'checkpoint') { await waitFor(() => backend.transcript.filter(row => row.action === data.action).length >= data.count); return null; }
      if (op === 'barrier') { await waitFor(() => requests >= data.requests); return null; }
      if (op === 'release') { release(); return null; }
      if (op === 'advance') { if (data.milliseconds !== 75000) throw new Error('Unexpected virtual advance'); clock.expire(); return null; }
      throw new Error(`Unknown private operation ${op}`);
    },
    async stop() { release?.(); if (server) await closeBridge(server); }
  };
}
