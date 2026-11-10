const clone = value => structuredClone(value);

export function createReviewLedger() {
  const items = [];
  return {
    items,
    stage(deviceId, entry) {
      if (!deviceId || !entry?.dirty || !entry.schema.writable || entry.uncertain || entry.stale || entry.errors.length) return null;
      const previous = [...items].reverse().find(item => item.deviceId === deviceId && item.settingId === entry.schema.id);
      const value = clone(entry.draft), before = clone(entry.actual);
      if (previous && ['pending', 'needs-review'].includes(previous.status)) {
        Object.assign(previous, { before, value, reviewedBefore: clone(before), schema: clone(entry.schema), message: '' });
        previous.status = 'pending'; return previous;
      }
      const attempt = items.filter(item => item.deviceId === deviceId && item.settingId === entry.schema.id).length + 1;
      const operation = { id: `${deviceId}:${entry.schema.id}:${attempt}`, settingId: entry.schema.id, deviceId, label: entry.schema.label || entry.schema.id, before, value, reviewedBefore: clone(before), schema: clone(entry.schema), status: 'pending', verification: '', warning: '', message: '' };
      items.push(operation); return operation;
    },
    forDevice(deviceId) { return items.filter(item => item.deviceId === deviceId); },
    pending(deviceId) { return items.filter(item => item.deviceId === deviceId && item.status === 'pending'); },
    cancel(id) { const item = this.find(id); if (!item || !['pending', 'needs-review'].includes(item.status)) return false; item.status = 'cancelled'; item.message = 'draftDiscarded'; return true; },
    cancelPending(deviceId) { for (const item of items) if (item.deviceId === deviceId && ['pending', 'needs-review'].includes(item.status)) { item.status = 'cancelled'; item.message = 'draftDiscarded'; } },
    cancelSetting(deviceId, settingId) { for (const item of items) if (item.deviceId === deviceId && item.settingId === settingId && ['pending', 'needs-review'].includes(item.status)) this.cancel(item.id); },
    find(id) { return items.find(item => item.id === id); }
  };
}
