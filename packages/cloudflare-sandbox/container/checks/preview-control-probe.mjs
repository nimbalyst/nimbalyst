// Bundled on the host and piped to Node inside the image by runtime-smoke.mjs.
// Uses the pinned preview runtime's /rpc bootstrap and processes API, also used
// by the SDK's ContainerControlConnection and Sandbox.exec implementation.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { newWebSocketRpcSession } from 'capnweb';

const watchdog = setTimeout(() => { console.error('Preview control smoke timed out'); process.exit(1); }, 45_000);
let socket;
try {
  let rpc;
  let metadata;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      socket = new WebSocket('ws://127.0.0.1:3000/rpc');
      rpc = newWebSocketRpcSession(socket);
      metadata = await rpc.utils.getRuntimeMetadata();
      break;
    } catch {
      socket?.close();
      await delay(500);
    }
  }
  assert.ok(metadata, 'preview control server must become ready without root');
  assert.equal(metadata.sandboxVersion, process.argv[2]);
  assert.equal(metadata.controlProtocolVersion, 1);
  await rpc.utils.activateControlSession(metadata.runtimeIncarnationID);
  const launched = await rpc.processes.start(['/usr/local/bin/nimbalyst-node', '--smoke'], { timeout: 30_000 });
  let status = launched;
  while (status.state === 'running') {
    await delay(100);
    status = await rpc.processes.get(launched.id);
    assert.ok(status, 'readiness process disappeared');
  }
  assert.equal(status.state, 'exited');
  assert.equal(status.exit.code, 0);
  assert.equal(status.exit.timedOut, false);
  console.log('[image] Preview RPC argv readiness command passed');
} finally {
  socket?.close();
  clearTimeout(watchdog);
}
