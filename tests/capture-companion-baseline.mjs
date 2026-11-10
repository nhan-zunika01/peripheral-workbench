// Explicit oracle generation only. Never called by tests or by a Rust candidate.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureWire, trustCases, valueCases } from './companion-wire-support.mjs';
import { adapterCases, captureAdapter } from './companion-adapter-support.mjs';
import { fixture as uiFixture } from './ui-fixture.mjs';
import { inventoryCases, captureInventory } from './companion-inventory-support.mjs';
import { scenarioCases, captureScenario } from './companion-scenario-support.mjs';

if (process.argv[2] !== '--baseline-legacy') throw new Error('Oracle capture requires explicit --baseline-legacy');
const sha = path => createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex');
const sources = ['bridge/server.mjs', 'bridge/backend.mjs', 'bridge/inventory.mjs', 'bridge/native-host.cjs', 'public/transport.js', 'tests/ui-fixture.mjs', 'tests/fixtures/rust-read-only-parity.json'];
const sourceLines = { 'bridge/server.mjs': ['10-31 schema validation', '38-56 read coalescing/lease', '64-109 trust boundary/routes/compare/apply'], 'bridge/backend.mjs': ['31-63 injected collectors/selection/warning spread'], 'bridge/inventory.mjs': ['5-23 normalize/hash/group/locale sort'], 'bridge/native-host.cjs': ['5-124 exported fake-HID adapter', '65-112 polling and conditional schemas', '125-138 explicit target/require-main guard'], 'public/transport.js': ['3-30 pair/401/resend/key presence'], 'tests/ui-fixture.mjs': ['5-26 sixteen synthetic browser schemas'], 'tests/fixtures/rust-read-only-parity.json': ['17-39 old native fourteen-schema receipt'] };
const fixture = { format: 1, provenance: { oracle: 'legacy JavaScript with fake backend/HID/PnP only', physicalParity: false, sources: Object.fromEntries(sources.map(path => [path, sha(path)])), sourceLines }, wire: [] };
const prior = name => {
  const path = new URL(`./fixtures/${name}.json`, import.meta.url);
  const previous = existsSync(path) ? JSON.parse(readFileSync(path)) : {};
  if (previous.provenance) assert.deepEqual(previous.provenance.sources, fixture.provenance.sources, 'Legacy source changed; frozen observations require a separate review, not automatic regeneration');
  return previous;
};
const previousContract = prior('companion-contract'), previousAdapter = prior('adapter-parity'), previousInventory = prior('inventory-parity');
const writeFixture = (name, value) => {
  const fields = Object.entries(value).map(([key, child]) => `${JSON.stringify(key)}:${['wire', 'scenarios', 'cases'].includes(key) ? '[\n' + child.map(row => JSON.stringify(row)).join(',\n') + '\n]' : JSON.stringify(child)}`);
  writeFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), '{\n' + fields.join(',\n') + '\n}\n');
};
for (const row of [...trustCases(), ...valueCases()]) fixture.wire.push({ ...row, legacy: previousContract.wire?.find(old => old.id === row.id)?.legacy ?? await captureWire(row.input) });
fixture.scenarios = [];
for (const row of scenarioCases()) fixture.scenarios.push({ ...row, legacy: previousContract.scenarios?.find(old => old.id === row.id)?.legacy ?? await captureScenario(row.input) });
writeFixture('companion-contract', fixture);
const old = JSON.parse(readFileSync(new URL('./fixtures/rust-read-only-parity.json', import.meta.url))).observations.find(row => row.transport === 'native');
const adapter = { format: 1, provenance: fixture.provenance, oldReceipt: { settingIds: old.settingIds, unavailable: old.unavailable }, uiSnapshot: uiFixture(), cases: [] };
for (const row of adapterCases()) adapter.cases.push({ ...row, legacy: previousAdapter.cases?.find(old => old.id === row.id)?.legacy ?? await captureAdapter(row.input) });
writeFixture('adapter-parity', adapter);
const inventory = { format: 1, provenance: fixture.provenance, cases: [] };
for (const row of inventoryCases()) {
  const captured = { ...row, legacy: previousInventory.cases?.find(old => old.id === row.id)?.legacy ?? await captureInventory(row.input) };
  if (row.candidateDifference) {
    const order = row.candidateDifference.groupIds;
    captured.candidateExpected = await captureInventory({ ...row.input, selectedId: row.candidateDifference.selectedDeviceId, actions: [{ action: 'snapshot' }] });
    const sort = rows => rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    sort(captured.candidateExpected.groups);
    for (const result of captured.candidateExpected.results) if (result.devices) sort(result.devices);
  }
  inventory.cases.push(captured);
}
writeFixture('inventory-parity', inventory);
