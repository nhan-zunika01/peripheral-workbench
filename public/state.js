export const tabs = ['customize', 'performance', 'power', 'calibration', 'advanced'];
export const settingTab = id => {
  const key = id.replace(/^session\./, '');
  if (['dpi', 'dpiStages', 'polling', 'pollingWired', 'pollingWireless', 'inGamePolling'].includes(key)) return 'performance';
  if (['battery', 'sleep', 'lowPower'].includes(key)) return 'power';
  if (['calibrationState', 'smartTracking', 'asymmetricTracking', 'calibration'].includes(key)) return 'calibration';
  if (['mouseMapping', 'leftHand', 'advancedMappings'].includes(key)) return 'customize';
  if (key === 'firmware') return 'about';
  if (['profile', 'profileName', 'duplicateProfile', 'resetProfile', 'deleteProfile', 'onboardProfile', 'removeOnboardProfile'].includes(key)) return 'profile';
  return 'advanced';
};
export const sleepScale = id => id === 'sleep' ? 60 : 1;
export const parseRoute = hash => {
  const route = hash.replace(/^#/, '');
  if (['dashboard', 'settings', 'macros', 'profiles', 'catalog', 'catalog/keyboard', 'review'].includes(route)) return route;
  return route.startsWith('device/') && tabs.includes(route.slice(7)) ? route.slice(7) : 'dashboard';
};
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const signature = ({ value, ...schema }) => JSON.stringify(canonical(schema));
const clone = value => value === undefined ? undefined : structuredClone(value);

// Errors are message keys, translated only at the presentation boundary.
export function validate(schema, value) {
  const errors = [];
  if (value === null || value === undefined) return ['required'];
  if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return ['finite'];
    if (schema.integer && !Number.isInteger(value)) errors.push('integer');
    if (schema.min !== undefined && value < schema.min || schema.max !== undefined && value > schema.max) errors.push('bounds');
    if (schema.step && Math.abs((value - (schema.min ?? 0)) / schema.step - Math.round((value - (schema.min ?? 0)) / schema.step)) > 1e-7) errors.push('step');
  }
  if (schema.type === 'boolean' && typeof value !== 'boolean') errors.push('required');
  if (schema.type === 'string' && (typeof value !== 'string' || !value.trim())) errors.push('required');
  if (schema.options && !schema.options.some(o => equal(o.value ?? o, value))) errors.push('option');
  if (schema.type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return ['required'];
    for (const [key, child] of Object.entries(schema.properties || {})) errors.push(...validate(child, value[key]));
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return ['array'];
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) errors.push('arrayBounds');
    for (const item of value) errors.push(...validate(schema.items || {}, item));
  }
  if (schema.format === 'curve' && (!Array.isArray(value) || value.length !== 250 || value.some(v => !Number.isFinite(v) || v <= 0))) errors.push('curveError');
  const id = schema.id?.replace(/^session\./, '');
  if (id === 'dpiStages' && (!Array.isArray(value.stages) || value.active < 1 || value.active > value.stages.length)) errors.push('activeBounds');
  if (id === 'asymmetricTracking' && value.landing >= value.liftOff) errors.push('landingError');
  if (id === 'calibration' && value.isAsymmetric && value.landingDistance >= value.liftOffDistance) errors.push('landingError');
  return [...new Set(errors)];
}

export function createStore() {
  const store = {
    selectedDeviceId: '', devices: [], connected: false, companion: false, busy: false, lockEdits: false,
    snapshot: {}, drafts: new Map(),
    entries() { return this.drafts.get(this.selectedDeviceId) || new Map(); },
    entry(id) { return this.entries().get(id); },
    dirty() { return [...this.entries().values()].some(e => e.dirty); },
    select(id) { this.selectedDeviceId = id; this.connected = false; this.snapshot = {}; },
    discard() { this.drafts.delete(this.selectedDeviceId); },
    ingest(data, { discard = false, applied } = {}) {
      if (this.selectedDeviceId && data.selectedDeviceId && this.selectedDeviceId !== data.selectedDeviceId) throw new Error('Physical device identity mismatch');
      const profileId = data.settings?.find(setting => setting.id === 'session.profile')?.value;
      this.selectedDeviceId ||= data.selectedDeviceId || '';
      this.devices = data.devices || []; this.connected = data.connected === true; this.companion = true; this.snapshot = data;
      if (discard) this.drafts.delete(this.selectedDeviceId);
      const entries = this.entries();
      if (!this.connected) for (const entry of entries.values()) entry.actualFresh = false;
      if (this.connected) {
        const incomingIds = new Set((data.settings || []).map(s => s.id));
        for (const [id, entry] of entries) if (!incomingIds.has(id)) { if (entry.dirty) { entry.stale = true; entry.actualFresh = false; } else entries.delete(id); }
        for (const schema of data.settings || []) {
          const previous = entries.get(schema.id), sig = signature(schema);
          if (previous?.dirty && schema.id !== applied) {
            previous.actual = clone(schema.value); previous.actualFresh = true; previous.actualSignature = sig;
            previous.stale = previous.signature !== sig || !equal(previous.profileId, profileId); previous.externalChange = !equal(previous.baseline, schema.value); continue;
          }
          entries.set(schema.id, { schema: clone(schema), profileId: clone(profileId), signature: sig, actualSignature: sig, baseline: clone(schema.value), actual: clone(schema.value), actualFresh: true, draft: clone(schema.value), dirty: false, stale: false, uncertain: false, errors: [], status: schema.id === applied ? 'applied' : '', verification: previous?.verification || '' });
        }
      }
      this.drafts.set(this.selectedDeviceId, entries);
    },
    edit(id, value, parseError = false) {
      const entry = this.entry(id); if (!entry || !entry.schema.writable || this.lockEdits) return;
      entry.draft = clone(value); entry.dirty = parseError || !equal(entry.baseline, value);
      entry.errors = parseError ? ['jsonError'] : entry.dirty ? validate(entry.schema, value) : [];
      entry.status = ''; entry.technical = '';
    },
    canApply(id) {
      const e = this.entry(id);
      return !!(e && e.schema.writable && this.connected && this.companion && !this.busy && e.dirty && !e.stale && !e.uncertain && !e.errors.length);
    },
    hasUncertain() { return [...this.entries().values()].some(e => e.uncertain); },
    confirmApplied(id, value, verification, { readback = false } = {}) {
      const entry = this.entry(id); if (!entry) return;
      if (readback) entry.actual = clone(entry.baseline);
      else { entry.baseline = clone(value); entry.draft = clone(value); entry.actualFresh = false; }
      entry.dirty = false; entry.uncertain = false; entry.stale = false; entry.errors = []; entry.status = 'applied'; entry.verification = verification;
    },
    reconcile(id) {
      const entry = this.entry(id);
      if (!entry || !entry.actualFresh || entry.stale || entry.signature !== entry.actualSignature || entry.actual === null || entry.actual === undefined) return false;
      entry.baseline = clone(entry.actual); entry.dirty = !equal(entry.baseline, entry.draft); entry.uncertain = false; entry.externalChange = false; entry.status = '';
      entry.errors = entry.dirty ? validate(entry.schema, entry.draft) : [];
      return true;
    }
  };
  return store;
}
