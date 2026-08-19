// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { JsonRpcClient } from '../jsonRpcClient';

/**
 * A child that fails to spawn emits 'error' + 'close' and never 'exit'. The
 * client used to subscribe to 'exit' alone, so a session pointed at a deleted
 * workspace folder sat on its pending `initialize` for the full five-minute
 * default timeout instead of failing immediately.
 */
describe('JsonRpcClient spawn failure', () => {
  it('rejects pending requests when the child never starts', async () => {
    // A missing cwd is the real-world trigger: Node fails the chdir and reports
    // it as ENOENT against the command, even though the command exists.
    const child = spawn(process.execPath, ['-e', ''], {
      cwd: '/nimbalyst-nonexistent-workspace-for-test',
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    const client = new JsonRpcClient(child, { defaultTimeoutMs: 30_000 });

    await expect(client.request('initialize', {})).rejects.toThrow(/failed to start/);
  });
});
