// test/fixtures/background-echo.mjs — a stand-in background worker for BackgroundClient tests.
// `{ id, payload }` in, `{ id, value }` (or `{ id, error }`) out, exactly like the real encoders.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, payload }) => {
  if (payload && payload.boom) { parentPort.postMessage({ id, error: 'boom' }); return; }
  if (payload && payload.exit) { process.exit(3); }
  parentPort.postMessage({ id, value: { echoed: payload, pid: process.pid } });
});