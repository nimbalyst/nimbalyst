// Local-only encrypted WebSocket fixture for native transport and Files UI tests.
const http = require('node:http');
const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const key = crypto.pbkdf2Sync('test-seed', 'nimbalyst:test-user', 100_000, 32, 'sha256');
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  return [Buffer.concat([cipher.update(text), cipher.final(), cipher.getAuthTag()]).toString('base64'), iv.toString('base64')];
}
const [encryptedContent, contentIv] = encrypt('# Downloaded document\n' + 'a'.repeat(13_000));
const files = Array.from({ length: 2293 }, (_, i) => {
  const name = `Document ${String(i).padStart(4, '0')}`;
  const [encryptedPath, pathIv] = encrypt(`${name}.md`);
  const [encryptedTitle, titleIv] = encrypt(name);
  return { syncId: `file-${i}`, encryptedContent, contentIv, encryptedPath, pathIv, encryptedTitle, titleIv, contentHash: 'hash', lastModifiedAt: 1, hasYjs: false };
});
const requests = [];
let interrupt = process.argv.includes('--interrupt');
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ requests }));
});
const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  ws.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.type !== 'projectSyncRequest') return;
    requests.push({ token: new URL(req.url, 'http://localhost').searchParams.get('token'), count: message.files.length });
    const cached = new Set(message.files.map(f => f.syncId));
    const missing = files.filter(f => !cached.has(f.syncId));
    const transferId = crypto.randomUUID();
    const batches = Math.max(1, Math.ceil(missing.length / 50));
    let index = 0;
    const send = () => {
      if (ws.readyState !== 1) return;
      ws.send(JSON.stringify({ type: 'projectSyncResponse', transferId, batchIndex: index, isLastBatch: index === batches - 1, updatedFiles: [], newFiles: missing.slice(index * 50, (index + 1) * 50), yjsUpdates: [], needFromClient: [], deletedSyncIds: [] }));
      if (interrupt) { interrupt = false; ws.close(1012, 'fixture interruption'); return; }
      if (++index < batches) setTimeout(send, 10);
    };
    setTimeout(send, 1000);
  });
});
server.listen(Number(process.env.NIMBALYST_FIXTURE_PORT || 0), '127.0.0.1', () => console.log(server.address().port));
