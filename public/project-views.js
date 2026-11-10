import { el, button, link, panel } from './dom.js';
import { t, label } from './i18n.js';
import { settingTab, sleepScale } from './state.js';
import { settingForm } from './views.js';

const readValue = value => value === undefined || value === null ? t('notRead') : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
const header = title => { const node = el('header', 'view-header'); node.append(el('h1', '', title)); return node; };
const select = (label, options, value, id = `project-${Math.random().toString(36).slice(2)}`) => {
  const control = el('select', '', null, { id, 'aria-label': label }); options.forEach(([text, option]) => control.append(el('option', '', text, { value: option })));
  control.value = value; return control;
};

export function profilesPage(store, library, actions) {
  const view = el('div', 'profiles-page'); view.append(header(t('profiles')));
  const entries = [...store.entries().values()], profileEntries = entries.filter(entry => settingTab(entry.schema.id) === 'profile');
  const host = panel(t('hostProfiles'), 'profile-card');
  host.append(el('p', 'muted', profileEntries.length ? t('hostProfileSchema') : store.connected ? t('profileSchemaMissing') : t('connectToInspect')));
  profileEntries.filter(entry => !entry.schema.id.toLowerCase().includes('onboard')).forEach(entry => host.append(settingForm(entry, store, actions)));
  const onboardEntries = profileEntries.filter(entry => entry.schema.id.toLowerCase().includes('onboard'));
  const onboard = panel(t('onboardStorage'), 'profile-card');
  onboard.append(el('p', 'muted', onboardEntries.length ? t('onboardSchema') : t('onboardUnverified')));
  onboardEntries.forEach(entry => onboard.append(settingForm(entry, store, actions)));
  const macroStorage = panel(t('macroStorage'), 'profile-card');
  macroStorage.append(el('p', 'muted', t(library.persistent ? 'macroBrowserSaved' : 'macroMemoryOnly')), el('p', 'muted', t('macroNoExecution')));
  view.append(host, onboard, macroStorage); return view;
}

const families = [
  ['keyboardFamily', 'keyboardFeatures'], ['audioFamily', 'audioFeatures'], ['cameraFamily', 'cameraFeatures'],
  ['controllerFamily', 'controllerFeatures'], ['lightingFamily', 'lightingFeatures'], ['systemFamily', 'systemFeatures'], ['accessoryFamily', 'accessoryFeatures']
];
export function catalogPage() {
  const view = el('div', 'catalog-page'); view.append(header(t('catalog')));
  view.append(el('p', 'view-subtitle', t('catalogHelp')));
  const grid = el('div', 'catalog-grid');
  for (const [title, features] of families) {
    const card = panel(t(title), 'catalog-card'); card.append(el('p', 'muted', t('referenceOnly')), el('p', '', t(features)));
    if (title === 'keyboardFamily') card.append(link(t('keyboardReference'), '#catalog/keyboard'));
    grid.append(card);
  }
  view.append(grid); return view;
}

export function keyboardReferencePage(store, actions) {
  const view = el('div', 'keyboard-reference'); view.append(header(t('keyboardReference')));
  view.append(el('p', 'view-subtitle', t('keyboardReferenceHelp')));
  const available = [...store.entries().values()].filter(entry => /keyboard.*(mapping|assignment)|keymap/i.test(entry.schema.id) && entry.schema.writable);
  const layer = panel(t('keyboardLayers'), 'keyboard-layers');
  for (const name of ['standardLayer', 'hypershiftLayer']) { const control = button(t(name), () => {}, 'secondary'); control.disabled = true; layer.append(control); }
  layer.append(el('p', 'muted', t(available.length ? 'keymapDataOnly' : 'noKeyboardSchema')));
  const keyList = panel(t('keyNames'), 'keyboard-keys');
  for (const row of [['Esc','F1','F2','F3','F4','F5','F6','F7','F8','F9','F10','F11','F12'], ['Tab','Q','W','E','R','T','Y','U','I','O','P'], ['Caps','A','S','D','F','G','H','J','K','L'], ['Shift','Z','X','C','V','B','N','M','Enter'], ['Ctrl','Win','Alt','Space','Alt','Fn','Ctrl']]) {
    const line = el('div', 'key-reference-row'); for (const key of row) { const keyButton = button(key, () => {}, 'reference-key'); keyButton.disabled = true; line.append(keyButton); } keyList.append(line);
  }
  const drawer = panel(t('mappingEditor'), 'mapping-drawer');
  if (available.length) available.forEach(entry => drawer.append(settingForm(entry, store, actions)));
  else drawer.append(el('p', 'muted', t('mappingEditorUnavailable')));
  view.append(layer, keyList, drawer, link(t('catalog'), '#catalog')); return view;
}

const settingValue = (id, value) => {
  if (value === null || value === undefined) return t('notRead');
  const key = id.replace(/^session\./, '');
  if (key === 'sleep' && typeof value === 'number') return `${value / sleepScale(id)} ${t('minutes')}`;
  if (['polling', 'pollingWired', 'pollingWireless', 'inGamePolling'].includes(key) && typeof value === 'number') return `${value} Hz`;
  if (key === 'lowPower' && typeof value === 'number') return `${value}%`;
  return readValue(value);
};
const resultText = item => item.status === 'success' ? `${t(item.verification || 'applied')}${item.warning ? ` · ${t(item.warning)}` : ''}` : item.message ? t(item.message) : item.warning ? t(item.warning) : t(item.status);
export function reviewPage(ledger, store, actions) {
  const view = el('div', 'review-page'), heading = header(t('reviewChanges')); heading.id = 'review-heading'; view.append(heading);
  const current = store.devices.find(device => device.id === store.selectedDeviceId), items = ledger.forDevice(store.selectedDeviceId);
  const context = panel(current?.name || t('selectedDevice'), 'review-context');
  context.append(el('p', 'muted', store.selectedDeviceId ? t('reviewPhysicalDevice') : t('openDeviceToReview')));
  if (store.selectedDeviceId) { const identity = el('details'); identity.append(el('summary', '', t('physicalDeviceId')), el('code', '', store.selectedDeviceId)); context.append(identity); }
  view.append(context);
  const list = panel(t('pendingChanges'), 'review-list');
  if (!items.length) list.append(el('p', 'muted', t('noPendingChanges')));
  for (const item of items) {
    const row = el('article', `review-row ${item.status}`), title = el('h3', '', item.schema ? label(item.schema) : item.label), table = el('dl', 'review-values'); row.dataset.setting = item.settingId; row.dataset.status = item.status;
    table.append(el('dt', '', t('beforeValue')), el('dd', '', settingValue(item.settingId, item.before)), el('dt', '', t(item.status === 'success' ? 'requestedValue' : 'draftValue')), el('dd', '', settingValue(item.settingId, item.value)));
    if (Object.hasOwn(item, 'actual')) table.append(el('dt', '', t('latestReadback')), el('dd', '', settingValue(item.settingId, item.actual)));
    table.append(el('dt', '', t('result')), el('dd', '', resultText(item)));
    row.append(title, table);
    const actionsRow = el('div', 'actions');
    if (['uncertain', 'unresolved'].includes(item.status) || item.status === 'needs-review' && item.message === 'deviceRefreshRequired') { const read = button(t('readDeviceAgain'), () => actions.reconcileRead(item.id), 'secondary'); read.dataset.action = 'review-read'; actionsRow.append(read); }
    if (item.status === 'uncertain' && ['noReadback', 'stale', 'deviceRefreshRequired'].includes(item.message)) { const retire = button(t('retireUncertain'), () => actions.retireUncertain(item.id), 'secondary'); retire.dataset.action = 'review-retire'; actionsRow.append(retire); }
    if (item.status === 'reconcile-ready') { row.append(el('p', 'warning-copy', `${t('latestReadback')}: ${settingValue(item.settingId, item.actual)}`)); const accept = button(t('acceptReadbackAndReview'), () => actions.reconcile(item.id), 'primary'); accept.dataset.action = 'review-accept'; actionsRow.append(accept); }
    if (item.status === 'needs-review' && store.entry(item.settingId)?.actualFresh) actionsRow.append(button(t('reviewCurrentValue'), () => actions.stage(item.settingId), 'primary'));
    if (item.status === 'unresolved') { const fresh = button(t('startNewDraft'), () => actions.startNewDraft(item.id), 'secondary'); fresh.dataset.action = 'review-new-draft'; actionsRow.append(fresh); }
    if (['pending', 'needs-review'].includes(item.status)) actionsRow.append(button(t('cancelReviewItem'), () => actions.cancelReviewItem(item.id), 'secondary'));
    if (['pending', 'failed', 'needs-review'].includes(item.status)) actionsRow.append(link(t('editSetting'), settingTab(item.settingId) === 'profile' ? '#profiles' : `#device/${settingTab(item.settingId)}`));
    if (actionsRow.childElementCount) row.append(actionsRow); list.append(row);
  }
  const other = ledger.items.filter(item => item.deviceId !== store.selectedDeviceId);
  if (other.length) {
    const otherDevices = panel(t('otherDeviceReview'), 'other-review-list');
    for (const item of other) otherDevices.append(el('p', '', `${item.deviceName || item.deviceId} · ${t(item.status)}`));
    otherDevices.append(link(t('openDevice'), '#dashboard')); view.append(otherDevices);
  }
  const apply = button(t('applyRemaining'), () => actions.applyReview(), 'primary'); apply.id = 'review-apply';
  apply.disabled = !ledger.pending(store.selectedDeviceId).length || !store.connected || store.busy || store.lockEdits || actions.reviewBlocked;
  const footer = el('div', 'actions'); footer.append(apply); view.append(list, footer, el('p', 'review-status', actions.reviewMessage ? t(actions.reviewMessage) : '', { id: 'review-status', role: 'status', 'aria-live': 'polite', tabindex: '-1' }));
  return view;
}
