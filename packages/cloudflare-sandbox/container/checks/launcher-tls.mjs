/** Isolated Linux acceptance: real launcher, synthetic CA, HTTPS/WSS/Git, no egress or credentials. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const image = process.argv[2];
assert.ok(image && !image.startsWith('-'), 'pass a local image name or digest');
const name = `nimbalyst-launcher-tls-${randomUUID()}`;
const fixture = mkdtempSync(join(tmpdir(), 'nimbalyst-launcher-tls-'));
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
try {
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(fixture, 'key.pem'), '-out', join(fixture, 'ca.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'pipe' });
  writeFileSync(join(fixture, 'client.mjs'), `
    import assert from 'node:assert/strict';
    import { execFileSync } from 'node:child_process';
    assert.equal(process.env.NIMBALYST_SMOKE_ENV_SENTINEL, undefined);
    assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
    const url = process.argv[2];
    assert.equal(await (await fetch(url)).text(), 'tls-ok');
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(url.replace('https:', 'wss:'));
      ws.onopen = () => { ws.close(); resolve(); };
      ws.onerror = () => reject(new Error('WSS handshake failed'));
    });
    assert.equal(execFileSync('curl', ['--fail', '--silent', '--show-error', url], { encoding: 'utf8' }), 'tls-ok');
    execFileSync('git', ['-c', 'http.sslVerify=true', 'ls-remote', url + 'repo'], { stdio: 'pipe' });
    await assert.rejects(fetch(url.replace('localhost', '127.0.0.1')), 'hostname verification must remain enabled');
    console.log('[launcher-tls] HTTPS, WSS, curl and Git passed; hostname verification and environment isolation preserved');
  `);
  writeFileSync(join(fixture, 'server.mjs'), `
    import { createServer } from 'node:https';
    import { createHash } from 'node:crypto';
    import { readFileSync } from 'node:fs';
    import { spawn } from 'node:child_process';
    const server = createServer({ key: readFileSync('/tmp/tls-fixture/key.pem'), cert: readFileSync('/tmp/tls-fixture/ca.pem') }, (req, res) => {
      if (req.url.startsWith('/repo/')) {
        res.end(req.url.startsWith('/repo/HEAD') ? 'ref: refs/heads/main\\n' : '');
      } else res.end('tls-ok');
    });
    server.on('upgrade', (req, socket) => {
      const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
      socket.on('data', () => socket.end());
    });
    await new Promise(resolve => server.listen(0, '0.0.0.0', resolve));
    const child = spawn('/opt/nimbalyst/bin/nimbalyst-node', ['--smoke', 'https://localhost:' + server.address().port + '/'], {
      env: { ...process.env, NIMBALYST_SMOKE_ENV_SENTINEL: 'fixture', NODE_EXTRA_CA_CERTS: '/does-not-exist', NODE_TLS_REJECT_UNAUTHORIZED: '0' }, stdio: 'inherit',
    });
    const code = await new Promise(resolve => child.on('exit', resolve));
    server.closeAllConnections(); server.close(); process.exit(code ?? 1);
  `);
  docker('run', '--pull=never', '--platform=linux/amd64', '--detach', '--name', name, '--network=none', '--entrypoint', '/usr/bin/sleep', image, '300');
  docker('exec', '--user', '0', name, 'mkdir', '-p', '/etc/cloudflare/certs', '/tmp/tls-fixture');
  docker('cp', fixture + '/.', name + ':/tmp/tls-fixture');
  docker('cp', join(fixture, 'ca.pem'), name + ':/etc/cloudflare/certs/cloudflare-containers-ca.crt');
  docker('cp', join(fixture, 'client.mjs'), name + ':/opt/nimbalyst/app/nimbalyst-smoke.mjs');
  // Opt in while iterating red-to-green without a full image rebuild. Final
  // acceptance leaves the image's shipped launcher untouched.
  if (process.argv.includes('--working-tree')) {
    const launcher = new URL('../bin/nimbalyst-node', import.meta.url);
    writeFileSync(join(fixture, 'launcher'), readFileSync(launcher), { mode: 0o755 });
    docker('cp', join(fixture, 'launcher'), name + ':/opt/nimbalyst/bin/nimbalyst-node');
  }
  docker('exec', '--user', '0', name, 'chmod', '-R', 'a+rX', '/tmp/tls-fixture');
  process.stdout.write(docker('exec', name, '/opt/nimbalyst/node/bin/node', '/tmp/tls-fixture/server.mjs'));
} finally {
  try { docker('rm', '--force', name); } catch (error) {
    if (!/No such container/i.test(String(error.stderr ?? error.message))) throw error;
  }
  rmSync(fixture, { recursive: true, force: true });
}
