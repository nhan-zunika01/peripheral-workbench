import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProductTarget, readSynapseSession } from '../bridge/synapse-session.mjs';
import { sessionSettings, sessionCommand, validateMappings } from '../bridge/session-catalog.mjs';
import { validateValue } from '../bridge/server.mjs';
test('session bridge permits only the exact official product UI and loopback debugging endpoint', async () => {
  assert.equal(isProductTarget({ type: 'page', url: 'https://apps.razer.com/synapse/products/222/ui/' }), true);
  for (const url of ['https://evil.example/synapse/products/222/ui/', 'https://apps.razer.com.evil.example/synapse/products/222/ui/', 'https://apps.razer.com/synapse/products/222/mw/', 'https://apps.razer.com/synapse/products/223/ui/', 'http://apps.razer.com/synapse/products/222/ui/']) assert.equal(isProductTarget({ type: 'page', url }), false);
  await assert.rejects(() => readSynapseSession('http://192.168.1.1:9333'), /127.0.0.1/);
  await assert.rejects(() => readSynapseSession('http://127.0.0.1:9333/other'), /127.0.0.1/);
});
const state = {
  dpiStages: { active: 1, enable: true, enableStages: true, stages: [{ x: 800, y: 800, independent: false, visible: true }] },
  pollingRate: { pollingRate: 1000, pollingRateWireless: 1000 }, lowPowerModeReducer: { lowPowerMode: 30 }, mousePowerSavingReducer: { powerSavingValue: 5 },
  profileReducer: { selectedProfileGuid: 'one', profiles: [{ guid: 'one', name: 'One' }, { guid: 'two', name: 'Two' }] },
  obm: { profiles: [{ slotId: 7, guid: 'one' }] }, mouseUseReducer: { leftHandMode: false },
  inGamePollingRate: { isInGamePollingRateEnabled: false, inGamePollingRate: 1000, inGamePollingRateWireless: 1000 },
  rotationReducer: { rotation: { isEnabled: false, value: 0 } }, dynamicSensitivityReducer: { dynamicSensitivity: { state: 0, mode: 0, customSensorAccelerations: [] } },
  customizeReducer: { mappingList: [], viewIndex: 0, sidepadLayout: 0 }
};
test('source-grounded session catalog builds only allowed middleware payloads', () => {
  const changes = sessionSettings(state);
  assert.equal(changes.find(setting => setting.id === 'session.polling').label, 'Synapse wired polling (Hz)');
  assert.equal(changes.find(setting => setting.id === 'session.pollingWireless').label, 'Synapse wireless polling (Hz)');
  for (const setting of changes) {
    if (setting.id === 'session.customCurve') { assert.throws(() => validateValue(setting, setting.value)); continue; }
    validateValue(setting, setting.value);
    if (['session.resetProfile', 'session.deleteProfile', 'session.removeOnboardProfile'].includes(setting.id)) { assert.throws(() => sessionCommand(setting.id, false, state)); continue; }
    assert.match(sessionCommand(setting.id, setting.value, state).type, /^(ON_|SET_)/);
  }
  assert.deepEqual(sessionCommand('session.onboardProfile', 'two', state), { type: 'ON_SET_OBM_PROFILE', payload: { slotId: 7, name: 'Two', guid: 'two' } });
  assert.deepEqual(sessionCommand('session.inGamePolling', { enabled: true, wired: 500, wireless: 1000 }, state), { type: 'ON_SET_IN_GAME_POLLING_RATE', payload: { inGamePollingRateData: { state: 1, wired: 500, wireless: 1000 } } });
  assert.throws(() => sessionCommand('arbitrary', {}, state));
  assert.throws(() => validateValue({ type: 'number', min: 5, max: 100, step: 5 }, 17));
});
test('mapping validation preserves implicit default left-click and protects the last explicit click on any button', () => {
  assert.deepEqual(validateMappings([]), []);
  const left = { inputID: 'LeftClick', inputType: 'MouseInput', outputType: 'disableGroup' };
  const other = { inputID: 'Button4', inputType: 'MouseInput', outputType: 'mouseGroup', mouseGroup: { mouseAssignment: 'Click' } };
  validateMappings([left, other]);
  assert.throws(() => validateMappings([left]), /left-click/);
  const current = { ...state, customizeReducer: { ...state.customizeReducer, mappingList: [left, other] } };
  assert.throws(() => sessionCommand('session.mouseMapping', { button: 'Button4', hypershift: false, assignment: 'Disable' }, current), /left-click/);
  assert.throws(() => validateMappings([{ ...other, inputID: 'arbitrary' }]));
  assert.throws(() => validateMappings([other, other]), /Duplicate/);
});
