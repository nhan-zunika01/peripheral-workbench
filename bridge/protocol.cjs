// Synapse background-manager rzDevice25 framing: docs/evidence contains source receipts.
function checksum(packet) { let result = 0; for (let index = 2; index < 88; index++) result ^= packet[index]; return result; }
function packet(command, data = [], transaction = 1) {
  if (!Array.isArray(command) || command.length !== 3 || command.some(value => !Number.isInteger(value) || value < 0 || value > 255) || command[0] > 80 || data.length > command[0] || data.some(value => !Number.isInteger(value) || value < 0 || value > 255) || !Number.isInteger(transaction) || transaction < 1 || transaction > 31) throw new Error('Invalid native command');
  const result = Buffer.alloc(90);
  result[1] = transaction; result[5] = command[0]; result[6] = command[1]; result[7] = command[2];
  Buffer.from(data).copy(result, 8);
  result[88] = checksum(result);
  return result;
}
function response(bytes, sent) {
  const result = Buffer.from(bytes);
  if (result.length !== 90 || result[5] > 80) throw new Error('Invalid native response length');
  if (result[88] !== checksum(result)) throw new Error('Native response checksum failed');
  if (result[1] !== sent[1] || result[6] !== sent[6] || result[7] !== sent[7]) throw new Error('Native response did not match the request; Synapse may be using the device');
  if (result[0] !== 2) throw new Error(`Device rejected the command (status ${result[0]})`);
  return [...result.subarray(8, 8 + result[5])];
}
module.exports = { packet, response, checksum };
