// Candidate scenarios send actual HTTP through the socket; IPC only controls fake backend gates/clock.
import { createTransport } from '../public/transport.js';
import { request, deviceId, change, token, origin, basicSetting, scrubPairToken } from './companion-wire-support.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
export async function captureRemoteScenario(target, input) {
  const { server, command } = target;
  const observe = async () => (await command('observe')).transcript;
  const reset = (backend = {}, extras = {}) => command('reset', { backend, token, origin, fakeMode: 'approved-write', ...extras });
  if (input.kind === 'auth') {
    await reset(input.nullBaseline ? { setting: { ...basicSetting, value: null } } : {}, { token: 'b'.repeat(64) });
    const requests = []; let pairs = 0, attempts = 0;
    const transport = createTransport(async (url, options) => {
      const path = new URL(url).pathname + new URL(url).search;
      if (path === '/api/pair') { if (++pairs > 1) await command('set-token', { token }); }
      else { attempts++; await command('set-token', { token: input.fail && attempts > 1 ? 'c'.repeat(64) : token }); }
      const before = await observe();
      const response = await request(server, { path, method: options.method, raw: options.body, headers: options.headers, omit: Object.hasOwn(options.headers, 'Authorization') ? [] : ['Authorization'] });
      const after = await observe(), recorded = structuredClone(response);
      if (path === '/api/pair' && response.status === 200) scrubPairToken(recorded, pairs === 1 ? 'b'.repeat(64) : token);
      requests.push({ path, requestHex: Buffer.from(options.body || '').toString('hex'), response: recorded, dispatches: after.filter(row => row.action === 'apply').length - before.filter(row => row.action === 'apply').length, snapshots: after.filter(row => row.action === 'snapshot').length - before.filter(row => row.action === 'snapshot').length });
      return { status: response.status, ok: response.status >= 200 && response.status < 300, json: async () => response.body };
    });
    let result;
    try { result = input.read ? await transport.read(deviceId) : await transport.apply(deviceId, 'dpi', 1600, ...(input.omitExpected ? [] : [input.nullExpected ? null : 800])); }
    catch (error) { if (error.contractViolation) throw error; result = { error: error.message, status: error.status, ...(error.code ? { code: error.code, actualValue: error.actualValue } : {}) }; }
    return { requests, result, transcript: await observe() };
  }
  if (input.kind === 'shared') {
    await reset({}, { hold: 'first-snapshot' });
    const firstPath = `/api/state${input.first ? `?deviceId=${input.first}` : ''}`, secondPath = `/api/state${input.second ? `?deviceId=${input.second}` : ''}`;
    const first = request(server, { path: firstPath }); await command('checkpoint', { action: 'snapshot', count: 1 });
    const second = request(server, { path: secondPath }); await command('barrier', { requests: 2 }); await tick();
    const snapshotsBeforeRelease = (await observe()).length;
    await command('release'); const responses = await Promise.all([first, second]);
    responses.push(await request(server, { path: firstPath }));
    const transcript = await observe(); return { responses, snapshotsBeforeRelease, snapshots: transcript.length, transcript };
  }
  if (input.kind === 'lease') {
    await reset({}, { hold: 'apply' });
    const post = raw => ({ method: 'POST', path: '/api/settings', raw });
    const first = request(server, post(change('1600'))); await command('checkpoint', { action: 'apply', count: 1 });
    await command('advance', { milliseconds: 75000 }); const responses = [await first];
    responses.push(await request(server, post('{')));
    responses.push(await request(server, { ...post('{'), headers: { 'Content-Type': 'text/plain' } }));
    responses.push(await request(server, post(change('99')))); responses.push(await request(server, post(change('1800'))));
    const reading = request(server); await command('barrier', { requests: 6 });
    const transcriptBeforeRelease = await observe(), writesBeforeRelease = transcriptBeforeRelease.filter(row => row.action === 'apply').length;
    await command('release'); responses.push(await reading); responses.push(await request(server, post(change('1800'))));
    return { elapsedVirtualMs: 75000, responses, writesBeforeRelease, transcriptBeforeRelease, transcript: await observe() };
  }
  throw new Error(`Unknown remote contract scenario ${input.kind}`);
}
