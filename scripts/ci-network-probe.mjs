import net from 'node:net';
import { once } from 'node:events';

const [address, portText] = process.argv.slice(2);
const port = Number(portText);
if (!net.isIPv4(address) || !Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Expected an IPv4 address and TCP port');
}

function connect(host, targetPort) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port: targetPort });
    const finish = (connected, error = null) => { socket.destroy(); resolve({ connected, error }); };
    socket.setTimeout(5000, () => finish(false, 'TIMEOUT'));
    socket.once('connect', () => finish(true));
    socket.once('error', error => finish(false, error.code || error.message));
  });
}

const server = net.createServer(socket => socket.destroy());
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let loopback;
try { loopback = await connect('127.0.0.1', server.address().port); }
finally { await new Promise(resolve => server.close(resolve)); }
const remote = await connect(address, port);
console.log(JSON.stringify({ pid: process.pid, utc: new Date().toISOString(), address, port, connected: remote.connected, error: remote.error, loopback: loopback.connected }));
