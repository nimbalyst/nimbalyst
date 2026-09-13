/** Linux image acceptance only; no desktop E2E, host mounts, published ports or credentials. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const image = process.argv[2];
assert.ok(image && !image.startsWith('-'), 'pass a local image name or digest');
const name = `nimbalyst-image-smoke-${randomUUID()}`;
const fixture = mkdtempSync(join(tmpdir(), 'nimbalyst-runtime-ca-'));
const imageConfig = JSON.parse(readFileSync(new URL('../image.config.json', import.meta.url), 'utf8'));
const probe = await build({
  entryPoints: [fileURLToPath(new URL('./preview-control-probe.mjs', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', target: 'node24', write: false,
});
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024 });
try {
  // Deliberately WITHOUT --cap-drop=ALL and --security-opt=no-new-privileges.
  // Cloudflare does not apply those to our container, so a harness that sets
  // them is not measuring the image -- it is measuring the harness. They
  // previously hid a launcher that never set no_new_privs on the path the image
  // actually takes. --network=none stays: that one the image genuinely relies
  // on, and the checks below need no egress.
  // Cloudflare injects a CA before startup. Exercise that production path:
  // the rootless runtime used to exit while appending to the system bundle.
  mkdirSync(join(fixture, 'cloudflare/certs'), { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(fixture, 'key.pem'), '-out', join(fixture, 'cloudflare/certs/cloudflare-containers-ca.crt'), '-days', '1', '-subj', '/CN=runtime-fixture'], { stdio: 'pipe' });
  docker('create', '--pull=never', '--platform=linux/amd64', '--name', name, '--network=none', '--env', 'SANDBOX_INTERCEPT_HTTPS=1', image);
  docker('cp', join(fixture, 'cloudflare'), name + ':/etc/cloudflare');
  docker('start', name);
  // The preview inherits tini as PID 1; verify both init and the actual server.
  const status = docker('exec', name, 'cat', '/proc/1/status');
  assert.equal(status.match(/^Uid:\s+(.+)$/m)?.[1].trim().split(/\s+/).join(','), '10001,10001,10001,10001', 'the control service must run as uid 10001');
  const apiSmoke = execFileSync('docker', ['exec', '-i', name, '/opt/nimbalyst/node/bin/node', '--input-type=module', '-', imageConfig.sandbox.sdkVersion], {
    encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, input: probe.outputFiles[0].text,
  });
  process.stdout.write(apiSmoke);
  const trust = JSON.parse(docker('exec', name, '/opt/nimbalyst/node/bin/node', '-e', `
    const fs = require('node:fs');
    const file = fs.statSync('/etc/ssl/certs/ca-certificates.crt');
    let writableDirectory = false;
    try { fs.accessSync('/etc/ssl/certs', fs.constants.W_OK); writableDirectory = true; } catch {}
    console.log(JSON.stringify({uid:file.uid,gid:file.gid,mode:file.mode & 511,writableDirectory}));
  `));
  assert.deepEqual(trust, { uid: 0, gid: 10001, mode: 0o664, writableDirectory: false }, 'only the root-owned CA bundle should grant runtime-group write access');
  const serverUid = docker('exec', name, '/opt/nimbalyst/node/bin/node', '--input-type=module', '-e', `
    import fs from 'node:fs';
    for (const pid of fs.readdirSync('/proc').filter(name => /^\\d+$/.test(name))) {
      try {
        const command = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0')[0];
        if (command !== '/container-server/sandbox') continue;
        console.log(fs.readFileSync('/proc/' + pid + '/status', 'utf8').match(/^Uid:\\s+(.+)$/m)[1].trim().split(/\\s+/).join(','));
      } catch {}
    }
  `).trim();
  assert.equal(serverUid, '10001,10001,10001,10001', 'the preview server child must run as uid 10001');
  const smoke = docker('exec', '--env', 'NIMBALYST_SMOKE_ENV_SENTINEL=synthetic-marker', name, '/opt/nimbalyst/bin/nimbalyst-node', '--smoke');
  assert.ok(smoke.includes('[smoke] all checks passed'), smoke);
  // The runner reads its own /proc/self/status; this asserts the line it
  // reported, so a smoke build that silently lost the check cannot pass here.
  assert.match(smoke, /\[smoke\] ok\s+no new privs -- NoNewPrivs 1/, 'the runner must run with no_new_privs set');
  process.stdout.write(smoke);

  // No setuid/setgid binary anywhere on the image's own filesystem. With
  // no_new_privs the runner cannot use one, but the control server and any
  // shell the agent spawns are not covered by that, so the bits are stripped at
  // build time and re-counted here against the real image.
  const suid = docker('exec', name, 'sh', '-c', 'find / -xdev -perm /6000 -type f 2>/dev/null | wc -l').trim();
  assert.equal(suid, '0', `expected no setuid/setgid files in the image, found ${suid}`);
  process.stdout.write(`[image] setuid/setgid files: ${suid}\n`);
  process.stdout.write('[image] control service uid 10001; rootless HTTPS interception startup and runner smoke passed\n');
} catch (error) {
  // Synthetic fixture only: expose startup failures before cleanup removes the
  // evidence (notably a runtime that exits while installing its CA).
  try { process.stderr.write(docker('logs', name)); } catch {}
  throw error;
} finally {
  // Unconditional. Tracking "did docker run return" left a container behind
  // whenever the run succeeded but the client call reporting it did not -- a
  // timeout, a broken pipe -- which is exactly when a leaked container is least
  // expected. The name is a fresh uuid, so removing one that was never created
  // is a no-op, and its "No such container" is the only error swallowed here.
  try {
    docker('rm', '--force', name);
  } catch (error) {
    if (!/No such container/i.test(String(error.stderr ?? error.message ?? ''))) throw error;
  }
  rmSync(fixture, { recursive: true, force: true });
}
