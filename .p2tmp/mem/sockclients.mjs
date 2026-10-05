// Child-process WebSocket clients for sockets.mjs. Usage: node sockclients.mjs <port> <N> [solo]
// Every client says hello; even-indexed ones create a room, odd ones join the previous room (2 humans per room).
// Prints "ready <conns> <rooms>" to stdout once all connections are in.
import { WebSocket } from 'ws';

const port = Number(process.argv[2]);
const N = Number(process.argv[3]) || 10;
const solo = process.argv[4] === 'solo';
const url = `ws://127.0.0.1:${port}/ws`;

const codes = [];
const conns = [];
let opened = 0;

const msg = (ws, m) => ws.send(JSON.stringify(m));

await new Promise((resolve) => {
  for (let i = 0; i < N; i++) {
    const ws = new WebSocket(url);
    ws.on('error', (e) => console.error('client error', e.message));
    conns.push(ws);
    ws.on('open', () => {
      msg(ws, { t: 'hello', name: `probe${i}`, version: 1 });
    });
    ws.on('message', (data) => {
      let m;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m.t === 'welcome') {
        opened++;
        if (solo || i % 2 === 0) msg(ws, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
        else {
          const tryJoin = () => {
            if (codes.length) msg(ws, { t: 'room.join', code: codes[codes.length - 1] });
            else setTimeout(tryJoin, 50);
          };
          tryJoin();
        }
        if (solo && opened === N) resolve();
        if (!solo && opened === N) setTimeout(resolve, 400);
      } else if (m.t === 'room.state' && typeof m.code === 'string' && !codes.includes(m.code)) {
        codes.push(m.code);
      }
    });
  }
});

const rooms = solo ? N : Math.ceil(N / 2);
console.log(`ready ${N} conns ${rooms} rooms (room codes seen: ${codes.length})`);
// stay connected: the parent measures this process's absence, not its exit
setInterval(() => { for (const ws of conns) if (ws.readyState === 1) msg(ws, { t: 'ping', c: Date.now() }); }, 5000);
