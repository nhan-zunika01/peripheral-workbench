import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { readSynapseSession, applySynapseSession, writeInPage } from '../bridge/synapse-session.mjs';
const require = createRequire(import.meta.url);
const { WebSocketServer } = require('ws');
test('mock inspector verifies fixed execution guards and acknowledgement propagation', async t => {
  let mode = 'read';
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([{ type: 'node', title: 'electron/js2c/browser_init', url: 'file://', webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/mock` }]));
  });
  const sockets = new WebSocketServer({ server });
  t.after(() => { for (const client of sockets.clients) client.terminate(); sockets.close(); server.close(); });
  sockets.on('connection', socket => socket.on('message', message => {
    const request = JSON.parse(message);
    assert.equal(request.method, 'Runtime.evaluate'); assert.equal(request.params.awaitPromise, true);
    assert.match(request.params.expression, /process\.execPath/); assert.match(request.params.expression, /webContents\.getAllWebContents/);
    assert.match(request.params.expression, /apps\.razer\.com/); assert.match(request.params.expression, /synapse\/products\/222\/ui/);
    if (mode === 'write') { assert.match(request.params.expression, /store\.dispatch = wrapped/); assert.match(request.params.expression, /MW_POST_PROCESS_COMPLETED/); assert.match(request.params.expression, /store\.dispatch = original/); }
    socket.send(JSON.stringify({ id: request.id, result: { result: { value: mode === 'read' ? { dpi: { x: 800, y: 800 } } : { acknowledged: true } } } }));
  }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await readSynapseSession(base), { dpi: { x: 800, y: 800 } });
  mode = 'write';
  assert.deepEqual(await applySynapseSession(base, { type: 'ON_POLLING_RATE', payload: { pollingRate: 500 } }), { verified: true, verification: 'synapse-acknowledgement' });
  await assert.rejects(() => applySynapseSession(base, { type: 'Runtime.evaluate', payload: {} }), /Unsupported/);
});
test('page receipt observer requires a matching device receipt and completion, rejects errors and restores dispatch', async () => {
  const originalWindow = globalThis.window, originalLocation = globalThis.location;
  globalThis.location = { origin: 'https://apps.razer.com', pathname: '/synapse/products/222/ui/index.html' };
  let dispatched = 0;
  const original = function () { dispatched++; return 'original-result'; };
  const store = { dispatch: original };
  globalThis.window = { reduxStore: store, mwBroadcastChannel: { postMessage: () => {} } };
  try {
    const pending = writeInPage({ type: 'ON_POLLING_RATE', payload: { pollingRate: 500 } }, 42);
    assert.equal(store.dispatch({ type: 'MW_UPDATE_POLLING_RATE_UI_ACTION_LOCAL_STORAGE', payload: { timertick: 42, status: 'completed' } }), 'original-result');
    store.dispatch({ type: 'MW_POST_PROCESS_COMPLETED_POLLING_RATE_UI_ACTION', payload: { timertick: 42 } });
    assert.notEqual(store.dispatch, original, 'local storage completion cannot confirm a hardware operation');
    store.dispatch({ type: 'MW_UPDATE_POLLING_RATE_UI_ACTION_DEVICE', payload: { timertick: 43, status: 'completed' } });
    assert.notEqual(store.dispatch, original, 'unrelated receipt cannot confirm the operation');
    store.dispatch({ type: 'MW_UPDATE_POLLING_RATE_UI_ACTION_DEVICE', payload: { timertick: 42, status: 'completed' } });
    assert.deepEqual(await pending, { acknowledged: true }); assert.equal(store.dispatch, original); assert.equal(dispatched, 4);
    const failed = writeInPage({ type: 'ON_POLLING_RATE', payload: { pollingRate: 500 } }, 44);
    store.dispatch({ type: 'MW_UPDATE_POLLING_RATE_UI_ACTION_DEVICE', payload: { timertick: 44, status: 'error' } });
    await assert.rejects(failed, /rejected/); assert.equal(store.dispatch, original);
    const rotation = writeInPage({ type: 'ON_SET_ROTATION', payload: { rotation: { isEnabled: true, value: 4 } } }, 45);
    store.dispatch({ type: 'MW_SET_ROTATION_TO_UI', payload: { rotation: { isEnabled: true, value: 4 } } });
    await rotation; assert.equal(store.dispatch, original);
  } finally { globalThis.window = originalWindow; globalThis.location = originalLocation; }
});
