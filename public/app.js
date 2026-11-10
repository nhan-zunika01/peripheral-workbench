import { createStore, equal, parseRoute, settingTab, tabs } from './state.js';
import { createTransport } from './transport.js';
import { createMacroLibrary } from './macros.js';
import { createReviewLedger } from './review.js';
import { t, setLocale, getLocale, label } from './i18n.js';
import { el, link, button } from './dom.js';
import { dashboard, devicePage, settingsPage, syncForms } from './views.js';
import { catalogPage, keyboardReferencePage, profilesPage, reviewPage } from './project-views.js';
import { macrosPage } from './macro-view.js';
import { initMotion, moveIndicator, indicatorPosition, feedback } from './motion.js';

const $ = id => document.getElementById(id), store = createStore(), transport = createTransport(), macros = createMacroLibrary(), review = createReviewLedger();
let initialized = false, menuOpen = false, displayedRoute = '', notification = '', notificationError = false, selectedMacroId = '', selectedMacroEventIndex = -1, macroSearch = '', macroMessage = '', reviewMessage = '';
setLocale(getLocale());
const route = () => { const current = parseRoute(location.hash); return tabs.includes(current) && !store.selectedDeviceId ? 'dashboard' : current; };
const actions = {
  refresh: () => refresh(true), openDevice, stage, stageAll, applyReview, reconcileRead, reconcile, cancelReviewItem,
  startNewDraft,
  cancelDraft: id => review.cancelSetting(store.selectedDeviceId, id),
  sync, locale: value => { if (!store.lockEdits) { setLocale(value); render(); } },
  imageChanged: target => feedback(target, 'image'),
  copy: async () => { try { await navigator.clipboard.writeText(`npm run bridge -- --origin ${location.origin}`); notify('copied'); } catch { notify('copyFailed'); } },
  get macroMessage() { return macroMessage; },
  get reviewMessage() { return reviewMessage; },
  get reviewBlocked() { return hasBlockingUncertainty(); },
  createMacro: () => {
    const macro = macros.create(); if (!macro) macroMessage = 'macroLimit'; else { selectedMacroId = macro.id; selectedMacroEventIndex = -1; macroMessage = ''; location.hash = '#macros'; }
    render({ restore: { id: macro ? 'macro-name' : 'macro-create' } });
  },
  selectMacro: id => { selectedMacroId = id; selectedMacroEventIndex = macros.macros.find(item => item.id === id)?.events.length ? 0 : -1; macroMessage = ''; render({ restore: { id: `macro-choice-${id}` } }); },
  selectMacroEvent: index => { selectedMacroEventIndex = index; render({ restore: { id: `macro-event-${index}` } }); },
  updateMacro: (id, changes, redraw = true, restoreId = '') => {
    const saved = macros.update(id, changes); if (!saved) macroMessage = 'macroInvalid'; else macroMessage = '';
    if (redraw) render({ restore: restoreId ? { id: restoreId } : null }); else sync();
    return saved;
  },
  renameMacro: (id, value, restoreId) => actions.updateMacro(id, { name: value.trim() }, true, restoreId),
  setMacroSearch: value => { macroSearch = value; },
  addMacroEvent: (id, kind) => {
    const macro = macros.macros.find(item => item.id === id); if (!macro) return;
    const event = kind === 'delay' ? { kind, delayMs: 0 } : { kind, input: kind === 'mouse' ? 'left' : '', action: 'down', delayMs: 0 };
    const index = macro.events.length;
    if (actions.updateMacro(id, { events: [...macro.events, event] }, false)) { selectedMacroEventIndex = index; render({ restore: { id: `macro-event-${index}` } }); }
  },
  changeMacroEvent: (id, index, changes, restoreId = '') => {
    const macro = macros.macros.find(item => item.id === id), current = macro?.events[index]; if (!current) return;
    let event = { ...current, ...changes };
    if (changes.kind) event = changes.kind === 'delay' ? { kind: 'delay', delayMs: current.delayMs } : { kind: changes.kind, input: changes.kind === 'mouse' ? 'left' : '', action: 'down', delayMs: current.delayMs };
    if (actions.updateMacro(id, { events: macro.events.map((item, i) => i === index ? event : item) }, true, restoreId)) selectedMacroEventIndex = index;
  },
  editMacroEvent: (id, index, changes, control) => {
    const macro = macros.macros.find(item => item.id === id); if (!macro?.events[index]) return;
    const saved = actions.updateMacro(id, { events: macro.events.map((item, i) => i === index ? { ...item, ...changes } : item) }, false);
    if (saved) control.removeAttribute('aria-invalid');
    else { control.value = macro.events[index]?.[Object.keys(changes)[0]] ?? ''; control.setAttribute('aria-invalid', 'true'); }
  },
  moveMacroEvent: (id, index, delta) => {
    const macro = macros.macros.find(item => item.id === id), target = index + delta;
    if (!macro || index < 0 || target < 0 || target >= macro.events.length) return;
    const events = [...macro.events]; [events[index], events[target]] = [events[target], events[index]];
    if (actions.updateMacro(id, { events }, false)) { selectedMacroEventIndex = target; render({ restore: { id: `macro-event-${target}` } }); }
  },
  removeMacroEvent: (id, index) => {
    const macro = macros.macros.find(item => item.id === id); if (!macro || index < 0 || !macro.events[index]) return;
    const events = macro.events.filter((_, i) => i !== index);
    if (actions.updateMacro(id, { events }, false)) { selectedMacroEventIndex = Math.min(index, events.length - 1); render({ restore: { id: selectedMacroEventIndex >= 0 ? `macro-event-${selectedMacroEventIndex}` : 'macro-insert-trigger' } }); }
  },
  duplicateMacro: id => {
    const original = macros.macros.find(item => item.id === id); if (!original) return;
    const copy = macros.create(); if (!copy) { macroMessage = 'macroLimit'; sync(); return; }
    const suffix = ` (${t('copySuffix')})`, name = `${original.name.slice(0, 64 - suffix.length)}${suffix}`;
    macros.update(copy.id, { name, events: structuredClone(original.events) }); selectedMacroId = copy.id;
    selectedMacroEventIndex = macros.macros.find(item => item.id === copy.id)?.events.length ? 0 : -1; macroMessage = ''; render({ restore: { id: 'macro-name' } });
  },
  saveMacros: () => {
    if (!macros.valid) macroMessage = 'macroInvalid';
    else macroMessage = macros.save() ? 'macroSaved' : macros.error || 'macroStorageWrite';
    render({ restore: { id: 'save-macros' } });
  },
  deleteMacro: async id => {
    const macro = macros.macros.find(item => item.id === id); if (!macro || !await confirmChange('deleteMacroTitle', macro.name, 'deleteMacroConfirm')) return;
    macros.remove(id); if (selectedMacroId === id) { selectedMacroId = macros.macros[0]?.id || ''; selectedMacroEventIndex = macros.macros[0]?.events.length ? 0 : -1; } macroMessage = '';
    render({ restore: { id: selectedMacroId ? 'macro-name' : 'macro-create' } });
  },
  importMacros: source => {
    const imported = macros.import(source); selectedMacroId = imported[0]?.id || selectedMacroId; selectedMacroEventIndex = imported[0]?.events.length ? 0 : -1; macroMessage = 'macroImported';
    render({ restore: { id: selectedMacroId ? 'macro-name' : 'macro-import' } });
  },
  setMacroMessage: key => { macroMessage = key || ''; sync(); },
  refreshView: () => render(),
  retireUncertain: id => retireUncertain(id)
};

function notify(key, error = false) { notification = key; notificationError = error; sync(); }
function retiredSettings(deviceId) {
  const latest = new Map(review.forDevice(deviceId).map(item => [item.settingId, item]));
  return new Set([...latest.values()].filter(item => item.status === 'unresolved').map(item => item.settingId));
}
function hasBlockingUncertainty(deviceId = store.selectedDeviceId) {
  const skipped = retiredSettings(deviceId);
  return [...store.entries().values()].some(entry => entry.uncertain && !skipped.has(entry.schema.id));
}
function navKey(current) { return ['macros', 'profiles', 'settings', 'review'].includes(current) ? current : 'devices'; }
function draftEntries() {
  const retired = retiredSettings(store.selectedDeviceId);
  return [...store.entries().values()].filter(entry => entry.dirty && !(entry.uncertain && retired.has(entry.schema.id)));
}
function captureFocus() {
  const active = document.activeElement, form = active?.closest('[data-setting]');
  if (form && active.dataset.fieldPath !== undefined) return { setting: form.dataset.setting, path: active.dataset.fieldPath };
  if (active?.id) return { id: active.id };
  if (active?.dataset.action) return { action: active.dataset.action };
  return null;
}
function restoreFocus(target) {
  if (!target) return;
  let node;
  if (target.setting) node = [...document.querySelectorAll(`[data-setting="${CSS.escape(target.setting)}"] [data-field-path]`)].find(item => item.dataset.fieldPath === target.path);
  else if (target.action) node = document.querySelector(`[data-action="${CSS.escape(target.action)}"]`);
  else node = $(target.id);
  node?.focus({ preventScroll: true });
}
function sync() {
  document.querySelectorAll('[data-i18n]').forEach(node => { node.textContent = t(node.dataset.i18n); });
  $('main-nav').setAttribute('aria-label', t('menu')); $('menu-toggle').setAttribute('aria-label', t(menuOpen ? 'closeMenu' : 'menu'));
  const current = route(), activeNav = navKey(current);
  document.querySelectorAll('[data-nav]').forEach(anchor => { if (anchor.dataset.nav === activeNav) anchor.setAttribute('aria-current', 'page'); else anchor.removeAttribute('aria-current'); anchor.setAttribute('aria-disabled', String(store.lockEdits)); });
  const companionState = store.busy && !initialized ? 'connecting' : store.companion ? 'companionConnected' : 'companionOffline';
  $('companion-label').textContent = t(companionState); $('connection-dot').classList.toggle('online', store.companion);
  const device = store.devices.find(item => item.id === store.selectedDeviceId), section = ['macros', 'profiles', 'settings', 'catalog', 'catalog/keyboard', 'review'].includes(current) ? t(current === 'catalog/keyboard' ? 'keyboardReference' : current) : t(current === 'dashboard' ? 'dashboard' : 'devices');
  $('breadcrumb').textContent = `${section}${tabs.includes(current) ? ` / ${device?.name || store.snapshot.model || t('disconnected')}` : ''}`;
  $('app-status').textContent = current === 'macros' || !notification ? '' : t(notification); $('app-status').classList.toggle('error', current !== 'macros' && notificationError);
  document.querySelectorAll('[data-action=refresh]').forEach(control => { control.disabled = store.busy; control.textContent = t(store.busy ? 'updating' : 'refresh'); });
  document.querySelectorAll('[data-action=device]').forEach(control => { control.disabled = store.busy; });
  if ($('language-select')) $('language-select').disabled = store.lockEdits;
  document.querySelectorAll('[role=tab]').forEach(anchor => anchor.setAttribute('aria-disabled', String(store.lockEdits)));
  const banner = $('connection-banner'), stale = [...store.entries().values()].some(entry => entry.stale), lost = !store.companion || !store.connected;
  banner.replaceChildren(); banner.hidden = ![...tabs, 'profiles', 'review'].includes(current) || (!stale && !lost);
  if (!banner.hidden) {
    banner.append(el('span', '', t(stale ? 'stale' : store.dirty() ? 'retained' : 'unavailable')));
    if (stale) { const reload = button(t('reload'), actions.refresh); reload.disabled = store.busy; banner.append(reload); }
    else banner.append(link(t('connectionHelp'), '#settings'));
  }
  const macroStatus = $('macro-status'); if (macroStatus) macroStatus.textContent = t(macros.error || macroMessage || (!macros.valid ? 'macroInvalid' : !macros.persistent ? 'macroMemoryOnly' : 'macroSaved'));
  const exportButton = document.querySelector('[data-action=export-macros]'); if (exportButton) exportButton.disabled = !macros.valid || macroMessage === 'macroInvalid';
  const saveMacros = document.querySelector('[data-action=save-macros]'); if (saveMacros) saveMacros.disabled = !macros.valid || !macros.writable;
  document.querySelectorAll('[data-action=review-read]').forEach(control => { control.disabled = store.busy; });
  const reviewApply = $('review-apply'); if (reviewApply) reviewApply.disabled = !review.pending(store.selectedDeviceId).length || !store.connected || store.busy || store.lockEdits || actions.reviewBlocked;
  syncForms($('view'), store);
  const drafts = draftEntries();
  document.querySelectorAll('[data-console-count]').forEach(node => { node.textContent = t('consoleDraftCount').replace('{count}', drafts.length); });
  document.querySelectorAll('[data-action=review-drafts]').forEach(control => {
    control.disabled = store.busy || store.lockEdits || !drafts.length || hasBlockingUncertainty() || drafts.some(entry => !store.canApply(entry.schema.id));
  });
}

function render({ focus = false, animateTab = false, restore = null } = {}) {
  const previous = animateTab ? indicatorPosition() : null, current = route();
  const opened = [...$('view').querySelectorAll('details[id][open]')].map(node => node.id);
  if (current === 'macros' && !selectedMacroId && macros.macros.length) { selectedMacroId = macros.macros[0].id; selectedMacroEventIndex = macros.macros[0].events.length ? 0 : -1; }
  const page = current === 'dashboard' ? dashboard(store, actions)
    : current === 'settings' ? settingsPage(store, actions)
    : current === 'macros' ? macrosPage(macros, selectedMacroId, selectedMacroEventIndex, macroSearch, actions)
    : current === 'profiles' ? profilesPage(store, macros, actions)
    : current === 'catalog' ? catalogPage()
    : current === 'catalog/keyboard' ? keyboardReferencePage(store, actions)
    : current === 'review' ? reviewPage(review, store, actions)
    : devicePage(store, current, actions);
  $('view').replaceChildren(page);
  document.title = `${t(current === 'dashboard' ? 'devices' : current === 'catalog/keyboard' ? 'keyboardReference' : current)} — Device Control`;
  displayedRoute = current; sync(); moveIndicator(previous);
  opened.forEach(id => { const details = $(id); if (details?.tagName === 'DETAILS') details.open = true; });
  if (focus) { const active = $(`console-section-${current}`); if (active) { active.focus({ preventScroll: true }); active.scrollIntoView({ block: 'start' }); } else $('content').focus({ preventScroll: true }); }
  else restoreFocus(restore);
}

async function confirmChange(title, description, action) {
  const dialog = $('confirmation'); if (dialog.open) return false;
  const trigger = document.activeElement;
  $('dialog-title').textContent = t(title); $('dialog-description').textContent = description;
  $('dialog-cancel').textContent = t('keepEditing'); $('dialog-confirm').textContent = t(action);
  dialog.returnValue = ''; dialog.showModal(); $('dialog-cancel').focus(); feedback(dialog);
  return new Promise(resolve => dialog.addEventListener('close', () => { trigger?.isConnected && trigger.focus(); resolve(dialog.returnValue === 'confirm'); }, { once: true }));
}

async function refresh(manual = false) {
  if (store.busy || transport.busy || (!manual && document.hidden)) return;
  const focus = captureFocus(), uncertain = store.hasUncertain(), deviceId = store.selectedDeviceId;
  const discardDraft = manual && store.dirty() && !uncertain;
  if (discardDraft && !await confirmChange('reloadTitle', t('discardHelp'), 'discardReload')) return;
  store.busy = true; store.lockEdits = manual || !initialized; sync();
  try {
    const result = await transport.read(deviceId);
    if (result) {
      const validRead = result.connected === true && (!deviceId || result.selectedDeviceId === deviceId);
      store.ingest(result, { discard: discardDraft && validRead });
      if (uncertain && manual && validRead) markReconcileReady(deviceId, result);
      if (discardDraft && validRead) review.cancelPending(deviceId);
      if (discardDraft && !validRead) notification = 'draftKept';
    }
    initialized = true;
    if (manual && !notification) { notification = 'refreshDone'; notificationError = false; }
    else if (['offlineHelp', 'error', 'originError'].includes(notification)) notification = '';
  } catch (error) {
    store.connected = false; store.companion = false; initialized = true;
    notification = error.status === 403 ? 'originError' : error instanceof TypeError || error.name === 'TimeoutError' ? 'offlineHelp' : 'error'; notificationError = true;
  } finally {
    store.busy = false; store.lockEdits = false;
    const preserveMacro = !manual && displayedRoute === 'macros' && route() === 'macros';
    const focusNow = captureFocus(), preserveDom = !manual && $('view').contains(document.activeElement) && (
      focusNow?.setting ||
      (route() === 'macros' && document.activeElement.matches('input,select,textarea'))
    );
    if ((preserveMacro || preserveDom) && displayedRoute === route()) sync(); else render({ restore: focusNow || focus });
  }
}

function markReconcileReady(deviceId, snapshot) {
  for (const item of review.forDevice(deviceId).filter(operation => ['uncertain', 'unresolved'].includes(operation.status))) {
    const entry = store.entry(item.settingId);
    const setting = snapshot?.settings?.find(value => value.id === item.settingId);
    if (entry?.actualFresh && !entry.stale && entry.signature === entry.actualSignature && setting && setting.value !== null && setting.value !== undefined) { item.actual = structuredClone(setting.value); item.status = 'reconcile-ready'; item.message = ''; }
    else item.message = entry?.stale ? 'stale' : 'noReadback';
  }
}

async function openDevice(id) {
  if (store.busy || transport.busy) return;
  if (id !== store.selectedDeviceId) {
    const unresolved = review.forDevice(store.selectedDeviceId).some(item => item.status === 'unresolved');
    if (hasBlockingUncertainty()) { location.hash = '#review'; notify('reconcileBeforeSwitch', true); return; }
    if (store.dirty() && !unresolved && !await confirmChange('switchTitle', t('discardHelp'), 'discardSwitch')) return;
    if (!unresolved) { review.cancelPending(store.selectedDeviceId); store.discard(); }
    store.select(id); location.hash = '#device/customize'; render(); await refresh();
  } else if (location.hash === '#device/customize') render(); else location.hash = '#device/customize';
}

function stage(id) {
  const entry = store.entry(id);
  if (!store.canApply(id)) { notify('reviewUnavailable', true); return; }
  const operation = review.stage(store.selectedDeviceId, entry);
  if (!operation) { notify('reviewUnavailable', true); return; }
  operation.deviceName = store.devices.find(device => device.id === store.selectedDeviceId)?.name || store.snapshot.model || '';
  reviewMessage = '';
  if (location.hash === '#review') render(); else location.hash = '#review';
}

function stageAll() {
  const drafts = draftEntries();
  if (store.busy || store.lockEdits || hasBlockingUncertainty() || drafts.some(entry => !store.canApply(entry.schema.id))) { notify('reviewUnavailable', true); return; }
  const conflict = batchConflict([...new Set([...drafts.map(entry => entry.schema.id), ...review.pending(store.selectedDeviceId).map(item => item.settingId)])]);
  if (conflict) { notify(conflict, true); return; }
  const name = store.devices.find(device => device.id === store.selectedDeviceId)?.name || store.snapshot.model || '';
  for (const entry of drafts) {
    const operation = review.stage(store.selectedDeviceId, entry);
    if (operation) operation.deviceName = name;
  }
  reviewMessage = '';
  if (location.hash === '#review') render(); else location.hash = '#review';
}

const verificationKey = value => value === 'hardware-readback' ? 'hardwareReadback' : value?.includes('acknowledgement') ? 'acknowledgement' : value?.startsWith('synapse-') ? 'synapseVerified' : 'applied';
function batchConflict(ids) {
  const keys = ids.map(id => id.replace(/^session\./, ''));
  if (ids.length > 1 && ids.some(id => settingTab(id) === 'profile')) return 'profileReviewSeparate';
  if (keys.includes('customCurve') && keys.some(key => ['dynamicState', 'dynamicMode'].includes(key))) return 'curveReviewSeparate';
  if (keys.includes('asymmetricTracking') && keys.includes('smartTracking')) return 'trackingReviewSeparate';
  return '';
}
async function applyReview() {
  if (store.busy || transport.busy || !store.connected || hasBlockingUncertainty()) return;
  const deviceId = store.selectedDeviceId, pending = review.pending(deviceId);
  if (!pending.length) return;
  const conflict = batchConflict(pending.map(item => item.settingId));
  if (conflict) { reviewMessage = conflict; render({ restore: { id: 'review-status' } }); return; }
  for (const item of pending.filter(op => /^session\.(resetProfile|deleteProfile|removeOnboardProfile)$/.test(op.settingId))) {
    const current = store.entry(item.settingId), name = current?.baseline || item.label;
    if (!await confirmChange('destructiveTitle', `${item.label} — ${name}. ${t('destructiveHelp')}`, 'apply')) return;
  }
  const focus = { id: 'review-status' }; store.busy = true; store.lockEdits = true; reviewMessage = '';
  try {
    sync();
    for (const operation of pending) {
      const entryBeforeRead = store.entry(operation.settingId); let dispatched = false;
      try {
        const current = await transport.read(deviceId);
        if (current && current.selectedDeviceId === deviceId) store.ingest(current);
        if (!current?.connected || current.selectedDeviceId !== deviceId) { operation.message = 'deviceRefreshRequired'; reviewMessage = 'deviceRefreshRequired'; break; }
        const entry = store.entry(operation.settingId);
        if (!entry || entry.stale || !entry.dirty || entry.uncertain || !equal(entry.draft, operation.value) || !equal(entry.actual, operation.reviewedBefore)) {
          operation.before = entry ? structuredClone(entry.actual) : operation.before; operation.status = 'needs-review'; operation.message = entry?.stale ? 'stale' : 'externalChange'; break;
        }
        operation.message = '';
        dispatched = true;
        const result = await transport.apply(deviceId, operation.settingId, operation.value, operation.reviewedBefore);
        if (result?.verified !== true) throw Object.assign(new Error(t('unverified')), { status: 502 });
        const acknowledged = String(result.verification || '').includes('acknowledgement');
        const stateMatches = result.state?.selectedDeviceId === deviceId;
        if (!stateMatches && !acknowledged) throw new Error(t('unverified'));
        if (stateMatches) store.ingest(result.state, { applied: operation.settingId });
        const readback = stateMatches && result.state.connected === true ? result.state.settings?.find(setting => setting.id === operation.settingId) : null;
        const hasReadback = !!readback && !acknowledged;
        const key = verificationKey(result.verification);
        store.confirmApplied(operation.settingId, operation.value, key, { readback: hasReadback });
        const appliedEntry = store.entry(operation.settingId); if (appliedEntry) appliedEntry.technical = result.warning || '';
        operation.status = 'success'; operation.verification = key;
        if (hasReadback) operation.actual = structuredClone(readback.value);
        operation.warning = result.warning || (hasReadback && !equal(readback.value, operation.value) ? 'stateChangedAfterApply' : !hasReadback && !acknowledged ? 'readbackUnavailable' : ''); operation.message = '';
      } catch (error) {
        if (!dispatched) { operation.status = 'pending'; operation.message = 'deviceRefreshRequired'; reviewMessage = 'deviceRefreshRequired'; break; }
        if (error.code === 'STATE_CONFLICT') {
          const entry = store.entry(operation.settingId);
          if (entry && Object.hasOwn(error, 'actualValue')) {
            entry.actual = structuredClone(error.actualValue); entry.actualFresh = true; entry.actualSignature = entry.signature;
            entry.externalChange = !equal(entry.baseline, error.actualValue); operation.before = structuredClone(error.actualValue); operation.message = 'externalChange';
          } else operation.message = 'deviceRefreshRequired';
          operation.status = 'needs-review'; reviewMessage = operation.message; break;
        }
        const uncertain = !error.status || error.name === 'TimeoutError' || error.status >= 500;
        operation.status = uncertain ? 'uncertain' : 'failed'; operation.message = uncertain ? 'uncertain' : 'operationFailed'; operation.detail = error.message;
        const entry = store.entry(operation.settingId) || entryBeforeRead;
        if (entry) { entry.status = 'error'; entry.uncertain = uncertain; entry.technical = error.message; }
        if (uncertain) { reviewMessage = 'uncertain'; break; }
      }
    }
  } finally { store.busy = false; store.lockEdits = false; render({ restore: focus }); }
}

async function reconcileRead(operationId) {
  const operation = review.find(operationId);
  if (!operation || !(['uncertain', 'unresolved'].includes(operation.status) || operation.status === 'needs-review' && operation.message === 'deviceRefreshRequired') || operation.deviceId !== store.selectedDeviceId || store.busy || transport.busy) return;
  const focus = { id: 'review-status' }, deviceId = operation.deviceId;
  store.busy = true; store.lockEdits = true; sync();
  try {
    const current = await transport.read(deviceId);
    if (current) store.ingest(current);
    if (!current?.connected || current.selectedDeviceId !== deviceId) throw new Error('deviceRefreshRequired');
    if (operation.status === 'needs-review') {
      const entry = store.entry(operation.settingId); operation.before = entry ? structuredClone(entry.actual) : undefined;
      operation.message = 'externalChange'; reviewMessage = 'readbackReady';
    } else {
      markReconcileReady(deviceId, current);
      reviewMessage = review.find(operationId)?.status === 'reconcile-ready' ? 'readbackReady' : 'noReadback';
    }
  } catch { operation.message = 'deviceRefreshRequired'; reviewMessage = 'deviceRefreshRequired'; }
  finally { store.busy = false; store.lockEdits = false; render({ restore: focus }); }
}

function retireUncertain(operationId) {
  const operation = review.find(operationId);
  if (!operation || operation.status !== 'uncertain' || !['noReadback', 'stale', 'deviceRefreshRequired'].includes(operation.message)) return;
  operation.status = 'unresolved'; operation.message = 'uncertainSkipped'; reviewMessage = 'uncertainSkipped'; render();
}

function startNewDraft(operationId) {
  const operation = review.find(operationId), entry = operation?.deviceId === store.selectedDeviceId && operation.status === 'unresolved' ? store.entry(operation.settingId) : null;
  if (!entry) return;
  entry.draft = structuredClone(entry.baseline); entry.dirty = false; entry.uncertain = false; entry.actual = null; entry.actualFresh = false;
  entry.stale = true; entry.errors = []; entry.status = ''; entry.externalChange = false; entry.technical = '';
  location.hash = settingTab(entry.schema.id) === 'profile' ? '#profiles' : `#device/${settingTab(entry.schema.id)}`;
  render();
}

function cancelReviewItem(operationId) {
  if (review.cancel(operationId)) { reviewMessage = 'reviewItemCancelled'; render(); }
}

function reconcile(operationId) {
  const operation = review.find(operationId);
  if (!operation || operation.status !== 'reconcile-ready' || operation.deviceId !== store.selectedDeviceId) return;
  const entry = store.entry(operation.settingId); if (!store.reconcile(operation.settingId)) { operation.status = 'uncertain'; operation.message = 'noReadback'; render(); return; }
  operation.status = 'reconciled'; operation.message = 'readbackReviewed'; operation.actual = structuredClone(entry.actual);
  if (entry.dirty) { const next = review.stage(operation.deviceId, entry); if (next) { next.deviceName = operation.deviceName; reviewMessage = 'draftStagedAgain'; } }
  else reviewMessage = 'readbackMatchesDraft';
  render();
}

function setMenu(open) {
  menuOpen = open; document.body.classList.toggle('menu-open', open); $('menu-toggle').setAttribute('aria-expanded', String(open));
  if (open) { feedback($('sidebar'), 'menu'); $('main-nav').querySelector('a').focus(); }
}
$('menu-toggle').addEventListener('click', () => setMenu(!menuOpen));
document.addEventListener('click', event => {
  const anchor = event.target.closest('a');
  if (anchor && store.lockEdits && !anchor.classList.contains('skip-link')) { event.preventDefault(); return; }
  if (anchor?.matches('.console-section-link') && anchor.hash === location.hash) {
    event.preventDefault(); const target = $(`console-section-${route()}`); target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'start' });
  }
  if (anchor?.closest('#sidebar') || anchor?.closest('.console-navigation')) setMenu(false);
  else if (menuOpen && !event.target.closest('#sidebar,#menu-toggle')) setMenu(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menuOpen) { setMenu(false); $('menu-toggle').focus(); }
  if (menuOpen && event.key === 'Tab') {
    const items = [$('menu-toggle'), ...$('sidebar').querySelectorAll('a')], index = items.indexOf(document.activeElement);
    if (event.shiftKey && index <= 0) { event.preventDefault(); items.at(-1).focus(); } else if (!event.shiftKey && index === items.length - 1) { event.preventDefault(); items[0].focus(); }
  }
  const tab = event.target.closest('.console-section-link'); if (!tab || store.lockEdits) return;
  const buttons = [...document.querySelectorAll('.console-section-link')], index = buttons.indexOf(tab);
  const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length : event.key === 'ArrowLeft' ? (index - 1 + buttons.length) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
  if (next >= 0) { event.preventDefault(); buttons[next].focus(); buttons[next].scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); tab.click(); }
});
addEventListener('hashchange', () => {
  if (store.lockEdits) { history.replaceState(null, '', `#${tabs.includes(displayedRoute) ? `device/${displayedRoute}` : displayedRoute}`); return; }
  if (!/^#(dashboard|settings|macros|profiles|catalog|catalog\/keyboard|review|device\/(customize|performance|power|calibration|advanced))$/.test(location.hash)) history.replaceState(null, '', '#dashboard');
  render({ focus: true, animateTab: true });
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
addEventListener('resize', () => { if (innerWidth > 640 && menuOpen) setMenu(false); moveIndicator(); });
initMotion(); render(); refresh(); setInterval(() => refresh(), 10000);
