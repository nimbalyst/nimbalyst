import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: mocks.spawn,
  };
});

import {
  checkMcpRemoteAuthStatus,
  getMcpRemoteOAuthTimeoutMs,
  triggerMcpRemoteOAuth,
} from '../MCPRemoteOAuth';

class FakeOAuthChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  stdin = new PassThrough();
  killed = false;

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

// Only stdio commands the user wrote themselves (`npx mcp-remote <url>`) still
// run mcp-remote; every other remote server uses Nimbalyst's own OAuth client
// (covered in services/mcpOAuth/__tests__).
const USER_COMMAND = {
  type: 'stdio' as const,
  command: 'npx',
  // `--ignore-tool` is not reproduced by the gateway, so this stays on mcp-remote.
  args: ['mcp-remote', 'https://mcp.example.test', '--ignore-tool', 'delete_*'],
};

describe('triggerMcpRemoteOAuth for a user-written mcp-remote command', () => {
  let authDir: string;
  let child: FakeOAuthChild;

  beforeEach(async () => {
    authDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-oauth-trigger-'));
    process.env.MCP_REMOTE_CONFIG_DIR = authDir;
    child = new FakeOAuthChild();
    mocks.spawn.mockReturnValue(child);
  });

  afterEach(async () => {
    vi.useRealTimers();
    mocks.spawn.mockReset();
    delete process.env.MCP_REMOTE_CONFIG_DIR;
    await fs.rm(authDir, { recursive: true, force: true });
  });

  it('reports an abandoned browser flow as timed out instead of rejected', async () => {
    vi.useFakeTimers();
    const resultPromise = triggerMcpRemoteOAuth(USER_COMMAND);
    child.stderr.write('Authentication required. Waiting for authorization...');

    // The default flow deadline is generous so real consent + MFA flows are not
    // cut short; the child must not be killed before it elapses.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(child.killed).toBe(false);

    await vi.advanceTimersByTimeAsync(getMcpRemoteOAuthTimeoutMs({}));

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      outcome: 'timed_out',
      errorType: 'timeout',
    });
    expect(child.killed).toBe(true);
  });

  it('uses the token cache as the authoritative success signal', async () => {
    vi.useFakeTimers();
    const serverUrl = 'https://mcp.example.test';
    const resultPromise = triggerMcpRemoteOAuth(USER_COMMAND);
    const versionDir = path.join(authDir, 'mcp-remote-test');
    const serverHash = crypto.createHash('md5').update(serverUrl).digest('hex');
    await fs.mkdir(versionDir, { recursive: true });
    await fs.writeFile(
      path.join(versionDir, `${serverHash}_tokens.json`),
      JSON.stringify({ access_token: 'test-token' }),
      'utf8'
    );
    await expect(checkMcpRemoteAuthStatus(USER_COMMAND)).resolves.toMatchObject({
      authorized: true,
    });
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(resultPromise).resolves.toEqual({
      success: true,
      outcome: 'authorized',
    });
    expect(child.killed).toBe(true);
  });

  it('does not treat a zero exit code without tokens as authorization success', async () => {
    const resultPromise = triggerMcpRemoteOAuth(USER_COMMAND);

    child.emit('close', 0);

    await expect(resultPromise).resolves.toMatchObject({
      success: false,
      outcome: 'failed',
      errorType: 'process_exit',
    });
  });

  it('returns only a bounded provider-rejection category and safe message', async () => {
    const resultPromise = triggerMcpRemoteOAuth(USER_COMMAND);
    child.stderr.write(
      'access_denied https://provider.example/callback?code=secret /Users/name/auth.json'
    );

    child.emit('close', 1);
    const result = await resultPromise;

    expect(result).toEqual({
      success: false,
      outcome: 'rejected',
      errorType: 'provider_rejected',
      error: 'The provider did not approve authorization.',
    });
    expect(JSON.stringify(result)).not.toContain('provider.example');
    expect(JSON.stringify(result)).not.toContain('/Users/');
    expect(JSON.stringify(result)).not.toContain('secret');
  });
});
