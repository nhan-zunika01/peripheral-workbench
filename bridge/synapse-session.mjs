const UI_PREFIX = '/synapse/products/222/ui/';
const DOMAINS = ['dpi', 'dpiStages', 'pollingRate', 'lowPowerModeReducer', 'mousePowerSavingReducer', 'smartOnlyCalibrationReducer', 'customizeReducer', 'profileReducer', 'mouseUseReducer', 'obm', 'sensitivityMatcherReducer', 'inGamePollingRate', 'dynamicSensitivityReducer', 'rotationReducer', 'macroReducer'];
function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw new Error('SYNAPSE_INSPECTOR_URL must be http://127.0.0.1:<port>');
  return url;
}
export function isProductTarget(target) {
  try { const url = new URL(target.url); return ['page', 'iframe'].includes(target.type) && url.origin === 'https://apps.razer.com' && url.pathname.startsWith(UI_PREFIX); } catch { return false; }
}
async function evaluateSynapse(base, inner, deadline = 4000) {
  const url = endpoint(base);
  const response = await fetch(new URL('/json/list', url), { signal: AbortSignal.timeout(2000) });
  if (!response.ok) throw new Error('Synapse debugging endpoint unavailable');
  const targets = await response.json();
  if (!Array.isArray(targets) || targets.length > 200) throw new Error('Invalid Synapse target list');
  const target = targets.find(item => item.type === 'node' && item.title === 'electron/js2c/browser_init' && item.url === 'file://');
  if (!target) throw new Error('The configured port is not a Synapse Electron main-process inspector');
  const websocketUrl = new URL(target.webSocketDebuggerUrl);
  if (websocketUrl.protocol !== 'ws:' || websocketUrl.hostname !== '127.0.0.1' || websocketUrl.port !== url.port || websocketUrl.username || websocketUrl.password) throw new Error('Synapse returned a non-loopback debugger URL');
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(websocketUrl);
    let settled = false;
    const timer = setTimeout(() => finish(Object.assign(new Error('Synapse operation timed out; the setting may have changed without confirmation'), { status: 504 })), deadline);
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.close(); error ? reject(error) : resolve(value); };
    socket.addEventListener('error', () => finish(new Error('Cannot connect to the Synapse debugger')));
    socket.addEventListener('open', () => {
      const expression = `(() => { if (process.execPath.toLowerCase() !== 'c:\\\\program files\\\\razer\\\\razerappengine\\\\app-4.0.896\\\\razerappengine.exe') throw new Error('Unexpected runtime'); const all = process.mainModule.require('electron').webContents.getAllWebContents(); const page = all.find(item => { try { const url = new URL(item.getURL()); return url.origin === 'https://apps.razer.com' && url.pathname.startsWith(${JSON.stringify(UI_PREFIX)}); } catch { return false; } }); if (!page) throw new Error('Open the Viper V3 Pro SE settings page in Synapse'); return page.executeJavaScript(${JSON.stringify(inner)}); })()`;
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 512000) throw new Error('Invalid Synapse debugger response');
        const data = JSON.parse(event.data);
        if (data.id !== 1) return;
        if (data.error || data.result?.exceptionDetails) {
          const detail = data.result?.exceptionDetails?.exception?.description || '';
          const known = ['Unexpected runtime', 'Open the Viper V3 Pro SE settings page in Synapse', 'Unexpected Synapse page', 'Synapse state is not ready', 'Synapse did not confirm the operation; the setting may have changed', 'Synapse rejected the operation', 'Synapse command could not be sent'].find(message => detail.includes(message));
          throw Object.assign(new Error(known || 'Synapse state could not be read'), { status: detail.includes('may have changed') ? 504 : 502 });
        }
        const value = data.result?.result?.value;
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected Synapse state');
        finish(null, value);
      } catch (error) { finish(error); }
    });
    socket.addEventListener('close', () => finish(new Error('Synapse debugger closed before returning state')));
  });
}
export function readSynapseSession(base) {
  return evaluateSynapse(base, `(() => { if (location.origin !== 'https://apps.razer.com' || !location.pathname.startsWith(${JSON.stringify(UI_PREFIX)})) throw new Error('Unexpected Synapse page'); const state = window.reduxStore?.getState(); if (!state) throw new Error('Synapse state is not ready'); return Object.fromEntries(${JSON.stringify(DOMAINS)}.map(key => [key, state[key]])); })()`);
}
const EVENTS = ['ON_STAGES_CHANGE', 'ON_POLLING_RATE', 'ON_SET_LOW_POWER_MODE', 'ON_SET_POWER_SAVING_VALUE', 'ON_SWITCH_PROFILE', 'ON_RENAME_PROFILE', 'ON_DUPLICATE_PROFILE', 'ON_RESET_PROFILE', 'ON_DELETE_PROFILE', 'ON_SET_OBM_PROFILE', 'ON_REMOVE_OBM_PROFILE', 'ON_SET_LEFT_HAND_MODE', 'ON_SET_IN_GAME_POLLING_RATE', 'ON_SET_ROTATION', 'ON_SET_DYNAMIC_SENSITIVITY', 'SET_SMART_TRACKING_VALUE', 'SET_SMART_CALIBRATION_DATA_TO_LOCAL_STORAGE_FROM_UI', 'ON_SET_KEYMAPPING'];
export function writeInPage(command, timerTick) {
  if (location.origin !== 'https://apps.razer.com' || !location.pathname.startsWith('/synapse/products/222/ui/')) throw new Error('Unexpected Synapse page');
  const store = window.reduxStore, channel = window.mwBroadcastChannel;
  if (!store?.dispatch || !channel?.postMessage) throw new Error('Synapse state is not ready');
  return new Promise((resolve, reject) => {
    const original = store.dispatch;
    let receipt = false, completed = false, settled = false;
    const cleanup = error => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (store.dispatch === wrapped) store.dispatch = original;
      if (error) reject(error); else resolve({ acknowledged: true });
    };
    const timer = setTimeout(() => cleanup(new Error('Synapse did not confirm the operation; the setting may have changed')), 6500);
    function wrapped(action) {
      const result = original.call(this, action);
      const payload = action?.payload;
      if (command.type === 'ON_SET_ROTATION' && action.type === 'MW_SET_ROTATION_TO_UI' && JSON.stringify(payload?.rotation) === JSON.stringify(command.payload.rotation)) { cleanup(); }
      if (command.type === 'ON_SET_DYNAMIC_SENSITIVITY' && action.type === 'MW_SET_DYNAMIC_SENSITIVITY_TO_UI') {
        const actual = payload?.dynamicSensitivity, expected = command.payload.dynamicSensitivity;
        if (actual?.state === expected.state && actual?.mode === expected.mode && (expected.mode !== 3 || JSON.stringify(actual.customSensorAccelerations) === JSON.stringify(expected.customSensorAccelerations))) cleanup();
      }
      if (payload?.timertick === timerTick) {
        const update = /^MW_UPDATE_[A-Z_]+_UI_ACTION_(DEVICE|LOCAL_STORAGE)$/.test(action.type);
        const done = /^MW_POST_PROCESS_COMPLETED_[A-Z_]+_UI_ACTION$/.test(action.type);
        if ((update || done) && payload.status === 'error') cleanup(new Error('Synapse rejected the operation'));
        const localOnly = ['ON_RENAME_PROFILE', 'ON_DUPLICATE_PROFILE', 'ON_DELETE_PROFILE'].includes(command.type);
        if (update && (action.type.endsWith('_DEVICE') || localOnly) && ['completed', 'success'].includes(payload.status)) receipt = true;
        if (done) completed = true;
        if (receipt && completed) cleanup();
      }
      return result;
    }
    store.dispatch = wrapped;
    try { channel.postMessage({ type: command.type, timerTick, payload: command.payload }); }
    catch { cleanup(new Error('Synapse command could not be sent')); }
  });
}
export async function applySynapseSession(base, command) {
  const events = command.events || [command];
  if (!events.length || events.length > 2 || events.some(event => !EVENTS.includes(event.type) || !event.payload || typeof event.payload !== 'object')) throw new Error('Unsupported Synapse command');
  for (const event of events) {
    const result = await evaluateSynapse(base, `(${writeInPage.toString()})(${JSON.stringify(event)},${Date.now()})`, 8000);
    if (result.acknowledged !== true) throw new Error('Synapse acknowledgement missing');
  }
  return { verified: true, verification: ['ON_SET_ROTATION', 'ON_SET_DYNAMIC_SENSITIVITY'].includes(events[0].type) ? 'synapse-state-update' : 'synapse-acknowledgement' };
}
