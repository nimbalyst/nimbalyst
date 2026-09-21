/** Run with: fnm exec --using=24 npx tsx scripts/manual-tests/codex-permissions-contract.ts */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildCodexThreadStartParams } from '../../packages/runtime/src/ai/server/protocols/codexAppServer/threadConfiguration';
import { JsonRpcClient } from '../../packages/runtime/src/ai/server/protocols/codexAppServer/jsonRpcClient';
import { resolveCodexBinaryPath } from '../../packages/runtime/src/ai/server/protocols/codexAppServer/codexAppServerBinary';
import type { ThreadStartResponse } from '../../packages/runtime/src/ai/server/protocols/codexAppServer/types';

async function main() {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'codex-permissions-'));
  const cwd = path.join(fixture, 'workspace');
  const extra = path.join(fixture, 'extra');
  const codexHome = path.join(fixture, 'codex-home');
  await Promise.all([cwd, extra, codexHome].map(p => mkdir(p)));
  // Isolated configuration, no model turn or account credentials involved.
  const child = spawn(resolveCodexBinaryPath(() => undefined), ['app-server', '--listen', 'stdio://'], {
    env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['pipe', 'pipe', 'pipe'], cwd,
  });
  child.stderr.resume();
  const client = new JsonRpcClient(child, { defaultTimeoutMs: 15_000 });
  try {
    await client.request('initialize', { clientInfo: { name: 'nimbalyst-permissions-contract', version: '1' } });
    client.notify('initialized', {});
    const params = buildCodexThreadStartParams({ workspacePath: cwd, raw: { additionalDirectories: [extra, extra] } });
    const result = await client.request<ThreadStartResponse>('thread/start', { ...params, ephemeral: true });
    const sandbox = result.sandbox as { type: string; writableRoots: string[] };
    assert.equal(sandbox.type, 'workspaceWrite');
    assert.deepEqual(sandbox.writableRoots.map(p => path.resolve(p)), [path.resolve(extra)]);
    console.log('PASS: real Codex thread/start preserves the host-authorized writable root. No model turn executed.');
  } finally {
    client.close();
    const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
    child.kill();
    await exited;
    await rm(fixture, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
