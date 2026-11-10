import { el, button, link, panel } from './dom.js';
import { t, label, getLocale } from './i18n.js';
import { tabs, settingTab, sleepScale } from './state.js';
import { editor } from './editors.js';
import { resolveModel } from './models.js';

export function technical(text) {
  const details = el('details', 'technical'); details.append(el('summary', '', t('technical')), el('p', '', text)); return details;
}
export function imageView(device, view = 'top') {
  const model = resolveModel(device), wrap = el('div', 'model-image');
  const fallback = () => { wrap.replaceChildren(el('span', 'image-name', model?.name || device?.name || t('modelImage')), el('span', 'muted', t('noImage'))); wrap.classList.add('image-missing'); };
  if (view !== 'thumbnail' && !model?.images?.[view] && model?.reference && /^\/assets\/models\/[a-z0-9-]+\/[a-z0-9.-]+\.svg$/.test(model.reference)) {
    const image = el('img', '', null, { src: model.reference, alt: `${model.name}: ${t('referenceSchematic')}`, width: '560', height: '395' });
    image.addEventListener('error', fallback, { once: true });
    wrap.classList.add('reference-image'); wrap.append(image, el('p', 'helper', t('referenceHelp'))); return wrap;
  }
  const src = model?.images?.[view];
  if (src && /^\/assets\/models\/[a-z0-9-]+\/[a-z0-9.-]+$/.test(src)) {
    const image = el('img', '', null, { src, alt: `${model.name} — ${t(view === 'side' ? 'side' : 'top')}`, width: '600', height: '420' });
    image.addEventListener('error', fallback, { once: true }); wrap.append(image);
  } else fallback();
  return wrap;
}
const readValue = value => value === undefined || value === null ? t('notRead') : typeof value === 'boolean' ? t(value ? 'on' : 'off') : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
const helperKeys = { dpi: 'dpiHelp', dpiStages: 'stagesHelp', sleep: 'sleepHelp', lowPower: 'lowPowerHelp', smartTracking: 'smartHelp', asymmetricTracking: 'asymmetricHelp' };
const setAtPath = (source, path, value) => {
  if (!path.length) return value;
  const next = structuredClone(source); let target = next;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)] = value; return next;
};

export function settingForm(entry, store, actions) {
  const id = entry.schema.id, key = id.replace(/^session\./, '');
  const form = el('form', `setting ${!entry.schema.writable ? 'readonly' : ''}`, null, { 'data-setting': id, novalidate: '' });
  form.append(el('h3', '', key === 'polling' ? t('pollingCurrent') : label(entry.schema)));
  if (helperKeys[key]) form.append(el('p', 'helper', t(helperKeys[key])));
  if (!entry.schema.writable && key !== 'customCurve') {
    if (typeof entry.baseline === 'object' && entry.baseline !== null) {
      const details = el('details'); details.append(el('summary', '', t('readOnly')), el('pre', '', readValue(entry.baseline))); form.append(details);
    } else form.append(el('p', 'read-value', `${readValue(entry.baseline)}${key === 'battery' && entry.baseline !== null ? '%' : ''}`), el('span', 'muted', t('readOnly')));
  } else {
    const control = editor(entry, (value, path = [], parseError = false) => { const current = store.entry(id)?.draft; store.edit(id, path.length ? setAtPath(current, path, value) : value, parseError); if (!store.entry(id)?.dirty) actions.cancelDraft?.(id); actions.sync(); });
    if (!['object', 'array'].includes(entry.schema.type)) control.querySelector(':scope > label')?.classList.add('sr-only');
    form.append(control);
  }
  if (entry.schema.description && !helperKeys[key]) form.append(technical(entry.schema.description));
  const foot = el('div', 'setting-foot'), statusId = `status-${encodeURIComponent(id)}`;
  foot.append(el('p', 'setting-status', '', { id: statusId, role: 'status', 'aria-live': 'polite' }));
  if (entry.schema.writable) {
    const apply = el('button', 'apply', t('reviewChange'), { type: 'submit', disabled: true }); foot.append(apply);
    form.addEventListener('submit', event => { event.preventDefault(); actions.stage(id); });
  }
  form.append(foot); return form;
}

export function syncForms(root, store) {
  root.querySelectorAll('form[data-setting]').forEach(form => {
    const entry = store.entry(form.dataset.setting); if (!entry) return;
    syncCleanControls(form, entry);
    const state = form.querySelector('.setting-status');
    if (!state) return;
    state.textContent = entry.errors.length ? entry.errors.map(t).join(' ') : entry.stale ? t('stale') : entry.uncertain ? t('uncertain') : entry.status === 'error' ? t('error') : entry.status === 'applying' ? t('applying') : entry.status === 'applied' ? t(entry.verification || 'applied') : entry.externalChange ? t('externalChange') : entry.dirty ? t('dirty') : '';
    state.classList.toggle('error', !!entry.errors.length || entry.status === 'error' || entry.uncertain);
    form.classList.toggle('is-dirty', entry.dirty);
    const blocked = store.lockEdits || !store.connected || !store.companion || entry.stale || entry.uncertain || !entry.schema.writable;
    form.querySelectorAll('input,select,textarea,button').forEach(control => {
      control.disabled = control.classList.contains('apply') ? !store.canApply(entry.schema.id) : blocked || control.dataset.locked === 'true';
      if (!control.matches('button')) {
        control.setAttribute('aria-invalid', String(!!entry.errors.length)); control.setAttribute('aria-describedby', state.id);
      }
    });
    const apply = form.querySelector('.apply'); if (apply) apply.textContent = t(entry.status === 'applying' ? 'applying' : 'reviewChange');
    form.querySelector('.write-details')?.remove();
    if (entry.technical) { const details = technical(entry.technical); details.classList.add('write-details'); form.append(details); }
  });
}

function syncCleanControls(form, entry) {
  if (entry.dirty) return;
  const active = document.activeElement, activePath = active?.closest('form[data-setting]') === form ? active.dataset.fieldPath : undefined;
  const activeStage = active?.closest('.stage-buttons') ? active.getAttribute('aria-label') : '';
  const selection = activePath !== undefined && typeof active.selectionStart === 'number' ? [active.selectionStart, active.selectionEnd] : null;
  form.querySelectorAll('.stages-editor,.curve-editor').forEach(editor => editor.syncDraft?.(entry.draft, activePath, activeStage));
  const scale = sleepScale(entry.schema.id);
  for (const control of form.querySelectorAll('[data-field-path]')) {
    let value = entry.draft;
    const path = control.dataset.fieldPath;
    if (path) for (const key of path.split('.')) value = value?.[key];
    const selection = control === document.activeElement && typeof control.selectionStart === 'number' ? [control.selectionStart, control.selectionEnd] : null;
    if (control.type === 'checkbox') control.checked = value === true;
    else if (control.type === 'range') control.value = value === null || value === undefined ? control.min : value / scale;
    else if (control.tagName === 'TEXTAREA') control.value = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    else control.value = value === null || value === undefined ? '' : typeof value === 'number' ? String(value / scale) : String(value);
    if (selection && control === document.activeElement) control.setSelectionRange(...selection);
  }
  if (activePath !== undefined || activeStage) {
    const target = activePath !== undefined
      ? [...form.querySelectorAll('[data-field-path]')].find(control => control.dataset.fieldPath === activePath)
      : [...form.querySelectorAll('.stage-buttons [aria-label]')].find(control => control.getAttribute('aria-label') === activeStage);
    if (target && document.activeElement !== target) target.focus({ preventScroll: true });
    if (target && selection && typeof target.setSelectionRange === 'function') target.setSelectionRange(...selection);
  }
}

function header(title, subtitle, actions) {
  const node = el('header', 'view-header'), text = el('div');
  text.append(el('h1', '', title)); if (subtitle) text.append(el('p', 'view-subtitle', subtitle));
  const refresh = button(t('refresh'), actions.refresh); refresh.dataset.action = 'refresh';
  node.append(text, refresh); return node;
}

export function dashboard(store, actions) {
  const view = el('div', 'dashboard'); view.append(header(t('devices'), t('inventoryHelp'), actions));
  if (!store.companion) {
    const empty = panel(t(store.busy ? 'connecting' : 'offlineTitle'), 'empty-state');
    empty.append(el('p', 'muted', t('offlineHelp')), link(t('connectionHelp'), '#settings'), link(t('browseCatalog'), '#catalog'));
    const retry = button(t('retry'), actions.refresh, 'primary'); retry.dataset.action = 'refresh'; empty.append(retry); view.append(empty); return view;
  }
  if (!store.devices.length) {
    const empty = panel(t('noDevices'), 'empty-state'); empty.append(el('p', 'muted', t('noDevicesHelp')), link(t('browseCatalog'), '#catalog')); view.append(empty); return view;
  }
  const grid = el('div', 'device-grid');
  for (const device of store.devices) {
    const card = el('article', 'device-card'); card.append(imageView(device, 'thumbnail'));
    const info = el('div', 'device-card-info'); info.append(el('h2', '', device.name), el('p', 'muted device-identity', `${t('physicalDeviceId')}: ${device.id.slice(-6)}`));
    const selected = device.id === store.selectedDeviceId;
    const battery = selected ? store.entry('battery')?.baseline : null;
    const text = selected && store.connected ? `${t('connected')} · ${store.entries().size} ${t('liveSettings')}` : device.supported ? t('adapterAvailable') : t('detectedOnly');
    info.append(el('p', 'muted card-status', `${text}${battery !== null && battery !== undefined ? ` · ${t('battery')} ${battery}%` : ''}`));
    const open = button(t('open'), () => actions.openDevice(device.id), 'primary'); open.dataset.action = 'device'; info.append(open);
    card.append(info); grid.append(card);
  }
  view.append(grid);
  const capabilities = panel(t('liveCapabilities'), 'capability-overview');
  const available = [...store.entries().values()], writable = available.filter(entry => entry.schema.writable).length;
  capabilities.append(el('p', 'muted', store.connected ? `${available.length} ${t('schemasReported')} · ${writable} ${t('writableSettings')}` : t('selectDeviceForCapabilities')));
  capabilities.append(link(t('browseCatalog'), '#catalog'), link(t('keyboardReference'), '#catalog/keyboard'));
  view.append(capabilities); return view;
}

function consoleNavigation(route) {
  const nav = el('nav', 'console-navigation', null, { 'aria-label': t('consoleSections') });
  for (const tab of tabs) {
    const a = link(t(tab), `#device/${tab}`, 'console-section-link'); a.id = `section-${tab}`;
    if (route === tab) a.setAttribute('aria-current', 'location');
    nav.append(a);
  }
  return nav;
}

export function devicePage(store, route, actions) {
  const view = el('div', 'device-page device-console'), device = store.devices.find(d => d.id === store.selectedDeviceId);
  const battery = store.entry('battery')?.baseline;
  const entries = [...store.entries().values()], key = entry => entry.schema.id.replace(/^session\./, '');
  const groups = name => entries.filter(entry => settingTab(entry.schema.id) === name);
  const settingPanel = (title, values, section = '') => {
    if (!values.length) return null;
    const node = panel(title, 'console-panel');
    if (section) { node.id = `console-section-${section}`; node.tabIndex = -1; node.setAttribute('role', 'region'); node.querySelector('h2').id = `console-heading-${section}`; node.setAttribute('aria-labelledby', `console-heading-${section}`); }
    values.forEach(entry => { const form = settingForm(entry, store, actions); if (values.length === 1 && entry.schema.type === 'object' && form.querySelector('h3')?.textContent === title) form.querySelector('h3').remove(); node.append(form); }); return node;
  };
  const grid = el('div', 'console-grid'), left = el('div', 'console-device'), middle = el('div', 'console-column'), right = el('div', 'console-column');
  left.append(header(device?.name || store.snapshot.model || t('disconnected'), `${device?.id ? `${t('physicalDeviceId')}: ${device.id.slice(-6)} · ` : ''}${t(store.connected ? 'connected' : 'unavailable')}${battery !== null && battery !== undefined ? ` · ${t('battery')} ${battery}%` : ''}`, actions));
  view.append(grid); grid.append(left, middle, right); left.append(consoleNavigation(route));
  const profiles = settingPanel(t('profile'), groups('profile')); if (profiles) left.append(profiles);
  const visual = el('div', 'console-visual'), holder = el('div', 'view-image-holder');
  holder.append(imageView(device || { name: store.snapshot.model })); visual.append(holder);
  const model = resolveModel(device), choices = ['top', 'side'].filter(name => model?.images?.[name]);
  if (choices.length > 1) { const views = el('div', 'actions'); choices.forEach(name => views.append(button(t(name), () => { holder.replaceChildren(imageView(device, name)); actions.imageChanged(holder); }))); visual.append(views); }
  left.append(visual);
  const assignments = settingPanel(t('assignments'), groups('customize'), 'customize') || panel(t('assignments'), 'console-panel');
  assignments.classList.add('assignment-panel'); assignments.id = 'console-section-customize'; assignments.tabIndex = -1;
  if (!groups('customize').length) assignments.append(el('p', 'muted', t('noAssignments')), el('p', 'helper', t('mappingHelp')), link(t('keyboardReference'), '#catalog/keyboard'));
  left.append(assignments);
  const about = settingPanel(t('deviceInfo'), groups('about')); if (about) { const details = el('details', 'console-about', null, { id: 'console-device-info' }); details.append(el('summary', '', t('deviceInfo'), { id: 'console-device-info-summary' }), about); left.append(details); }
  const footer = el('div', 'console-review-bar');
  footer.append(el('p', 'console-draft-count', '', { 'data-console-count': '', role: 'status', 'aria-live': 'polite' }));
  const review = button(t('reviewChanges'), actions.stageAll, 'primary console-review'); review.dataset.action = 'review-drafts'; footer.append(review, link(t('reviewHistory'), '#review', 'text-link'));
  left.append(footer);
  const performance = groups('performance');
  const sensitivity = settingPanel(t('sensitivity'), performance.filter(entry => ['dpi', 'dpiStages'].includes(key(entry))), 'performance'); if (sensitivity) middle.append(sensitivity);
  const rates = settingPanel(t('polling'), performance.filter(entry => !['dpi', 'dpiStages'].includes(key(entry)))); if (rates) { if (!sensitivity) { rates.id = 'console-section-performance'; rates.tabIndex = -1; } middle.append(rates); }
  const calibration = settingPanel(t('calibration'), groups('calibration'), 'calibration'); if (calibration) middle.append(calibration);
  const power = settingPanel(t('power'), groups('power'), 'power'); if (power) right.append(power);
  const advanced = groups('advanced'), rotation = advanced.filter(entry => key(entry) === 'rotation'), dynamic = advanced.filter(entry => ['dynamic', 'dynamicState', 'dynamicMode'].includes(key(entry)));
  const sensor = settingPanel(t('rotation'), rotation, 'advanced'); if (sensor) right.append(sensor);
  const modes = settingPanel(t('dynamicState'), dynamic); if (modes) { if (!sensor) { modes.id = 'console-section-advanced'; modes.tabIndex = -1; } right.append(modes); }
  const curves = advanced.filter(entry => key(entry) === 'customCurve');
  if (curves.length) { const details = el('details', 'console-curve', null, { id: 'console-curve' }); details.append(el('summary', '', t('customCurve'), { id: 'console-curve-summary' }), settingPanel(t('customCurve'), curves)); right.append(details); }
  const additional = settingPanel(t('additional'), advanced.filter(entry => !rotation.includes(entry) && !dynamic.includes(entry) && !curves.includes(entry)));
  if (additional) { if (!sensor && !modes) { additional.id = 'console-section-advanced'; additional.tabIndex = -1; } right.append(additional); }
  for (const section of tabs) {
    if (view.querySelector(`#console-section-${section}`)) continue;
    const target = section === 'advanced' && curves.length ? view.querySelector('#console-curve > summary') : panel(t(section), 'console-panel console-empty');
    target.id = `console-section-${section}`; target.tabIndex = -1;
    if (!view.contains(target)) { target.append(el('p', 'muted', t('noControlsHelp'))); (section === 'power' || section === 'advanced' ? right : middle).append(target); }
  }
  if (!entries.length) grid.classList.add('console-unavailable');
  const macro = panel(t('macros'), 'console-macro'); macro.append(el('p', 'helper', t('macroLibraryHelp')), link(t('openMacroLibrary'), '#macros', 'text-link')); right.append(macro);
  const unavailable = store.snapshot.unavailable || [];
  if (unavailable.length) { const details = el('details', 'unavailable-controls'); details.append(el('summary', '', t('unavailableControls')), el('p', 'muted', t('backendHelp'))); for (const text of unavailable) details.append(technical(text)); view.append(details); }
  if (store.snapshot.message) view.append(el('p', 'device-notice', store.snapshot.message));
  else if (store.connected) view.append(el('p', 'device-notice', t('closeSynapse')));
  return view;
}

export function settingsPage(store, actions) {
  const view = el('div', 'settings-page'); view.append(header(t('settings'), '', actions));
  const language = panel(t('language')), languageSelect = el('select', '', null, { id: 'language-select' });
  languageSelect.append(el('option', '', 'English', { value: 'en' }), el('option', '', 'Tiếng Việt', { value: 'vi' })); languageSelect.value = getLocale();
  languageSelect.addEventListener('change', () => actions.locale(languageSelect.value));
  language.append(el('label', 'sr-only', t('language'), { for: 'language-select' }), el('p', 'muted', t('languageHelp')), languageSelect);
  const connection = panel(t('connection')); connection.id = 'connection-help';
  connection.append(el('p', '', t('startHelp')), el('code', 'startup-command', `npm run bridge -- --origin ${location.origin}`, { id: 'startup-command' }));
  const commandActions = el('div', 'actions');
  commandActions.append(button(t('copy'), actions.copy), button(t('retry'), actions.refresh)); connection.append(commandActions, el('p', 'muted', t('networkHelp')), el('p', 'muted', t('autoCheck')));
  const about = panel(t('about')); about.append(el('p', 'muted', t('aboutHelp')), el('p', '', t('explicitApply')));
  const device = store.devices.find(d => d.id === store.selectedDeviceId);
  if (device) {
    const info = el('details', 'device-info'); info.append(el('summary', '', t('deviceInfo')));
    const list = el('dl');
    for (const [name, value] of [[t('modelImage'), device.name], [t('identity'), store.selectedDeviceId], [t('firmware'), store.entry('firmware')?.baseline]]) list.append(el('dt', '', name), el('dd', '', readValue(value)));
    info.append(list); about.append(info);
  }
  const grid = el('div', 'settings-grid'); grid.append(language, connection, about); view.append(grid); return view;
}
