export function createTransport(fetcher = globalThis.fetch) {
  let token = '', busy = false;
  async function request(path, body, retry = true) {
    const response = await fetcher(`http://127.0.0.1:17321${path}`, {
      method: body ? 'POST' : 'GET', mode: 'cors', credentials: 'omit', cache: 'no-store',
      targetAddressSpace: 'loopback', signal: AbortSignal.timeout(80000),
      headers: { ...(token && path !== '/api/pair' ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const data = await response.json();
    // The companion rejects authentication before dispatching any operation.
    if (response.status === 401 && retry && path !== '/api/pair') { token = ''; await pair(); return request(path, body, false); }
    if (!response.ok) throw Object.assign(new Error(data.error || `Companion returned ${response.status}`), { status: response.status, ...(data.code ? { code: data.code } : {}), ...(Object.hasOwn(data, 'actualValue') ? { actualValue: data.actualValue } : {}) });
    return data;
  }
  async function pair() {
    const data = await request('/api/pair');
    if (!/^[a-f0-9]{64}$/.test(data.token)) throw new Error('Invalid companion token');
    token = data.token;
  }
  async function operation(action) {
    if (busy) return null;
    busy = true;
    try { if (!token) await pair(); return await action(); } finally { busy = false; }
  }
  const read = deviceId => operation(async () => {
    const snapshot = await request(`/api/state${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`);
    return Array.isArray(snapshot?.settings) ? { ...snapshot, settings: snapshot.settings.map(setting => ({ ...setting, writable: false })) } : snapshot;
  });
  return {
    get busy() { return busy; }, read,
    poll: (deviceId, hidden) => hidden || busy ? Promise.resolve(null) : read(deviceId),
    apply: () => Promise.reject(new Error('Hosted transport is read-only'))
  };
}
