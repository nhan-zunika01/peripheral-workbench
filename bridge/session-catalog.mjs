import { randomUUID } from 'node:crypto';

const bool = label => ({ type: 'boolean', label });
const number = (label, min, max) => ({ type: 'number', label, integer: true, min, max });
const text = label => ({ type: 'string', label });
const object = properties => ({ type: 'object', properties });
const rates = label => ({ type: 'number', label, options: [125, 500, 1000] });
const mouseActions = ['Click', 'Menu', 'ScrollButton', 'DoubleClick', 'ScrollUp', 'ScrollDown', 'Previous', 'Next', 'ScrollLeft', 'ScrollRight', 'RepeatScrollLeft', 'RepeatScrollRight', 'RepeatScrollUp', 'RepeatScrollDown'];
const buttonIds = ['LeftClick', 'RightClick', 'ScrollButton', 'ScrollUp', 'ScrollDown', 'Button4', 'Button5', 'DKM_SB_03'];
const groups = ['keyboardGroup', 'mouseGroup', 'sensitivityGroup', 'macroGroup', 'multimediaGroup', 'disableGroup', 'hyperShiftGroup', 'win8ShortcutsGroup', 'launchGroup', 'perfect180Group', 'interDeviceGroup', 'profileNavigationGroup', 'textBlockGroup', 'lightPacGroup', 'aiLauncherGroup', 'appSpecificGroup'];
export function validateMappings(mappings) {
  if (!Array.isArray(mappings) || mappings.length > buttonIds.length * 2) throw new Error('Expected at most one mapping per button and layer');
  const seen = new Set();
  const safe = (value, depth = 0) => {
    if (depth > 6) throw new Error('Mapping is too deeply nested');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value === 'string' && value.length <= 4096) return;
    if (Array.isArray(value) && value.length <= 1000) { value.forEach(item => safe(item, depth + 1)); return; }
    if (value && typeof value === 'object' && Object.keys(value).length <= 64) { for (const [key, item] of Object.entries(value)) { if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Unsafe mapping property'); safe(item, depth + 1); } return; }
    throw new Error('Invalid mapping data');
  };
  for (const mapping of mappings) {
    if (!mapping || !buttonIds.includes(mapping.inputID) || !['MouseInput', 'DKMInput'].includes(mapping.inputType) || (mapping.isHyperShift !== undefined && typeof mapping.isHyperShift !== 'boolean')) throw new Error('Unsupported button or input type');
    const key = `${mapping.inputID}:${!!mapping.isHyperShift}`; if (seen.has(key)) throw new Error('Duplicate button mapping'); seen.add(key);
    if (mapping.isDefault !== true && !groups.includes(mapping.outputType)) throw new Error('Unsupported mapping group');
    const allowed = ['inputID', 'inputType', 'isHyperShift', 'isDefault', 'outputType', 'mouseInput', 'keyInput', ...groups];
    if (Object.keys(mapping).some(key => !allowed.includes(key))) throw new Error('Unsupported mapping field');
    safe(mapping);
  }
  const left = mappings.find(item => item.inputID === 'LeftClick' && !item.isHyperShift);
  if (!left || left.isDefault) return mappings;
  if (!mappings.some(item => !item.isHyperShift && item.mouseGroup?.mouseAssignment === 'Click')) throw new Error('Keep at least one standard left-click assignment');
  return mappings;
}
export function sessionSettings(state) {
  const result = [];
  const add = (id, label, schema, value, description) => { if (value !== undefined) result.push({ id: `session.${id}`, ...schema, label, value, writable: true, description: description || 'Uses the running Synapse session. Confirmation comes from its middleware acknowledgement.' }); };
  const dpi = number('DPI', 100, 35000);
  if (state.dpiStages?.stages) add('dpiStages', 'Synapse DPI stages', object({ active: number('Active stage', 1, 5), enable: bool('Enable stages'), enableStages: bool('Enable stage switching'), stages: { type: 'array', minItems: 1, maxItems: 5, items: object({ x: { ...dpi, label: 'X axis' }, y: { ...dpi, label: 'Y axis' }, independent: bool('Independent axes'), visible: bool('Visible') }) } }), { active: state.dpiStages.active, enable: state.dpiStages.enable, enableStages: state.dpiStages.enableStages, stages: state.dpiStages.stages });
  add('polling', 'Synapse wired polling (Hz)', rates('Polling'), state.pollingRate?.pollingRate);
  add('pollingWireless', 'Synapse wireless polling (Hz)', rates('Polling'), state.pollingRate?.pollingRateWireless);
  add('lowPower', 'Synapse low power threshold (%)', { ...number('Threshold', 5, 100), step: 5 }, state.lowPowerModeReducer?.lowPowerMode);
  add('sleep', 'Synapse idle sleep (minutes)', number('Minutes', 1, 15), state.mousePowerSavingReducer?.powerSavingValue);
  const profiles = state.profileReducer?.profiles;
  const selected = profiles?.find(profile => profile.guid === state.profileReducer.selectedProfileGuid);
  if (selected) {
    add('profile', 'Active Synapse profile', { type: 'string', options: profiles.map(profile => ({ value: profile.guid, label: profile.name })) }, selected.guid);
    add('profileName', 'Rename active profile', text('Profile name'), selected.name);
    add('duplicateProfile', 'Duplicate active profile', text('New profile name'), `${selected.name} copy`);
    add('resetProfile', 'Reset active profile', bool('Confirm reset'), false, 'Applying with confirmation checked resets the active profile in Synapse.');
    if (profiles.length > 1) add('deleteProfile', 'Delete active profile', bool('Confirm deletion'), false, 'Applying with confirmation checked deletes the active profile in Synapse.');
    const slot = state.obm?.profiles?.[0];
    if (slot?.slotId !== undefined) {
      add('onboardProfile', 'On-board profile', { type: 'string', options: profiles.map(profile => ({ value: profile.guid, label: profile.name })) }, slot.guid || selected.guid);
      add('removeOnboardProfile', 'Remove on-board profile', bool('Confirm removal'), false);
    }
  }
  add('leftHand', 'Left-handed mode', bool('Left-handed mode'), state.mouseUseReducer?.leftHandMode);
  const inGame = state.inGamePollingRate;
  if (inGame) add('inGamePolling', 'In-game polling', object({ enabled: bool('Enabled'), wired: rates('Wired (Hz)'), wireless: rates('Wireless (Hz)') }), { enabled: !!inGame.isInGamePollingRateEnabled, wired: inGame.inGamePollingRate, wireless: inGame.inGamePollingRateWireless });
  add('rotation', 'Synapse sensor rotation', object({ isEnabled: bool('Enabled'), value: number('Angle (degrees)', -44, 44) }), state.rotationReducer?.rotation);
  const dynamic = state.dynamicSensitivityReducer?.dynamicSensitivity;
  if (dynamic) add('dynamic', 'Synapse dynamic sensitivity', object({ state: { type: 'number', label: 'State', options: [{ value: 0, label: 'Off' }, { value: 1, label: 'On' }] }, mode: { type: 'number', label: 'Mode', options: [{ value: 0, label: 'Classic' }, { value: 1, label: 'Natural' }, { value: 2, label: 'Jump' }, { value: 3, label: 'Custom' }] } }), { state: dynamic.state, mode: dynamic.mode });
  if (dynamic) add('customCurve', 'Custom sensitivity curve (250 points)', { type: 'json', format: 'curve' }, dynamic.customSensorAccelerations || [], 'Paste exactly 250 positive output speed numbers as a JSON array. An empty array means no custom curve is stored; it is not a device default.');
  const calibration = state.smartOnlyCalibrationReducer?.smartTracking;
  if (calibration) {
    add('calibration', 'Synapse tracking calibration', object({ isAsymmetric: bool('Asymmetric tracking'), trackingDistance: number('Tracking distance', 1, 3), liftOffDistance: number('Lift-off distance', 2, 26), landingDistance: number('Landing distance', 1, 25) }), { isAsymmetric: calibration.isAsymmetric, trackingDistance: calibration.trackingDistance, liftOffDistance: calibration.liftOffDistance, landingDistance: calibration.landingDistance });
    result.at(-1).writable = false; result.at(-1).description = 'Current Synapse calibration state. Use direct hardware mode to apply tracking changes; this session path has no confirmed completion receipt.';
  }
  if (Array.isArray(state.customizeReducer?.mappingList)) {
    add('advancedMappings', 'Advanced button mappings', { type: 'json', format: 'mapping-list' }, state.customizeReducer.mappingList, 'Edit the complete mapping list as JSON. Supports keyboard, mouse, media, sensitivity, macros, profiles, text and application actions through Synapse. Other groups are preserved. Macros require Synapse and are unavailable in on-board memory.');
    add('mouseMapping', 'Mouse button assignment', object({ button: { type: 'string', label: 'Button', options: buttonIds }, hypershift: bool('Hypershift layer'), assignment: { type: 'string', label: 'Action', options: [...mouseActions, 'Default', 'Disable', 'Hypershift'] } }), { button: 'Button4', hypershift: false, assignment: 'Previous' }, 'Changes one button and preserves all other mappings. The last standard left-click action cannot be removed.');
  }
  return result;
}
export function sessionCommand(id, value, state) {
  const profiles = state.profileReducer?.profiles || [];
  const active = profiles.find(profile => profile.guid === state.profileReducer?.selectedProfileGuid);
  const event = (type, payload) => ({ type, payload });
  switch (id) {
    case 'session.dpiStages': if (value.active > value.stages.length) throw new Error('Active stage exceeds stage count'); return event('ON_STAGES_CHANGE', value);
    case 'session.polling': return event('ON_POLLING_RATE', { pollingRate: value });
    case 'session.pollingWireless': return event('ON_POLLING_RATE', { pollingRateWireless: value });
    case 'session.lowPower': return event('ON_SET_LOW_POWER_MODE', { lowPowerMode: value });
    case 'session.sleep': return event('ON_SET_POWER_SAVING_VALUE', { powerSavingValue: value });
    case 'session.profile': if (!profiles.some(profile => profile.guid === value)) throw new Error('Unknown profile'); return event('ON_SWITCH_PROFILE', { newActiveProfileGUID: value });
    case 'session.profileName': if (!active || !value.trim()) throw new Error('A profile name is required'); return event('ON_RENAME_PROFILE', { newName: value, renameProfileGUID: active.guid });
    case 'session.duplicateProfile': {
      if (!active || !value.trim()) throw new Error('A profile name is required');
      return event('ON_DUPLICATE_PROFILE', { newProfile: { ...structuredClone(active), guid: randomUUID(), name: value }, sourceProfileGuid: active.guid });
    }
    case 'session.resetProfile': if (!active || value !== true) throw new Error('Check confirmation before resetting the profile'); return event('ON_RESET_PROFILE', { profileGuid: active.guid });
    case 'session.deleteProfile': if (!active || value !== true || profiles.length < 2) throw new Error('Confirm deletion and keep at least one profile'); return event('ON_DELETE_PROFILE', { deletedGUID: active.guid, newSelectedProfileGUID: profiles.find(profile => profile.guid !== active.guid).guid });
    case 'session.onboardProfile': { const profile = profiles.find(profile => profile.guid === value), slot = state.obm?.profiles?.[0]; if (!profile || slot?.slotId === undefined) throw new Error('Profile or on-board slot unavailable'); return event('ON_SET_OBM_PROFILE', { slotId: slot.slotId, name: profile.name, guid: profile.guid }); }
    case 'session.removeOnboardProfile': if (value !== true || state.obm?.profiles?.[0]?.slotId === undefined) throw new Error('Confirm on-board profile removal'); return event('ON_REMOVE_OBM_PROFILE', { slotId: state.obm.profiles[0].slotId });
    case 'session.leftHand': return event('ON_SET_LEFT_HAND_MODE', { isLeftHandMode: value });
    case 'session.inGamePolling': return event('ON_SET_IN_GAME_POLLING_RATE', { inGamePollingRateData: { state: Number(value.enabled), wired: value.wired, wireless: value.wireless } });
    case 'session.rotation': return event('ON_SET_ROTATION', { rotation: value });
    case 'session.dynamic': return event('ON_SET_DYNAMIC_SENSITIVITY', { dynamicSensitivity: { ...state.dynamicSensitivityReducer.dynamicSensitivity, ...value } });
    case 'session.customCurve': return event('ON_SET_DYNAMIC_SENSITIVITY', { dynamicSensitivity: { ...state.dynamicSensitivityReducer.dynamicSensitivity, state: 1, mode: 3, customSensorAccelerations: value } });
    case 'session.calibration': if (value.isAsymmetric && value.landingDistance >= value.liftOffDistance) throw new Error('Landing distance must be below lift-off distance'); return { events: [event('SET_SMART_TRACKING_VALUE', { smartTracking: value }), event('SET_SMART_CALIBRATION_DATA_TO_LOCAL_STORAGE_FROM_UI', { smartTracking: value })] };
    case 'session.mouseMapping': {
      const mappings = structuredClone(state.customizeReducer.mappingList);
      const same = item => item.inputID === value.button && !!item.isHyperShift === value.hypershift;
      const previous = mappings.find(same);
      const inputType = previous?.inputType || (value.button === 'DKM_SB_03' ? 'DKMInput' : 'MouseInput');
      const mapping = { inputID: value.button, inputType, isHyperShift: value.hypershift };
      if (value.assignment === 'Default') mapping.isDefault = true;
      else if (value.assignment === 'Disable') mapping.outputType = 'disableGroup';
      else if (value.assignment === 'Hypershift') mapping.outputType = 'hyperShiftGroup';
      else { mapping.outputType = 'mouseGroup'; mapping.mouseInput = value.button; mapping.mouseGroup = { mouseAssignment: value.assignment }; }
      const next = mappings.filter(item => !same(item)); next.push(mapping);
      validateMappings(next);
      return event('ON_SET_KEYMAPPING', { mappingList: next, viewIndex: state.customizeReducer.viewIndex, sidepadLayout: state.customizeReducer.sidepadLayout });
    }
    case 'session.advancedMappings': validateMappings(value); return event('ON_SET_KEYMAPPING', { mappingList: value, viewIndex: state.customizeReducer.viewIndex, sidepadLayout: state.customizeReducer.sidepadLayout });
    default: throw new Error('Unsupported Synapse setting');
  }
}
