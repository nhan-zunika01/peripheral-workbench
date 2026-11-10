// Read-only fake companion for visual inspection. No native/bridge backend is loaded.
import { createServer } from 'node:http';
import { fixture } from '../tests/ui-fixture.mjs';
const origins = new Set(['http://127.0.0.1:8787', 'http://localhost:8787']);
const server = createServer((request, response) => {
  const origin = request.headers.origin;
  if (origin && !origins.has(origin)) { response.writeHead(403); response.end(); return; }
  response.setHeader('Access-Control-Allow-Origin', origin || 'http://127.0.0.1:8787');
  response.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  response.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
  response.setHeader('Content-Type', 'application/json');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  // Inspection must never trigger writes, even to a fake backend.
  if (request.method !== 'GET') { response.writeHead(405); response.end(JSON.stringify({ error: 'Mock inspection server is read-only' })); return; }
  const url = new URL(request.url, 'http://127.0.0.1:17321');
  if (url.pathname === '/api/pair') { response.end(JSON.stringify({ token: 'a'.repeat(64) })); return; }
  if (url.pathname === '/api/state') {
    const state = fixture(); state.devices = state.devices.slice(0, 1); state.devices[0].name += ' [Mock]';
    response.end(JSON.stringify(state)); return;
  }
  response.writeHead(404); response.end('{}');
});
server.listen(17321, '127.0.0.1', () => process.stdout.write('READ-ONLY MOCK companion at 127.0.0.1:17321 — no hardware access\n'));
