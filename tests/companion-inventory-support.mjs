import { groupDevices } from '../bridge/inventory.mjs';
import { createBackend } from '../bridge/backend.mjs';
import nativeHost from '../bridge/native-host.cjs';
import { adapterDevice, fakeHid } from './companion-adapter-support.mjs';

export async function captureInventory(input) {
  let attached = input.hid, nodes = input.pnp || [];
  const groups = groupDevices(attached, nodes), selected = input.selectedId || groups[0]?.id;
  const transcript = [], exchanges = [];
  const backend = createBackend({ inspector: '',
    pnp: async () => { if (input.pnpError) throw new Error(input.pnpError); return nodes; },
    native: async request => {
      transcript.push(request);
      if (input.hidError) throw new Error(input.hidError);
      if (request.action === 'enumerate') return { devices: attached };
      if (input.nativeError) throw new Error(input.nativeError);
      const fake = fakeHid({ devices: attached });
      try { return await nativeHost.handleRequest(request, fake.hid); }
      finally { exchanges.push(...fake.transcript); }
    }
  });
  const results = [];
  for (const action of input.actions || [{ action: 'snapshot' }]) {
    if (action.action === 'detach') { attached = attached.filter(row => !action.paths.includes(row.path)); nodes = action.pnp || []; continue; }
    try {
      if (action.action === 'apply') results.push(await backend.apply(selected, 'dpi', { x: 1600, y: 1600 }));
      else results.push(await backend.snapshot(action.omitSelection ? undefined : selected));
    } catch (error) { results.push({ error: error.message, status: error.status }); }
  }
  return { groups, selectedDeviceId: selected || null, results, transcript, exchanges };
}
export function inventoryCases() {
  const a = { ...adapterDevice, path: String.raw`\\?\hid#vid_1532&pid_00df#unit-a#{guid}`, product: 'Razer Viper' };
  const b = { ...a, path: String.raw`\\?\hid#vid_1532&pid_00df#unit-b#{guid}` };
  const pnp = [{ instanceId: 'HID\\VID_1532&PID_00DF\\UNIT-A', containerId: '{abcd}', name: 'Razer mouse' }, { instanceId: 'USB\\VID_1532&PID_00DF\\UNIT-A', containerId: '{abcd}', name: 'Razer USB' }, { instanceId: 'AUDIO\\UNIT-C', containerId: '{audio}', name: 'Razer headset' }];
  const sortInput = { hid: ['a', 'A', 'Z', 'á'].map((name, index) => ({ ...a, path: `sort-unit-${index}`, product: `Razer ${name}` })), actions: [{ action: 'snapshot', omitSelection: true }] };
  const sortGroups = groupDevices(sortInput.hid);
  const byteOrder = [...sortGroups].sort((a, b) => Number(b.supported) - Number(a.supported) || Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)) || a.id.localeCompare(b.id));
  return [
    { id: 'container-group', input: { hid: [a, b, { ...a, vendorId: 1, path: 'unrelated' }], pnp } },
    { id: 'no-container', input: { hid: [a], pnp: [{ ...pnp[0], containerId: '' }] } },
    { id: 'zero-container', input: { hid: [a], pnp: [{ ...pnp[0], containerId: '{00000000-0000-0000-0000-000000000000}' }] } },
    { id: 'two-identical', input: { hid: [a, b] } },
    { id: 'stale-selection', input: { hid: [a, b], selectedId: groupDevices([a])[0].id, actions: [{ action: 'snapshot' }, { action: 'detach', paths: [a.path] }, { action: 'snapshot' }, { action: 'apply' }] } },
    { id: 'unknown-sku', input: { hid: [{ ...a, productId: 0x1234 }], actions: [{ action: 'snapshot' }, { action: 'apply' }] } },
    { id: 'pnp-only', input: { hid: [], pnp } },
    { id: 'deterministic-sort', input: sortInput, candidateDifference: { reason: 'Rust sorts supported-first/name UTF-8 bytes/id; Node uses captured locale collation.', locale: Intl.DateTimeFormat().resolvedOptions().locale, groupIds: byteOrder.map(row => row.id), selectedDeviceId: byteOrder[0].id } },
    { id: 'connected-warning', input: { hid: [a], pnpError: 'Synthetic PnP collector failure' } },
    { id: 'disconnected-warning', input: { hid: [], pnpError: 'Synthetic PnP collector failure' } },
    { id: 'native-error-warning', input: { hid: [a], pnpError: 'Synthetic PnP collector failure', nativeError: 'Synthetic snapshot failure' } },
    { id: 'hid-error-warning', input: { hid: [], hidError: 'Synthetic HID enumeration failure', pnpError: 'Synthetic PnP collector failure' } }
  ];
}
