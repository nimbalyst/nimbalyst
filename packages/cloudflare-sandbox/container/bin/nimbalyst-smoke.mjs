/**
 * Prove the image actually contains a working runner, at build time.
 *
 * Run as `nimbalyst-node --smoke`. It lives inside /opt/nimbalyst/app -- the
 * directory that owns the hoisted node_modules -- so every bare specifier below
 * resolves exactly the way the real runner's do. Resolving them from somewhere
 * else would test a different module graph than the one that ships.
 *
 * Each check corresponds to a way this image has a plausible reason to be
 * wrong-but-plausible-looking:
 *
 *   node major      - the base image ships its own older node; ours must win.
 *   non-root        - Claude Code refuses permission bypass as uid 0, and a
 *                     headless turn cannot answer a permission prompt.
 *   deep exports    - the runtime's `node` condition points at dist-node/, which
 *                     the default (browser, chunked) build never emits.
 *   native sqlite   - a prebuild built for the wrong libc loads on the build
 *                     host and nowhere else.
 *   claude binary   - the SDK's platform binary is an optionalDependency; on a
 *                     wrong-platform install it is simply absent.
 *   migrations      - the SQL files must be present AND apply, not just exist.
 *
 * It touches nothing outside a temporary directory and reads no credentials.
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveMigrations, resolveSchemaDir, runMigrations } from './packages/node/dist/db/migrations.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const MIN_NODE_MAJOR = 24;

const failures = [];

/**
 * Run one check, attributing any failure to its name and continuing.
 *
 * Async because one check is a set of dynamic imports; awaiting inside the
 * try/catch is what keeps a rejected import a reported failure rather than an
 * unhandled rejection that kills the process with no attribution.
 */
async function check(name, fn) {
  try {
    const detail = await fn();
    process.stdout.write(`[smoke] ok    ${name}${detail ? ` -- ${detail}` : ''}\n`);
  } catch (error) {
    failures.push(name);
    process.stdout.write(`[smoke] FAIL  ${name}: ${error instanceof Error ? error.message : error}\n`);
  }
}

await check('node major', () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new Error(`node ${process.versions.node} is older than the required ${MIN_NODE_MAJOR}`);
  }
  return `v${process.versions.node}`;
});

await check('runs unprivileged', () => {
  const uid = process.getuid?.();
  if (uid === 0) throw new Error('running as root; Claude Code will refuse permission bypass');
  return `uid ${uid}`;
});

await check('no new privs', () => {
  // Asserted from the runner's OWN /proc/self/status, because that is the
  // process whose privileges matter -- checking the launcher, or the container
  // as a whole, would not prove the flag survived to here.
  //
  // This exists because the launcher only applied it on the root branch, which
  // the image never takes: USER 10001 means the runner starts unprivileged, and
  // an acceptance harness that passed --security-opt=no-new-privileges to
  // `docker run` made the gap invisible. Cloudflare does not pass that flag.
  const status = readFileSync('/proc/self/status', 'utf8');
  const noNewPrivs = /^NoNewPrivs:\s*(\d+)$/m.exec(status)?.[1];
  if (noNewPrivs !== '1') {
    throw new Error(
      `NoNewPrivs is ${noNewPrivs ?? 'absent'}; a setuid binary could still raise privilege `
      + 'from this process. The launcher must exec through `setpriv --no-new-privs`.',
    );
  }
  // Reported, not asserted: emptying the bounding set needs CAP_SETPCAP, which
  // uid 10001 lacks. The setuid/setgid strip in the Dockerfile is what makes a
  // non-empty bounding set here unexploitable.
  const bounding = /^CapBnd:\s*(\S+)$/m.exec(status)?.[1];
  return `NoNewPrivs 1 (CapBnd ${bounding}, not droppable unprivileged)`;
});

await check('launcher environment', () => {
  if (process.env.NIMBALYST_SMOKE_ENV_SENTINEL !== undefined) {
    throw new Error('the launcher inherited its caller environment');
  }
  if (process.env.HOME !== '/home/nimbalyst') throw new Error('unexpected runner HOME');
  return 'explicit runner environment';
});

await check('runtime node exports', async () => {
  // Static specifiers so a missing dist-node/ file is a hard resolution error.
  await import('@nimbalyst/runtime/ai/server/SessionManager');
  await import('@nimbalyst/runtime/ai/adapters/sessionStore');
  await import('@nimbalyst/runtime/ai/server/providers/ClaudeCodeProvider');
  await import('@nimbalyst/runtime/ai/server/types');
  return 'SessionManager, sessionStore, ClaudeCodeProvider, types';
});

await check('native sqlite', () => {
  const db = new Database(':memory:');
  try {
    const answer = db.prepare('select 1 as ok').get();
    if (answer?.ok !== 1) throw new Error('better-sqlite3 returned an unexpected row');
    return `better-sqlite3 on sqlite ${db.prepare('select sqlite_version() as v').get().v}`;
  } finally {
    db.close();
  }
});

await check('claude code binary', () => {
  const dir = path.join(APP_DIR, 'node_modules/@anthropic-ai/claude-agent-sdk-linux-x64');
  if (!existsSync(dir)) {
    throw new Error(
      'the linux-x64 Claude Code binary package is absent. The SDK ships it as an '
      + 'optionalDependency, so this means the install ran for another platform.',
    );
  }
  return dir;
});

await check('migrations apply', () => {
  const schemaDir = resolveSchemaDir();
  const derived = deriveMigrations(schemaDir);
  const sqlFiles = readdirSync(schemaDir).filter((f) => f.endsWith('.sql'));
  if (derived.length !== sqlFiles.length) {
    throw new Error(`derived ${derived.length} migrations from ${sqlFiles.length} .sql files`);
  }
  if (derived.length === 0) throw new Error(`no migrations found in ${schemaDir}`);

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nimbalyst-smoke-'));
  try {
    const db = new Database(path.join(tmp, 'smoke.sqlite'));
    const result = runMigrations(db, schemaDir);
    if (result.applied.length !== derived.length) {
      throw new Error(`applied ${result.applied.length} of ${derived.length} migrations`);
    }
    const row = db
      .prepare("select name from sqlite_master where type = 'table' and name = 'ai_agent_messages'")
      .get();
    if (!row) throw new Error('ai_agent_messages is missing after migration');
    db.close();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return `${derived.length} migrations from ${schemaDir}`;
});

await check('cli responds', () => {
  const cli = path.join(APP_DIR, 'packages/node/dist/bin/nimbalyst-node.js');
  const out = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  if (!out.includes('--workspace')) throw new Error('--help did not print the usage banner');
  return 'nimbalyst-node --help';
});

if (failures.length > 0) {
  process.stderr.write(`[smoke] ${failures.length} check(s) failed: ${failures.join(', ')}\n`);
  process.exit(1);
}
process.stdout.write('[smoke] all checks passed\n');
