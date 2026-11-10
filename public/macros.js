const KEY = 'device-control-macros-v1', LIMIT = 1_000_000, MAX_MACROS = 100, MAX_EVENTS = 500;
const keys = new Set(['name', 'events']), eventKeys = new Set(['kind', 'input', 'action', 'delayMs']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const id = () => globalThis.crypto?.randomUUID?.() || `macro-${Date.now()}-${Math.random().toString(16).slice(2)}`;
const text = value => typeof value === 'string' && !!value.trim() && value.length <= 64 && !/[\u0000-\u001f\u007f]/.test(value);
const validEvent = (event, allowEmptyKey = false) => {
  if (!plain(event) || Object.keys(event).some(key => !eventKeys.has(key)) || !Number.isInteger(event.delayMs) || event.delayMs < 0 || event.delayMs > 60000) return false;
  if (event.kind === 'delay') return Object.keys(event).sort().join(',') === 'delayMs,kind';
  if (event.kind === 'key') return Object.keys(event).sort().join(',') === 'action,delayMs,input,kind' && typeof event.input === 'string' && event.input.length <= 32 && (text(event.input) || allowEmptyKey && event.input === '') && !/[\u0000-\u001f\u007f]/.test(event.input) && ['down', 'up'].includes(event.action);
  return event.kind === 'mouse' && Object.keys(event).sort().join(',') === 'action,delayMs,input,kind' && ['left', 'right', 'middle', 'button4', 'button5', 'wheelup', 'wheeldown', 'wheelleft', 'wheelright'].includes(event.input) && ['down', 'up'].includes(event.action);
};

export function parseMacroImport(source) {
  if (typeof source !== 'string' || new TextEncoder().encode(source).length > LIMIT) throw new Error('importSize');
  let data;
  try { data = JSON.parse(source); } catch { throw new Error('jsonError'); }
  if (!plain(data) || Object.keys(data).sort().join(',') !== 'macros,version' || data.version !== 1 || !Array.isArray(data.macros) || data.macros.length > MAX_MACROS) throw new Error('macroFormat');
  const macros = data.macros.map(macro => {
    if (!plain(macro) || Object.keys(macro).sort().join(',') !== [...keys].sort().join(',') || !text(macro.name) || !Array.isArray(macro.events) || macro.events.length > MAX_EVENTS || !macro.events.every(event => validEvent(event))) throw new Error('macroFormat');
    return { id: id(), name: macro.name, events: macro.events.map(event => ({ ...event })) };
  });
  return macros;
}

export function createMacroLibrary(storage) {
  let macros = [], persistent = false, writable = false, error = '';
  try { storage ??= globalThis.localStorage; } catch { error = 'macroStorageRead'; }
  if (storage && !error) {
    try {
      const saved = storage.getItem(KEY);
      if (saved !== null) {
        const data = JSON.parse(saved);
        const ids = new Set();
        if (!plain(data) || Object.keys(data).sort().join(',') !== 'macros,version' || data.version !== 1 || !Array.isArray(data.macros) || data.macros.length > MAX_MACROS || !data.macros.every(m => {
          const valid = plain(m) && typeof m.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(m.id) && !ids.has(m.id) && Object.keys(m).sort().join(',') === 'events,id,name' && text(m.name) && Array.isArray(m.events) && m.events.length <= MAX_EVENTS && m.events.every(event => validEvent(event, true));
          if (valid) ids.add(m.id); return valid;
        })) throw new Error();
        macros = data.macros.map(m => structuredClone(m));
      }
      persistent = true; writable = true;
    } catch { error = 'macroStorageRead'; }
  }
  function save() {
    if (!writable) return false;
    try { storage.setItem(KEY, JSON.stringify({ version: 1, macros })); persistent = true; error = ''; return true; }
    catch { persistent = false; error = 'macroStorageWrite'; return false; }
  }
  return {
    get macros() { return macros; }, get persistent() { return persistent; }, get error() { return error; }, get writable() { return writable; },
    save,
    get valid() { return macros.every(m => text(m.name) && m.events.every(event => validEvent(event))); },
    create() { if (macros.length >= MAX_MACROS) return null; const macro = { id: id(), name: 'New macro', events: [] }; macros = [...macros, macro]; save(); return macro; },
    update(macroId, changes) {
      const index = macros.findIndex(m => m.id === macroId); if (index < 0) return false;
      const next = { ...macros[index], ...structuredClone(changes) };
      if (Object.keys(changes).some(key => !keys.has(key)) || !text(next.name) || !Array.isArray(next.events) || next.events.length > MAX_EVENTS || !next.events.every(event => validEvent(event, true))) return false;
      macros = macros.map((m, i) => i === index ? next : m); save(); return true;
    },
    remove(macroId) { const next = macros.filter(m => m.id !== macroId); if (next.length === macros.length) return false; macros = next; save(); return true; },
    import(source) {
      const incoming = parseMacroImport(source); if (macros.length + incoming.length > MAX_MACROS) throw new Error('macroLimit');
      macros = [...macros, ...incoming]; save(); return incoming;
    },
    export() {
      if (!macros.every(m => text(m.name) && m.events.every(event => validEvent(event)))) throw new Error('macroFormat');
      return JSON.stringify({ version: 1, macros: macros.map(({ name, events }) => ({ name, events })) }, null, 2);
    }
  };
}

export const macroLimits = { macros: MAX_MACROS, events: MAX_EVENTS };
