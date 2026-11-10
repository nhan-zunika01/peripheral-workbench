import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';

export class FakeChild extends EventEmitter {
  constructor(pid = 50001) {
    super(); this.pid = pid; this.exitCode = null; this.signalCode = null; this.frames = [];
    this.stdin = new Writable({ write: (bytes, _, done) => { this.frames.push(bytes.toString()); done(); } });
  }
  exit(code = 0, signal = null) { this.exitCode = code; this.signalCode = signal; this.emit('exit', code, signal); this.emit('close', code, signal); }
  kill() { this.exit(null, 'SIGTERM'); return true; }
}
