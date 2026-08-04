/**
 * Pull path for the in-session MCP status surface (NIM-2272 / GH #1089).
 *
 * The distinction these tests defend: "this provider can't report MCP status"
 * and "this session hasn't started yet" and "this session has no MCP servers"
 * are three different answers. Collapsing them into an empty list is what the
 * GH issue is complaining about in the first place.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const getProvider = vi.fn();

vi.mock('@nimbalyst/runtime/ai/server', () => ({
  ProviderFactory: {
    getProvider: (...args: unknown[]) => getProvider(...args),
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: vi.fn(),
}));

import { getMcpSessionStatusSnapshot } from '../McpSessionStatusHandlers';

const POLLED_AT = 1_700_000_000_000;

function providerWith(status: {
  servers: any[];
  configuredNames: string[] | null;
  lastCheckedAt: number | null;
}) {
  return { getMcpSessionStatus: () => status };
}

describe('getMcpSessionStatusSnapshot', () => {
  beforeEach(() => {
    getProvider.mockReset();
  });

  it('returns the live provider status for a claude-code session', () => {
    getProvider.mockReturnValue(
      providerWith({
        servers: [
          { name: 'trackers', status: 'connected', scope: 'local', tools: [{}, {}] },
          { name: 'atlassian', status: 'needs-auth', scope: 'user' },
        ],
        configuredNames: ['trackers', 'atlassian', 'google-drive'],
        lastCheckedAt: POLLED_AT,
      }),
    );

    const snapshot = getMcpSessionStatusSnapshot('s1', 'claude-code');

    expect(snapshot.supported).toBe(true);
    expect(snapshot.active).toBe(true);
    expect(snapshot.lastCheckedAt).toBe(POLLED_AT);
    expect(snapshot.servers).toEqual([
      { name: 'trackers', state: 'connected', scope: 'local', toolCount: 2 },
      { name: 'atlassian', state: 'needs-auth', scope: 'user' },
      { name: 'google-drive', state: 'absent' },
    ]);
  });

  it('reports supported-but-inactive when the session has no live provider', () => {
    getProvider.mockReturnValue(null);

    const snapshot = getMcpSessionStatusSnapshot('s1', 'claude-code');

    expect(snapshot).toEqual({
      sessionId: 's1',
      supported: true,
      active: false,
      servers: [],
      lastCheckedAt: null,
    });
  });

  it('reports unsupported for a provider with no MCP status channel', () => {
    const snapshot = getMcpSessionStatusSnapshot('s1', 'openai-codex');

    expect(snapshot.supported).toBe(false);
    expect(snapshot.active).toBe(false);
    // Never asks the factory: an unsupported provider is decided by type.
    expect(getProvider).not.toHaveBeenCalled();
  });

  it('reports supported-but-inactive when the cached provider lacks the accessor', () => {
    // A stale provider instance from before this feature shipped, or a
    // differently-shaped one — degrade, do not throw.
    getProvider.mockReturnValue({});

    const snapshot = getMcpSessionStatusSnapshot('s1', 'claude-code');

    expect(snapshot).toEqual({
      sessionId: 's1',
      supported: true,
      active: false,
      servers: [],
      lastCheckedAt: null,
    });
  });

  it('never creates a provider — cache lookup only', () => {
    getProvider.mockReturnValue(null);

    getMcpSessionStatusSnapshot('s1', 'claude-code');

    expect(getProvider).toHaveBeenCalledWith('claude-code', 's1');
  });
});
