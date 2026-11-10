import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { readFileSync } from 'node:fs';
import { rustRequest } from '../bridge/rust-transport.mjs';
import nativeHost from '../bridge/native-host.cjs';
import protocol from '../bridge/protocol.cjs';

const device = { vendorId: 0x1532, productId: 0xdf, interface: 0, path: 'unit-a' };
const request = { action: 'snapshot', deviceId: 'a'.repeat(24), target: [device.path] };
const executable = 'C:\\task\\razer-hid-helper.exe';

test('Node and Rust share the immutable golden packet/response fixtures', () => {
  for (const fixture of JSON.parse(readFileSync(new URL('../bridge/rust/fixtures/protocol.json', import.meta.url)))) {
    const sent = protocol.packet(fixture.command, fixture.data, fixture.transaction);
    assert.deepEqual([...sent], fixture.packet, fixture.name);
    if (fixture.error) assert.throws(() => protocol.response(fixture.response, sent), { message: fixture.error });
    else assert.deepEqual(protocol.response(fixture.response, sent), fixture.result, fixture.name);
  }
});

function fakeHelper({ deferClose = false } = {}) {
  const commands = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin = new Writable({ write(chunk, _, done) {
    const value = JSON.parse(chunk); commands.push(value);
    let result = { result: true };
    if (value.action === 'enumerate') result.result = [device];
    if (value.action === 'exchange') {
      if (value.command[1] === 0 && value.command[2] === 129) result.result = [1, 2];
      else if (value.command[1] === 4 && value.command[2] === 133) result.result = [0, 3, 32, 3, 32];
      else result = { error: 'Unavailable getter' };
    }
    queueMicrotask(() => child.stdout.write(`${JSON.stringify(result)}\n`)); done();
  } });
  child.kill = () => { child.killed = true; if (!deferClose) queueMicrotask(() => child.emit('close', null)); };
  return { child, commands, spawnHelper: () => child };
}

test('experimental Rust snapshots are read-only and terminate before releasing operation', async () => {
  const fake = fakeHelper({ deferClose: true });
  let settled = false;
  const pending = rustRequest(request, { executable, spawnHelper: fake.spawnHelper }).then(value => { settled = true; return value; });
  while (!fake.child.killed) await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  fake.child.emit('close', null);
  const state = await pending;
  assert.equal(state.connected, true);
  assert.equal(state.settings.find(setting => setting.id === 'dpi').writable, false);
  assert.match(state.message, /read-only/);
  assert.deepEqual(fake.commands.filter(command => command.action === 'open').map(command => command.path), ['unit-a']);
});

test('Rust apply requires explicit opt-in, fails once, and holds failure until process closes', async () => {
  let spawned = 0;
  await assert.rejects(rustRequest({ ...request, action: 'apply' }, { executable, spawnHelper: () => { spawned++; } }), /read-only/);
  assert.equal(spawned, 0);
  await assert.rejects(rustRequest(request, { executable: 'relative.exe' }), /absolute path/);
  const fake = fakeHelper({ deferClose: true });
  const pending = rustRequest({ ...request, action: 'apply', change: { id: 'dpi', value: { x: 800, y: 800 } } }, { executable, allowWrites: true, spawnHelper: fake.spawnHelper });
  let settled = false; pending.catch(() => { settled = true; });
  while (!fake.child.killed) await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false);
  fake.child.emit('close', null);
  await assert.rejects(pending, /Unavailable getter/);
  assert.equal(fake.commands.filter(value => value.action === 'exchange' && value.command[2] === 5).length, 1);
});

test('shared native adapter rejects stale targets, PID/interface mismatch and short payloads', async () => {
  let opened = 0;
  const hid = { devices: () => [device], HID: class {
    constructor() { opened++; }
    exchange(command) { if (command[1] === 0 && command[2] === 129) return [1, 2]; return []; }
    close() {}
  } };
  await assert.rejects(nativeHost.handleRequest({ ...request, target: ['unit-b'] }, hid), /no longer attached/);
  await assert.rejects(nativeHost.handleRequest(request, { ...hid, devices: () => [{ ...device, productId: 0x1234 }] }), /no longer attached/);
  const wrongInterface = await nativeHost.handleRequest(request, { ...hid, devices: () => [{ ...device, interface: 1 }] });
  assert.equal(wrongInterface.connected, false); assert.equal(opened, 0);
  const state = await nativeHost.handleRequest(request, hid);
  assert.equal(state.settings.some(setting => setting.id === 'dpi'), false);
  assert.equal(state.settings.some(setting => setting.id === 'dpiStages'), false);
  assert.ok(state.unavailable.some(message => /Current DPI: Invalid setting response length/.test(message)));
});

test('legacy native path retains 91-byte feature reports and rejects incomplete sends', async () => {
  async function run(written) {
    let sent, calls = 0;
    const hid = { HID: class {
      sendFeatureReport(bytes) { assert.equal(bytes.length, 91); assert.equal(bytes[0], 0); sent = Buffer.from(bytes.slice(1)); calls++; return written; }
      getFeatureReport(id, length) {
        assert.equal(id, 0); assert.equal(length, 91);
        if (sent[6] !== 0 || sent[7] !== 129) throw new Error('Unavailable getter');
        const reply = Buffer.from(sent); reply[0] = 2; reply[8] = 1; reply[9] = 2; reply[88] = protocol.checksum(reply);
        return [0, ...reply];
      }
      close() {}
    } };
    if (written !== 91) { await assert.rejects(nativeHost.inspect([device], undefined, hid), /Incomplete HID feature report/); assert.equal(calls, 1); }
    else assert.equal((await nativeHost.inspect([device], undefined, hid)).settings[0].value, '1.2');
  }
  await run(91); await run(90);
});

test('shared custom curve preserves Float32, chunk order, readback, and partial-write failure', async () => {
  async function run(failAt) {
    const curve = Array(250).fill(1), writes = [];
    const hid = { HID: class {
      exchange(command, data) {
        if (command[1] === 0 && command[2] === 129) return [1, 2];
        if (command[1] !== 11) throw new Error('Unavailable getter');
        if (command[2] === 145) return [1, 3];
        if ([16, 17].includes(command[2])) return data;
        if ([147, 19].includes(command[2])) {
          const [, , , offset, count] = data;
          if (command[2] === 19) {
            writes.push(offset); if (offset === failAt) throw new Error('Simulated uncertain chunk');
            const bytes = Buffer.from(data.slice(5));
            for (let index = 0; index < count; index++) curve[offset + index] = bytes.readFloatLE(index * 4);
          }
          const bytes = Buffer.alloc(count * 4);
          for (let index = 0; index < count; index++) bytes.writeFloatLE(curve[offset + index], index * 4);
          return [...data.slice(0, 5), ...bytes];
        }
        throw new Error('Unavailable getter');
      }
      close() {}
    } };
    const operation = nativeHost.inspect([device], { id: 'customCurve', value: Array(250).fill(Math.PI) }, hid);
    if (failAt !== undefined) { await assert.rejects(operation, /uncertain chunk/); assert.deepEqual(writes, [0, 8, 16]); }
    else { assert.deepEqual(await operation, { verified: true, verification: 'hardware-readback' }); assert.equal(curve[249], Math.fround(Math.PI)); assert.deepEqual(writes, Array.from({ length: 32 }, (_, index) => index * 8)); }
  }
  await run(); await run(16);
});

test('shared smart tracking uses exact acknowledgement without claiming mode readback', async () => {
  const writes = [];
  const hid = { HID: class {
    exchange(command, data) {
      if (command[1] === 0 && command[2] === 129) return [1, 2];
      if (command[1] === 11 && command[2] === 131) return [0, 4, 1];
      if (command[1] === 11 && [3, 11].includes(command[2])) { writes.push(data); return data; }
      throw new Error('Unavailable getter');
    }
    close() {}
  } };
  assert.deepEqual(await nativeHost.inspect([device], { id: 'smartTracking', value: 3 }, hid), { verified: true, verification: 'hardware-acknowledgement' });
  assert.deepEqual(writes, [[0, 4, 1], [0, 4, 1, 2]]);
});
