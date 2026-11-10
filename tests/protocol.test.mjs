import { test } from 'node:test';
import assert from 'node:assert/strict';
import protocol from '../bridge/protocol.cjs';
test('Synapse framing uses 90 bytes, transaction, command and XOR checksum', () => {
  const packet = protocol.packet([7, 4, 133], [0], 7);
  assert.equal(packet.length, 90);
  assert.deepEqual([...packet.subarray(0, 9)], [0, 7, 0, 0, 0, 7, 4, 133, 0]);
  assert.equal(packet[88], 7 ^ 4 ^ 133);
  const reply = Buffer.from(packet); reply[0] = 2;
  assert.deepEqual(protocol.response(reply, packet), [0, 0, 0, 0, 0, 0, 0]);
  reply[1] = 8; assert.throws(() => protocol.response(reply, packet), /match/);
  reply[1] = 7; reply[0] = 5; assert.throws(() => protocol.response(reply, packet), /rejected/);
  assert.throws(() => protocol.packet([81, 4, 133]));
  assert.throws(() => protocol.packet([1, 4, 133], [256]));
});
