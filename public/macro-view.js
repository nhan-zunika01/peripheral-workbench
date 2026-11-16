import { el, button } from './dom.js';
import { t } from './i18n.js';
import { macroLimits } from './macros.js';

const select = (label, options, value, id) => {
  const control = el('select', '', null, { id, 'aria-label': label });
  options.forEach(([name, option]) => control.append(el('option', '', name, { value: option })));
  control.value = value; return control;
};
const mouseNames = { left: 'LeftClick', right: 'RightClick', middle: 'ScrollButton', button4: 'Button4', button5: 'Button5', wheelup: 'ScrollUp', wheeldown: 'ScrollDown', wheelleft: 'ScrollLeft', wheelright: 'ScrollRight' };
const eventName = event => event.kind === 'key' ? t(event.action === 'down' ? 'keyDown' : 'keyUp') : event.kind === 'mouse' ? `${t(mouseNames[event.input] || 'mouseEvent')} ${t(event.action === 'down' ? 'press' : 'release')}` : t('delayEvent');
const eventValue = event => event.kind === 'key' ? event.input || t('eventInput') : event.kind === 'mouse' ? t(mouseNames[event.input] || 'mouseEvent') : `${event.delayMs} ms`;
const eventDelay = event => event.kind === 'delay' ? '' : `${event.delayMs} ms ${t('delayBeforeShort')}`;
let libraryOpen, libraryMode;

export function macroStatusText(library, message = '') {
  const notice = message || (!library.valid ? 'macroInvalid' : '');
  const keys = [notice, notice === 'macroInvalid' && library.status === 'macroSaved' ? '' : library.status];
  if (library.access === 'memory') keys.push('macroLockUnavailable');
  if (library.access === 'readonly') keys.push('macroReadOnly');
  return [...new Set(keys.filter(Boolean))].map(key => t(key)).join(' ');
}

export function macrosPage(library, selectedId, selectedIndex, search, actions) {
  const view = el('div', 'macros-page');
  const header = el('header', 'view-header macro-heading'), heading = el('div');
  heading.append(el('h1', '', t('macros')), el('p', 'view-subtitle', t('macroLibraryHelp')));
  const picker = el('input', 'sr-only', null, { id: 'macro-import', type: 'file', accept: '.json,application/json', 'aria-label': t('importMacros') });
  const importButton = button(t('importMacros'), () => picker.click()); importButton.dataset.macroAction = 'import';
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0]; if (!file) return;
    if (file.size > macroLimits.importBytes) { actions.setMacroMessage('importSize'); return; }
    try { actions.importMacros(await file.text()); picker.value = ''; }
    catch (error) { actions.setMacroMessage(['importSize', 'jsonError', 'macroFormat', 'macroLimit', 'macroReadOnly'].includes(error.message) ? error.message : 'macroFormat'); }
  });
  const exportButton = button(t('exportMacros'), () => {
    try {
      const blob = new Blob([library.export()], { type: 'application/json' }), url = URL.createObjectURL(blob), anchor = el('a', 'sr-only', t('exportMacros'), { href: url, download: 'device-control-macros.json' });
      document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); actions.setMacroMessage('macroExported');
    } catch (error) { actions.setMacroMessage(error?.message === 'macroFormat' ? 'macroFormat' : 'macroExportFailed'); }
  });
  exportButton.dataset.action = 'export-macros'; exportButton.dataset.macroAction = 'export'; exportButton.disabled = !library.valid;
  const fileActions = el('div', 'actions macro-file-actions'); fileActions.append(picker, importButton, exportButton);
  if (!library.writable && actions.canAcquireMacroWriter) {
    const retry = button(t('macroTryWriter'), actions.acquireMacroWriter); retry.id = 'macro-try-writer'; fileActions.append(retry);
  }
  header.append(heading, fileActions); view.append(header);

  const layout = el('div', 'macro-layout');
  const libraryPanel = el('section', 'panel macro-library', null, { 'aria-labelledby': 'macro-library-title' });
  const libraryHead = el('div', 'macro-panel-heading'); libraryHead.append(el('h2', '', t('library'), { id: 'macro-library-title' }));
  const create = button(t('newMacro'), actions.createMacro); create.id = 'macro-create'; create.dataset.macroAction = 'create'; libraryHead.append(create);
  const searchBox = el('div', 'field macro-search-field'), searchInput = el('input', '', null, { id: 'macro-search', type: 'search', placeholder: t('searchMacros'), 'aria-label': t('searchMacros') }); searchInput.value = search;
  searchBox.append(searchInput); libraryPanel.append(libraryHead, searchBox);
  const list = el('div', 'macro-list', null, { role: 'list', 'aria-label': t('library') });
  for (const macro of library.macros) {
    const item = el('div', 'macro-choice-item', null, { role: 'listitem', 'data-macro-name': macro.name.toLocaleLowerCase() });
    const choice = button(macro.name, () => actions.selectMacro(macro.id), macro.id === selectedId ? 'macro-choice selected' : 'macro-choice');
    choice.setAttribute('aria-current', String(macro.id === selectedId)); choice.dataset.macroId = macro.id; choice.id = `macro-choice-${macro.id}`;
    item.append(choice, el('span', 'macro-choice-meta', t('eventCount').replace('{count}', macro.events.length)));
    // textContent keeps imported names inert, including markup-like names.
    list.append(item);
  }
  const noMatches = el('p', 'muted macro-no-results', t(library.macros.length ? 'noMacroMatches' : 'noMacrosYet'));
  list.hidden = !library.macros.length; noMatches.hidden = !!library.macros.length;
  const pickerDetails = el('details', 'macro-library-picker'), selected = library.macros.find(item => item.id === selectedId);
  const compact = matchMedia('(max-width: 800px)').matches;
  if (libraryMode !== undefined && compact !== libraryMode) libraryOpen = undefined;
  libraryMode = compact;
  pickerDetails.hidden = !library.macros.length; pickerDetails.open = libraryOpen ?? !compact;
  pickerDetails.addEventListener('toggle', () => { libraryOpen = pickerDetails.open; });
  const pickerSummary = el('summary', '', selected?.name || t('chooseMacro'));
  pickerSummary.addEventListener('click', () => { libraryOpen = !pickerDetails.open; });
  pickerDetails.append(pickerSummary, list);
  libraryPanel.append(pickerDetails, noMatches); layout.append(libraryPanel);
  const filterMacros = value => {
    const query = value.trim().toLocaleLowerCase(); let matches = 0;
    list.querySelectorAll('.macro-choice-item').forEach(item => { item.hidden = !item.dataset.macroName.includes(query); if (!item.hidden) matches++; });
    noMatches.hidden = matches > 0; noMatches.textContent = t(library.macros.length ? 'noMacroMatches' : 'noMacrosYet');
  };
  filterMacros(search);
  searchInput.addEventListener('input', () => { actions.setMacroSearch(searchInput.value); filterMacros(searchInput.value); });

  const macro = library.macros.find(item => item.id === selectedId);
  const sequence = el('section', 'panel macro-sequence', null, { 'aria-labelledby': 'macro-sequence-title' });
  const details = el('section', 'panel macro-inspector', null, { 'aria-labelledby': 'macro-inspector-title' });
  sequence.append(el('h2', '', t('sequence'), { id: 'macro-sequence-title' }));
  details.append(el('h2', '', t('eventDetails'), { id: 'macro-inspector-title' }));
  const status = el('p', 'setting-status macro-status', macroStatusText(library, actions.macroMessage), { id: 'macro-status', role: 'status', 'aria-live': 'polite' });

  if (!macro) {
    const empty = el('div', 'macro-sequence-empty'); empty.append(el('h3', '', t('createMacroTitle')), el('p', 'muted', t('macroEmpty')), el('p', 'macro-runtime-note', t('macroRuntimeUnavailable')));
    const newMacro = button(t('newMacro'), actions.createMacro, 'primary'); newMacro.id = 'macro-create-empty'; newMacro.dataset.macroAction = 'create-empty'; empty.append(newMacro);
    sequence.append(empty); details.append(el('p', 'muted', t('selectEventToEdit')), status);
    layout.append(sequence, details); view.append(layout); return finish(view, library);
  }

  const summary = el('div', 'macro-sequence-head');
  const name = el('input', 'macro-name', null, { id: 'macro-name', type: 'text', maxlength: '64', 'aria-label': t('macroName'), 'aria-describedby': 'macro-status' }); name.value = macro.name;
  const updateName = () => {
    const saved = actions.updateMacro(macro.id, { name: name.value }, false); name.setAttribute('aria-invalid', String(!saved)); actions.sync();
    if (saved) {
      const choice = document.getElementById(`macro-choice-${macro.id}`);
      if (choice) { choice.textContent = name.value; choice.closest('.macro-choice-item').dataset.macroName = name.value.toLocaleLowerCase(); }
      pickerSummary.textContent = name.value; filterMacros(searchInput.value);
    }
  };
  name.addEventListener('input', updateName);
  name.addEventListener('change', () => { name.value = name.value.trim(); updateName(); });
  const toolbar = el('div', 'macro-actions');
  const duplicate = button(t('duplicateMacro'), () => actions.duplicateMacro(macro.id)); duplicate.dataset.macroAction = 'duplicate';
  const remove = button(t('deleteMacro'), () => actions.deleteMacro(macro.id)); remove.dataset.macroAction = 'delete';
  toolbar.append(duplicate, remove); summary.append(name, toolbar); sequence.append(summary);

  const runtime = el('div', 'macro-runtime', null, { id: 'macro-runtime-status', role: 'note' });
  runtime.append(el('strong', '', t('macroRuntimeUnavailable')));
  const runtimeActions = el('span', 'macro-runtime-actions');
  for (const [key, label] of [['record', 'record'], ['play', 'play']]) { const control = button(t(label), () => {}); control.disabled = true; control.dataset.runtime = key; control.setAttribute('aria-describedby', 'macro-runtime-status'); runtimeActions.append(control); }
  runtime.append(runtimeActions); sequence.append(runtime);

  const sequenceHeading = el('div', 'macro-sequence-subhead');
  const total = macro.events.reduce((sum, event) => sum + event.delayMs, 0);
  sequenceHeading.append(el('h3', '', t('sequence')), el('span', 'macro-total', `${t('totalDuration')}: ${total} ms`));
  const insert = el('details', 'macro-insert-menu'), insertLabel = el('summary', 'secondary', t('insertEvent'), { id: 'macro-insert-trigger' });
  const insertItems = el('div', 'macro-insert-items', null, { role: 'group', 'aria-label': t('insertEvent') });
  for (const [kind, key] of [['key', 'keyEvent'], ['mouse', 'mouseEvent'], ['delay', 'delayEvent']]) {
    const add = button(t(key), () => actions.addMacroEvent(macro.id, kind)); add.dataset.macroAction = `add-${kind}`; insertItems.append(add);
  }
  insert.append(insertLabel, insertItems); sequenceHeading.append(insert); sequence.append(sequenceHeading);

  const events = el('ol', 'macro-events', null, { 'aria-label': t('sequence') });
  macro.events.forEach((event, index) => {
    const card = button('', () => actions.selectMacroEvent(index), `macro-event${index === selectedIndex ? ' selected' : ''}`);
    card.type = 'button'; card.dataset.eventIndex = String(index); card.id = `macro-event-${index}`; card.setAttribute('aria-pressed', String(index === selectedIndex));
    card.setAttribute('aria-label', `${index + 1}. ${eventName(event)}, ${eventValue(event)}${eventDelay(event) ? `, ${eventDelay(event)}` : ''}`);
    card.append(el('span', 'macro-event-number', String(index + 1)), el('span', 'macro-event-title', eventName(event)), el('span', 'macro-event-value', eventValue(event)));
    if (eventDelay(event)) card.append(el('span', 'macro-event-delay', eventDelay(event)));
    card.addEventListener('keydown', eventKey => {
      if (!['ArrowUp', 'ArrowDown'].includes(eventKey.key)) return;
      eventKey.preventDefault();
      if (eventKey.altKey) actions.moveMacroEvent(macro.id, index, eventKey.key === 'ArrowUp' ? -1 : 1);
      else actions.selectMacroEvent(Math.max(0, Math.min(macro.events.length - 1, index + (eventKey.key === 'ArrowUp' ? -1 : 1))));
    });
    const li = el('li', 'macro-event-item'); li.append(card); events.append(li);
  });
  sequence.append(events);
  const reorder = el('div', 'macro-reorder'); reorder.append(el('span', 'muted', t('moveSelectedEvent')));
  const moveUp = button(t('moveUp'), () => actions.moveMacroEvent(macro.id, selectedIndex, -1)); moveUp.dataset.macroAction = 'move-up'; moveUp.disabled = selectedIndex <= 0;
  const moveDown = button(t('moveDown'), () => actions.moveMacroEvent(macro.id, selectedIndex, 1)); moveDown.dataset.macroAction = 'move-down'; moveDown.disabled = selectedIndex < 0 || selectedIndex >= macro.events.length - 1;
  const removeEvent = button(t('removeEvent'), () => actions.removeMacroEvent(macro.id, selectedIndex), 'secondary'); removeEvent.dataset.macroAction = 'remove-event'; removeEvent.disabled = selectedIndex < 0;
  reorder.append(moveUp, moveDown, removeEvent); sequence.append(reorder);

  const event = macro.events[selectedIndex];
  if (!event) details.append(el('p', 'muted', t('selectEventToEdit')));
  else {
    const controls = el('div', 'macro-inspector-fields');
    const type = select(t('eventType'), [[t('keyEvent'), 'key'], [t('mouseEvent'), 'mouse'], [t('delayEvent'), 'delay']], event.kind, 'macro-event-kind');
    type.dataset.eventField = 'kind'; type.addEventListener('change', () => actions.changeMacroEvent(macro.id, selectedIndex, { kind: type.value }, type.id));
    controls.append(field('eventType', type));
    if (event.kind === 'key') {
      const input = el('input', '', null, { id: 'macro-event-input', type: 'text', maxlength: '32', 'aria-label': t('eventInput'), 'aria-describedby': 'macro-status', 'data-event-field': 'input' }); input.value = event.input;
      input.addEventListener('input', () => {
        actions.editMacroEvent(macro.id, selectedIndex, { input: input.value }, input);
        const card = document.getElementById(`macro-event-${selectedIndex}`);
        if (card) {
          const current = library.macros.find(item => item.id === macro.id)?.events[selectedIndex] || event;
          card.querySelector('.macro-event-value').textContent = input.value || t('eventInput');
          card.setAttribute('aria-label', `${selectedIndex + 1}. ${eventName(current)}, ${input.value || t('eventInput')}, ${eventDelay(current)}`);
        }
      }); controls.append(field('eventInput', input));
      const action = select(t('eventAction'), [[t('keyDown'), 'down'], [t('keyUp'), 'up']], event.action, 'macro-event-action'); action.dataset.eventField = 'action'; action.addEventListener('change', () => actions.changeMacroEvent(macro.id, selectedIndex, { action: action.value }, action.id)); controls.append(field('eventAction', action));
    } else if (event.kind === 'mouse') {
      const input = select(t('eventInput'), Object.entries(mouseNames).map(([value, key]) => [t(key), value]), event.input, 'macro-event-input'); input.dataset.eventField = 'input'; input.addEventListener('change', () => actions.changeMacroEvent(macro.id, selectedIndex, { input: input.value }, input.id)); controls.append(field('eventInput', input));
      const action = select(t('eventAction'), [[t('keyDown'), 'down'], [t('keyUp'), 'up']], event.action, 'macro-event-action'); action.dataset.eventField = 'action'; action.addEventListener('change', () => actions.changeMacroEvent(macro.id, selectedIndex, { action: action.value }, action.id)); controls.append(field('eventAction', action));
    }
    const delay = el('input', '', null, { id: 'macro-event-delay', type: 'number', min: '0', max: '60000', step: '1', 'aria-label': t(event.kind === 'delay' ? 'durationMs' : 'delayBefore'), 'aria-describedby': 'macro-status', 'data-event-field': 'delay' }); delay.value = event.delayMs;
    delay.addEventListener('input', () => {
      const delayMs = delay.value === '' ? -1 : Number(delay.value);
      if (!actions.editMacroEvent(macro.id, selectedIndex, { delayMs }, delay, true)) return;
      const current = { ...event, delayMs }, card = document.getElementById(`macro-event-${selectedIndex}`);
      if (current.kind === 'key') current.input = document.getElementById('macro-event-input').value;
      if (card) {
        card.querySelector(current.kind === 'delay' ? '.macro-event-value' : '.macro-event-delay').textContent = current.kind === 'delay' ? eventValue(current) : eventDelay(current);
        card.setAttribute('aria-label', `${selectedIndex + 1}. ${eventName(current)}, ${eventValue(current)}${eventDelay(current) ? `, ${eventDelay(current)}` : ''}`);
      }
      sequence.querySelector('.macro-total').textContent = `${t('totalDuration')}: ${total - event.delayMs + delayMs} ms`;
    });
    controls.append(field(event.kind === 'delay' ? 'durationMs' : 'delayBefore', delay));
    details.append(controls);
  }

  const save = button(t('saveMacros'), actions.saveMacros, 'primary'); save.id = 'save-macros'; save.dataset.macroAction = 'save'; save.dataset.action = 'save-macros'; save.disabled = !library.valid || !library.writable;
  details.append(status, save); layout.append(sequence, details); view.append(layout); return finish(view, library);
}

function finish(view, library) {
  if (!library.editable) view.querySelectorAll('[data-macro-action]:not([data-macro-action=export]), .macro-name, [data-event-field], #macro-import').forEach(control => { control.disabled = true; });
  return view;
}

function field(labelKey, control) {
  const wrapper = el('div', 'field'); wrapper.append(el('label', '', t(labelKey), { for: control.id }), control); return wrapper;
}
