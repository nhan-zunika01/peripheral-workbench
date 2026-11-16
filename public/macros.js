export const macroStorageKey = 'device-control-macros-v1';
const MAX_MACROS = 100, MAX_EVENTS = 500;
export const macroLimits = Object.freeze({ macros: MAX_MACROS, events: MAX_EVENTS, importBytes: 32_000_000 });
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
  if (typeof source !== 'string' || source.length > macroLimits.importBytes || new TextEncoder().encode(source).length > macroLimits.importBytes) throw new Error('importSize');
  let data;
  try { data = JSON.parse(source); } catch { throw new Error('jsonError'); }
  if (!plain(data) || Object.keys(data).sort().join(',') !== 'macros,version' || data.version !== 1 || !Array.isArray(data.macros) || data.macros.length > MAX_MACROS) throw new Error('macroFormat');
  const macros = data.macros.map(macro => {
    if (!plain(macro) || Object.keys(macro).sort().join(',') !== [...keys].sort().join(',') || !text(macro.name) || !Array.isArray(macro.events) || macro.events.length > MAX_EVENTS || !macro.events.every(event => validEvent(event))) throw new Error('macroFormat');
    return { id: id(), name: macro.name, events: macro.events.map(event => ({ ...event })) };
  });
  return macros;
}

export function createMacroWriter(library, { locks = globalThis.navigator?.locks, target = globalThis, onChange = () => {} } = {}) {
  let release, pending, active = true, generation = 0;
  const supported = typeof locks?.request === 'function';
  library.setAccess(supported ? 'readonly' : 'memory');
  function acquire({ replaceDraft = false } = {}) {
    if (!active || !supported) return Promise.resolve(false);
    if (release) {
      if (library.writable) return Promise.resolve(true);
      const recovered = library.setAccess('writer', { replaceDraft }) && library.writable;
      onChange(); return Promise.resolve(recovered);
    }
    if (pending) return pending;
    const epoch = generation, draft = replaceDraft ? library.macros : null;
    let finish;
    pending = new Promise(resolve => { finish = resolve; });
    const result = pending;
    const done = value => { pending = null; onChange(); finish(value); };
    Promise.resolve().then(() => locks.request(macroStorageKey, { mode: 'exclusive', ifAvailable: true }, async lock => {
      if (!active || epoch !== generation || !lock || (replaceDraft && library.macros !== draft)) { done(false); return; }
      if (!library.setAccess('writer', { replaceDraft })) { done(false); return; }
      const held = new Promise(resolve => { release = resolve; });
      done(true);
      await held;
    })).catch(() => { library.setAccess('memory'); done(false); });
    return result;
  }
  target.addEventListener('pagehide', () => {
    active = false; generation++;
    if (supported) library.setAccess('readonly');
    release?.(); release = null;
  });
  target.addEventListener('pageshow', () => { active = true; acquire(); });
  target.addEventListener('storage', event => {
    if ((event.key === macroStorageKey || event.key === null) && library.access === 'readonly') { library.reload(); onChange(); }
  });
  return { acquire };
}

export function createMacroLibrary(storage, { access = 'memory' } = {}) {
  if (!['writer', 'readonly', 'memory'].includes(access)) throw new Error('macroReadOnly');
  let macros = [], persistent = false, readable = false, error = '', protectedDraft = false;
  try { storage ??= globalThis.localStorage; } catch { error = 'macroStorageRead'; }
  function reload(replaceDraft = false) {
    if (protectedDraft && !replaceDraft) { error = 'macroExportFirst'; return false; }
    if (!storage) { readable = false; persistent = false; return false; }
    try {
      const saved = storage.getItem(macroStorageKey);
      let loaded = [];
      if (saved !== null) {
        const data = JSON.parse(saved);
        const ids = new Set();
        if (!plain(data) || Object.keys(data).sort().join(',') !== 'macros,version' || data.version !== 1 || !Array.isArray(data.macros) || data.macros.length > MAX_MACROS || !data.macros.every(m => {
          const valid = plain(m) && typeof m.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(m.id) && !ids.has(m.id) && Object.keys(m).sort().join(',') === 'events,id,name' && text(m.name) && Array.isArray(m.events) && m.events.length <= MAX_EVENTS && m.events.every(event => validEvent(event, true));
          if (valid) ids.add(m.id); return valid;
        })) throw new Error();
        loaded = data.macros.map(m => structuredClone(m));
      }
      macros = loaded; protectedDraft = false; readable = true; persistent = access !== 'memory'; error = ''; return true;
    } catch { readable = false; persistent = false; error = 'macroStorageRead'; return false; }
  }
  if (!error) reload();
  function save() {
    if (access !== 'writer' || !readable) return false;
    try { storage.setItem(macroStorageKey, JSON.stringify({ version: 1, macros })); persistent = true; protectedDraft = false; error = ''; return true; }
    catch { persistent = false; error = 'macroStorageWrite'; return false; }
  }
  function changed() { protectedDraft = true; persistent = false; save(); }
  return {
    get macros() { return macros; }, get persistent() { return persistent; }, get error() { return error; }, get writable() { return access === 'writer' && readable; },
    get editable() { return access !== 'readonly'; }, get access() { return access; }, get protectedDraft() { return protectedDraft; },
    get status() { return error || (access === 'readonly' ? 'macroReadOnly' : access === 'memory' ? 'macroLockUnavailable' : !persistent ? 'macroMemoryOnly' : 'macroSaved'); },
    save, reload: () => reload(),
    setAccess(next, { replaceDraft = false } = {}) {
      if (!['writer', 'readonly', 'memory'].includes(next)) return false;
      // Keep unsaved events repairable after losing the lock, without writing shared storage.
      if (next === 'readonly' && protectedDraft) { next = 'memory'; error = 'macroExportFirst'; }
      if (next === access && (next !== 'writer' || readable)) return true;
      if (next === 'writer' && protectedDraft && !replaceDraft) { error = 'macroExportFirst'; return false; }
      const previousAccess = access;
      access = next;
      if (next === 'writer' && !reload(replaceDraft) && protectedDraft) { access = previousAccess; return false; }
      if (next === 'memory') persistent = false;
      return true;
    },
    get valid() { return macros.every(m => text(m.name) && m.events.every(event => validEvent(event))); },
    create() { if (access === 'readonly' || macros.length >= MAX_MACROS) return null; const macro = { id: id(), name: 'New macro', events: [] }; macros = [...macros, macro]; changed(); return macro; },
    update(macroId, changes) {
      if (access === 'readonly') return false;
      const index = macros.findIndex(m => m.id === macroId); if (index < 0) return false;
      const next = { ...macros[index], ...structuredClone(changes) };
      if (Object.keys(changes).some(key => !keys.has(key)) || !text(next.name) || !Array.isArray(next.events) || next.events.length > MAX_EVENTS || !next.events.every(event => validEvent(event, true))) return false;
      macros = macros.map((m, i) => i === index ? next : m); changed(); return true;
    },
    remove(macroId) { if (access === 'readonly') return false; const next = macros.filter(m => m.id !== macroId); if (next.length === macros.length) return false; macros = next; changed(); return true; },
    import(source) {
      if (access === 'readonly') throw new Error('macroReadOnly');
      const incoming = parseMacroImport(source); if (macros.length + incoming.length > MAX_MACROS) throw new Error('macroLimit');
      macros = [...macros, ...incoming]; changed(); return incoming;
    },
    export() {
      if (!macros.every(m => text(m.name) && m.events.every(event => validEvent(event)))) throw new Error('macroFormat');
      return JSON.stringify({ version: 1, macros: macros.map(({ name, events }) => ({ name, events })) }, null, 2);
    }
  };
}
