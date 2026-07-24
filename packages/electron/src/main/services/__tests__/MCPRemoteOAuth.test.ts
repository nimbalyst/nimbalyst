import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  buildMcpRemoteArgs,
  checkMcpRemoteAuthStatus,
  discoverMcpRemoteOAuthRequirement,
  extractMcpRemoteConfig,
} from '../MCPRemoteOAuth';

describe('MCPRemoteOAuth', () => {
  const originalConfigDir = process.env.MCP_REMOTE_CONFIG_DIR;

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.MCP_REMOTE_CONFIG_DIR;
    } else {
      process.env.MCP_REMOTE_CONFIG_DIR = originalConfigDir;
    }
    vi.unstubAllGlobals();
  });

  it('detects Slack-style remote HTTP configs with explicit OAuth metadata', () => {
    const descriptor = extractMcpRemoteConfig({
      type: 'http',
      url: 'https://mcp.slack.com/mcp',
      oauth: {
        callbackPort: 3118,
        staticClientInfo: {
          client_id: 'client-123',
        },
      },
    });

    expect(descriptor).toEqual(expect.objectContaining({
      serverUrl: 'https://mcp.slack.com/mcp',
      callbackPort: 3118,
      requiresOAuth: true,
      staticOAuthClientInfo: {
        client_id: 'client-123',
      },
    }));
  });

  it('does not route native remote OAuth configs through mcp-remote', () => {
    const descriptor = extractMcpRemoteConfig({
      type: 'http',
      url: 'https://mcp.slack.com/mcp',
      oauth: {
        callbackPort: 3118,
        clientId: 'client-123',
      },
    });

    expect(descriptor).toBeNull();
  });

  it('can check native remote OAuth configs as mcp-remote for Codex', () => {
    const descriptor = extractMcpRemoteConfig({
      type: 'http',
      url: 'https://mcp.slack.com/mcp',
      oauth: {
        callbackPort: 3118,
        clientId: 'client-123',
        clientSecret: 'secret-456',
      },
    }, { useMcpRemoteForNativeOAuth: true });

    expect(descriptor).toEqual(expect.objectContaining({
      serverUrl: 'https://mcp.slack.com/mcp',
      callbackPort: 3118,
      requiresOAuth: true,
      staticOAuthClientInfo: {
        client_id: 'client-123',
        client_secret: 'secret-456',
      },
    }));
  });

  it('does not mark bearer-token HTTP servers as OAuth', () => {
    const descriptor = extractMcpRemoteConfig({
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: {
        Authorization: 'Bearer ${GITHUB_TOKEN}',
      },
    });

    expect(descriptor?.requiresOAuth).toBe(false);
  });

  it('does not probe bearer-token HTTP servers for OAuth', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const descriptor = extractMcpRemoteConfig({
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      headers: {
        authorization: 'Bearer ${GITHUB_TOKEN}',
      },
    });

    await expect(discoverMcpRemoteOAuthRequirement(descriptor!)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('discovers OAuth remotes from protected-resource metadata', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = url.toString();
      if (requestUrl === 'https://mcp.customer.io/.well-known/oauth-protected-resource/mcp') {
        return new Response(JSON.stringify({
          resource: 'https://mcp.customer.io/mcp',
          authorization_servers: ['https://auth.customer.io'],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const descriptor = extractMcpRemoteConfig({
      type: 'http',
      url: 'https://mcp.customer.io/mcp',
    });

    expect(descriptor?.requiresOAuth).toBe(false);
    await expect(discoverMcpRemoteOAuthRequirement(descriptor!)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.customer.io/.well-known/oauth-protected-resource/mcp',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('discovers OAuth remotes from bearer auth challenges', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = url.toString();
      if (requestUrl === 'https://mcp.challenge.example/mcp') {
        return new Response('auth required', {
          status: 401,
          headers: { 'www-authenticate': 'Bearer resource_metadata="https://mcp.challenge.example/.well-known/oauth-protected-resource/mcp"' },
        });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const descriptor = extractMcpRemoteConfig({
      type: 'http',
      url: 'https://mcp.challenge.example/mcp',
    });

    await expect(discoverMcpRemoteOAuthRequirement(descriptor!)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://mcp.challenge.example/mcp',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('retries discovery after a negative OAuth probe', async () => {
    let firstProbe = true;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const requestUrl = url.toString();
      if (requestUrl !== 'https://mcp.retry.example/.well-known/oauth-protected-resource/mcp' || firstProbe) {
        return new Response('not found', { status: 404 });
      }
      return new Response(JSON.stringify({
        resource: 'https://mcp.retry.example/mcp',
        authorization_servers: ['https://auth.retry.example'],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const descriptor = extractMcpRemoteConfig({
      type: 'http',
      url: 'https://mcp.retry.example/mcp',
    });

    await expect(discoverMcpRemoteOAuthRequirement(descriptor!)).resolves.toBe(false);
    firstProbe = false;
    await expect(discoverMcpRemoteOAuthRequirement(descriptor!)).resolves.toBe(true);
  });

  it('builds mcp-remote args with static client info and callback port', () => {
    const descriptor = extractMcpRemoteConfig({
      type: 'http',
      url: 'https://mcp.slack.com/mcp',
      oauth: {
        callbackPort: 3118,
        staticClientInfo: {
          client_id: 'client-123',
        },
      },
    });

    expect(descriptor).toBeTruthy();
    expect(buildMcpRemoteArgs(descriptor!)).toEqual([
      'mcp-remote',
      'https://mcp.slack.com/mcp',
      '3118',
      '--static-oauth-client-info',
      JSON.stringify({ client_id: 'client-123' }),
    ]);
  });

  it('matches mcp-remote token hashes using URL, resource, and headers', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-remote-auth-'));
    process.env.MCP_REMOTE_CONFIG_DIR = tempDir;

    const versionDir = path.join(tempDir, 'mcp-remote-0.1.0');
    await fs.mkdir(versionDir, { recursive: true });

    const serverUrl = 'https://example.com/mcp';
    const resource = 'https://example.com/resource';
    const headers = { Authorization: 'Bearer custom-token' };
    const sortedKeys = Object.keys(headers).sort();
    const hash = crypto
      .createHash('md5')
      .update([serverUrl, resource, JSON.stringify(headers, sortedKeys)].join('|'))
      .digest('hex');

    await fs.writeFile(
      path.join(versionDir, `${hash}_tokens.json`),
      JSON.stringify({ access_token: 'token-value' }),
      'utf8',
    );

    const status = await checkMcpRemoteAuthStatus({
      type: 'http',
      url: serverUrl,
      headers,
      oauth: {
        resource,
      },
    });

    expect(status.authorized).toBe(true);
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
