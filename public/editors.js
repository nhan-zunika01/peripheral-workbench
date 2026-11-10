import { el, button } from './dom.js';
import { t, label } from './i18n.js';
import { equal, sleepScale } from './state.js';
let nextId = 0;
const initial = schema => schema.type === 'object' ? Object.fromEntries(Object.entries(schema.properties || {}).map(([k, s]) => [k, initial(s)])) : schema.type === 'array' ? Array.from({ length: schema.minItems || 0 }, () => initial(schema.items)) : schema.options ? (schema.options[0]?.value ?? schema.options[0]) : schema.type === 'number' ? schema.min ?? 0 : schema.type === 'boolean' ? false : '';
const setAtPath = (source, path, value) => {
  if (!path.length) return value;
  const next = structuredClone(source); let target = next;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)] = value; return next;
};

export function field(schema, value, changed, name = '', { scale = 1, slider = false, unit = '', axisSliders = true, path = [] } = {}) {
  const wrap = el('div', 'field');
  const title = schema.key ? t(schema.key) : schema.id ? label(schema) : t(name || schema.label || 'value');
  if (schema.type === 'object') {
    wrap.classList.add('object-fields');
    for (const [key, child] of Object.entries(schema.properties || {})) {
      wrap.append(field({ ...child, key }, value?.[key], changed, key, { slider: (['angle', 'value'].includes(key) || axisSliders && ['x', 'y'].includes(key)) && child.type === 'number', path: [...path, key] }));
    }
    return wrap;
  }
  if (schema.type === 'array') {
    const list = el('div', 'array-fields'); wrap.append(list);
    const draw = () => {
      list.replaceChildren();
      (Array.isArray(value) ? value : []).forEach((item, i) => {
        const itemWrap = el('fieldset', 'array-item'); itemWrap.append(el('legend', '', `${t('stage')} ${i + 1}`));
        itemWrap.append(field(schema.items, item, (next, childPath = []) => { value = [...value]; value[i] = setAtPath(value[i], childPath, next); changed(value, path); }, String(i + 1), { path: [] })); list.append(itemWrap);
      });
    };
    draw();
    const add = button(t('addStage'), () => { value = [...(value || []), structuredClone(value?.at(-1) ?? initial(schema.items))]; changed(value, path); draw(); limits(); });
    const remove = button(t('remove'), () => { value = value.slice(0, -1); changed(value, path); draw(); limits(); });
    function limits() { add.dataset.locked = String((value?.length || 0) >= (schema.maxItems ?? 20)); remove.dataset.locked = String((value?.length || 0) <= (schema.minItems ?? 0)); add.disabled = add.dataset.locked === 'true'; remove.disabled = remove.dataset.locked === 'true'; }
    limits(); const actions = el('div', 'actions'); actions.append(add, remove); wrap.append(actions); return wrap;
  }
  const id = `field-${++nextId}`, inputLabel = el('label', '', title, { for: id });
  const input = el(schema.type === 'json' ? 'textarea' : schema.options ? 'select' : 'input', '', null, { id, 'data-field-path': path.join('.') });
  if (schema.type === 'json') {
    input.rows = 10; input.spellcheck = false;
    input.value = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    input.addEventListener('input', () => { try { changed(JSON.parse(input.value), path); } catch { changed(input.value, path, true); } });
  } else if (schema.options) {
    const placeholder = el('option', '', t('choose'), { value: '' }); input.append(placeholder);
    for (const option of schema.options) {
      const v = option.value ?? option, optionLabel = option.label ?? v;
      input.append(el('option', '', `${typeof optionLabel === 'string' ? t(optionLabel) : optionLabel}${unit ? ` ${unit}` : ''}`, { value: String(v) }));
    }
    input.value = value === null || value === undefined ? '' : String(value);
    input.addEventListener('change', () => changed(input.value === '' ? null : schema.type === 'number' ? Number(input.value) : schema.type === 'boolean' ? input.value === 'true' : input.value, path));
  } else {
    input.type = schema.type === 'boolean' ? 'checkbox' : schema.type === 'number' ? 'number' : 'text';
    if (input.type === 'checkbox') { input.checked = value === true; input.setAttribute('role', 'switch'); }
    else input.value = value === null || value === undefined ? '' : typeof value === 'number' ? String(value / scale) : String(value);
    input.placeholder = t('notRead');
    if (schema.type === 'number') {
      if (schema.min !== undefined) input.min = schema.min / scale;
      if (schema.max !== undefined) input.max = schema.max / scale;
      input.step = schema.step ? schema.step / scale : schema.integer ? 1 / scale : 'any'; input.inputMode = 'decimal';
    }
    input.addEventListener(input.type === 'checkbox' ? 'change' : 'input', () => {
      const v = input.type === 'checkbox' ? input.checked : input.type === 'number' ? input.value === '' ? null : Number(input.value) * scale : input.value;
      if (range && Number.isFinite(v)) { range.step = schema.step ? schema.step / scale : schema.integer ? 1 / scale : 'any'; range.value = v / scale; }
      changed(v, path);
    });
  }
  const line = el('div', 'input-line'); line.append(input); if (unit && !schema.options) line.append(el('span', 'unit', unit));
  wrap.append(inputLabel, line);
  let range;
  if (slider && schema.type === 'number' && !schema.options && schema.min !== undefined && schema.max !== undefined) {
    range = el('input', 'range', null, { type: 'range', min: schema.min / scale, max: schema.max / scale, step: schema.step ? schema.step / scale : schema.integer ? 1 / scale : 'any', 'aria-label': `${title}${unit ? ` (${unit})` : ''}` });
    range.dataset.fieldPath = path.join('.');
    range.value = value === null || value === undefined ? schema.min / scale : value / scale;
    // A native getter may return 29% while writes use 5% steps. Display that readback exactly.
    if (schema.step && Number.isFinite(value) && Math.abs((value - schema.min) / schema.step - Math.round((value - schema.min) / schema.step)) > 1e-7) { range.step = 'any'; range.value = value / scale; }
    range.addEventListener('input', () => {
      let next = Number(range.value) * scale;
      if (schema.step) { next = Math.max(schema.min, Math.min(schema.max, schema.min + Math.round((next - schema.min) / schema.step) * schema.step)); range.step = schema.step / scale; range.value = next / scale; }
      input.value = next / scale; changed(next, path);
    });
    wrap.append(range);
  }
  if (schema.type === 'boolean') { wrap.classList.add('switch-field'); wrap.replaceChildren(line, inputLabel); }
  return wrap;
}

export function stagesEditor(entry, changed) {
  const wrap = el('div', 'stages-editor'), schema = entry.schema;
  let value = structuredClone(entry.draft);
  const stageSchema = schema.properties.stages;
  const row = el('div', 'stage-buttons', null, { role: 'group', 'aria-label': t('activeStage') }), fields = el('div', 'stage-fields');
  const count = el('p', 'muted');
  const draw = () => {
    row.replaceChildren(); fields.replaceChildren();
    (value.stages || []).forEach((stage, i) => {
      const tab = button('', () => { value.active = i + 1; changed(value); draw(); }, value.active === i + 1 ? 'stage selected' : 'stage');
      tab.append(el('span', 'stage-number', `${t('stage')} ${i + 1}`));
      if (Number.isFinite(stage?.x) && Number.isFinite(stage?.y)) tab.append(el('span', 'stage-value', stage.x === stage.y ? String(stage.x) : `${stage.x} / ${stage.y}`));
      tab.setAttribute('aria-pressed', String(value.active === i + 1)); tab.setAttribute('aria-label', `${t('stage')} ${i + 1}`); row.append(tab);
    });
    const index = Math.max(0, Math.min(value.stages.length - 1, value.active - 1));
    if (value.stages[index]) fields.append(field(stageSchema.items, value.stages[index], (next, path = []) => { value.stages[index] = setAtPath(value.stages[index], path.slice(2), next); changed(next, path); }, '', { axisSliders: false, path: ['stages', index] }));
    count.textContent = `${t('activeStage')}: ${value.active} / ${value.stages.length}`;
    add.dataset.locked = String(value.stages.length >= (stageSchema.maxItems ?? 5)); remove.dataset.locked = String(value.stages.length <= (stageSchema.minItems ?? 1));
    add.disabled = add.dataset.locked === 'true'; remove.disabled = remove.dataset.locked === 'true';
  };
  const add = button(t('addStage'), () => { if (value.stages.length >= (stageSchema.maxItems ?? 5)) return; value.stages.push(structuredClone(value.stages.at(-1) ?? initial(stageSchema.items))); changed(value); draw(); });
  const remove = button(t('remove'), () => { if (value.stages.length <= (stageSchema.minItems ?? 1)) return; value.stages.pop(); value.active = Math.min(value.active, value.stages.length); changed(value); draw(); });
  // Session-only fields are rendered from its schema, without changing native contracts.
  for (const [key, child] of Object.entries(schema.properties)) if (!['active', 'stages'].includes(key)) wrap.append(field({ ...child, key }, value[key], (next, path = []) => { value[key] = setAtPath(value[key], path.slice(1), next); changed(next, path); }, '', { path: [key] }));
  const actions = el('div', 'actions'); actions.append(add, remove);
  wrap.append(row, fields, count, actions);
  wrap.syncDraft = (next, activePath, activeStage) => {
    if (equal(value, next)) return;
    value = structuredClone(next);
    draw();
    const target = activePath !== undefined
      ? [...wrap.querySelectorAll('[data-field-path]')].find(control => control.dataset.fieldPath === activePath)
      : activeStage ? [...row.querySelectorAll('[aria-label]')].find(control => control.getAttribute('aria-label') === activeStage) : null;
    target?.focus({ preventScroll: true });
  };
  draw(); return wrap;
}

export function curveEditor(entry, changed) {
  const wrap = el('div', 'curve-editor');
  let values = Array.isArray(entry.draft) ? [...entry.draft] : [];
  const canvas = el('canvas', 'curve', null, { width: '800', height: '240', role: 'img', 'aria-label': `${t('customCurve')}: ${t('sampleIndex')} / ${t('curveValue')}` });
  const description = el('p', 'muted', t('curveHelp')); wrap.append(description, canvas);
  const caption = el('div', 'chart-caption'); caption.append(el('span', '', t('curveValue')), el('span', '', t('sampleIndex'))); wrap.append(caption);
  function plot() {
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, 800, 240);
    const finite = values.filter(Number.isFinite); if (!finite.length) return;
    const max = Math.max(...finite) * 1.1 || 1;
    const css = getComputedStyle(document.documentElement); ctx.font = '12px Segoe UI'; ctx.fillStyle = css.getPropertyValue('--muted');
    for (let i = 0; i < 4; i++) { const y = 210 - i * 60; ctx.fillText((max * i / 3).toPrecision(3), 4, y + 4); ctx.strokeStyle = css.getPropertyValue('--border'); ctx.beginPath(); ctx.moveTo(65, y); ctx.lineTo(780, y); ctx.stroke(); }
    for (const index of [0, 50, 100, 150, 200, 249]) ctx.fillText(String(index), 65 + index / 249 * 700, 234);
    ctx.strokeStyle = css.getPropertyValue('--accent'); ctx.lineWidth = 2; ctx.beginPath();
    values.forEach((v, i) => { if (!Number.isFinite(v)) return; const x = 65 + i / Math.max(1, values.length - 1) * 715, y = 210 - v / max * 180; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }); ctx.stroke();
    canvas.setAttribute('aria-description', `${values.length} ${t('curveValue')}; 0–${max.toPrecision(3)}`);
  }
  const details = el('details', 'sample-disclosure', null, { id: `curve-samples-${encodeURIComponent(entry.schema.id)}` }); details.append(el('summary', '', `${t('editSamples')} (${values.length})`, { id: `${details.id}-summary` }));
  const scroll = el('div', 'sample-scroll'), table = el('table');
  const head = el('thead'), headRow = el('tr'); headRow.append(el('th', '', t('sampleIndex'), { scope: 'col' }), el('th', '', t('curveValue'), { scope: 'col' })); head.append(headRow); table.append(head);
  const body = el('tbody'); values.forEach((value, index) => {
    const row = el('tr'), cell = el('td'); row.append(el('th', '', String(index), { scope: 'row' }));
    if (entry.schema.writable) {
      const input = el('input', '', null, { type: 'number', step: 'any', 'aria-label': `${t('curveValue')} ${index}`, 'data-field-path': String(index) }); input.value = value;
      input.addEventListener('input', () => { values[index] = input.value === '' ? null : Number(input.value); changed([...values]); plot(); }); cell.append(input);
    } else cell.textContent = String(value);
    row.append(cell); body.append(row);
  }); table.append(body); scroll.append(table); details.append(scroll); wrap.append(details);
  wrap.syncDraft = next => { if (!equal(values, next)) { values = Array.isArray(next) ? [...next] : []; plot(); } };
  requestAnimationFrame(plot); return wrap;
}

export function editor(entry, changed) {
  const key = entry.schema.id.replace(/^session\./, '');
  if (key === 'dpiStages' && entry.schema.properties?.stages && entry.draft?.stages) return stagesEditor(entry, changed);
  if (key === 'customCurve' && Array.isArray(entry.draft)) return curveEditor(entry, changed);
  const schema = key === 'smartTracking' && !entry.schema.options && Number.isInteger(entry.schema.min) && Number.isInteger(entry.schema.max) && entry.schema.max - entry.schema.min <= 20
    ? { ...entry.schema, options: Array.from({ length: entry.schema.max - entry.schema.min + 1 }, (_, i) => i + entry.schema.min) } : entry.schema;
  return field(schema, entry.draft, changed, '', { scale: sleepScale(entry.schema.id), slider: ['sleep', 'lowPower'].includes(key), unit: key.startsWith('polling') ? 'Hz' : key === 'sleep' ? t('minutes') : key === 'lowPower' ? '%' : '' });
}
