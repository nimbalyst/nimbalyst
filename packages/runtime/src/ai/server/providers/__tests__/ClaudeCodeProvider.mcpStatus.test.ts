/**
 * Per-session MCP status plumbing on ClaudeCodeProvider (NIM-2272 / GH #1089).
 *
 * The health-check layer has existed since 7dd8baab0 with no consumer; these
 * tests cover the accessors and emit behaviour the UI now depends on.
 *
 * The load-bearing one is the snapshot-name accessor: reading it must never
 * force the frozen MCP config snapshot to resolve early or trigger a live
 * config read. That freeze is what keeps a resumed turn's tool prefix
 * byte-stable, and losing it costs a full prompt-cache miss (NIM-1988).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
}));

vi.mock('../claudeCode/cliPathResolver', () => ({
  resolveClaudeAgentCliPath: async () => '/fake/claude',
}));

vi.mock('../../../../electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: () => ({}),
  resolveNativeBinaryPath: () => undefined,
}));

import { ClaudeCodeProvider, type McpServerStatusInfo } from '../ClaudeCodeProvider';

type ProviderInternals = {
  mcpQuery: { mcpServerStatus: () => Promise<McpServerStatusInfo[]> } | null;
  currentSessionId: string | undefined;
  checkMcpServerStatuses: () => Promise<void>;
  startMcpHealthChecks: () => void;
  stopMcpHealthChecks: () => void;
  mcpServersSnapshotJsonPromise: Promise<string> | undefined;
  mcpConfigService: { getMcpServersConfig: (...args: any[]) => Promise<Record<string, unknown>> };
  getMcpServersSnapshot: (options: { workspacePath: string }) => Promise<Record<string, unknown>>;
};

function internals(provider: ClaudeCodeProvider): ProviderInternals {
  return provider as unknown as ProviderInternals;
}

function connected(name: string, tools = 1): McpServerStatusInfo {
  return { name, status: 'connected', scope: 'local', tools: Array.from({ length: tools }, (_, i) => ({ name: `t${i}` })) };
}

/** Install a fake persistent query returning a scripted sequence of polls. */
function stubPolls(provider: ClaudeCodeProvider, polls: McpServerStatusInfo[][]) {
  let index = 0;
  const mcpServerStatus = vi.fn(async () => polls[Math.min(index++, polls.length - 1)]);
  internals(provider).mcpQuery = { mcpServerStatus };
  internals(provider).currentSessionId = 'session-1';
  return mcpServerStatus;
}

describe('ClaudeCodeProvider MCP session status', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits only when a server status actually transitions, not on every poll', async () => {
    const provider = new ClaudeCodeProvider();
    stubPolls(provider, [
      [connected('trackers')],
      [connected('trackers')],
      [{ name: 'trackers', status: 'failed', error: 'pipe closed' }],
    ]);

    const emitted: any[] = [];
    provider.on('mcpServerStatus:changed', (payload) => emitted.push(payload));

    await internals(provider).checkMcpServerStatuses(); // first sighting is a change
    expect(emitted).toHaveLength(1);

    await internals(provider).checkMcpServerStatuses(); // steady state: silent
    expect(emitted).toHaveLength(1);

    await internals(provider).checkMcpServerStatuses(); // connected -> failed
    expect(emitted).toHaveLength(2);
    expect(emitted[1].changes).toEqual([
      { name: 'trackers', status: 'failed', error: 'pipe closed' },
    ]);
  });

  it('drops a server that disappears from the poll instead of reporting it still connected', async () => {
    const provider = new ClaudeCodeProvider();
    stubPolls(provider, [
      [connected('trackers'), connected('posthog')],
      [connected('trackers')],
    ]);

    const emitted: any[] = [];
    provider.on('mcpServerStatus:changed', (payload) => emitted.push(payload));

    await internals(provider).checkMcpServerStatuses();
    await internals(provider).checkMcpServerStatuses();

    expect(provider.getMcpServerStatuses().map((s) => s.name)).toEqual(['trackers']);
    expect(emitted).toHaveLength(2);
  });

  it('records a last-checked timestamp only after a poll returns', async () => {
    const provider = new ClaudeCodeProvider();
    expect(provider.getMcpStatusLastCheckedAt()).toBeNull();

    stubPolls(provider, [[connected('trackers')]]);
    await internals(provider).checkMcpServerStatuses();

    expect(provider.getMcpStatusLastCheckedAt()).toBeTypeOf('number');
  });

  it('leaves the timestamp null when the query is gone, so the UI cannot claim a poll happened', async () => {
    const provider = new ClaudeCodeProvider();
    internals(provider).mcpQuery = null;

    await internals(provider).checkMcpServerStatuses();

    expect(provider.getMcpStatusLastCheckedAt()).toBeNull();
    expect(provider.getMcpSessionStatus().servers).toEqual([]);
  });

  it('polls immediately when health checks start, so the surface is not blank for 30s', async () => {
    const provider = new ClaudeCodeProvider();
    const poll = stubPolls(provider, [[connected('trackers')]]);

    internals(provider).startMcpHealthChecks();
    await vi.waitFor(() => expect(poll).toHaveBeenCalledTimes(1));
    internals(provider).stopMcpHealthChecks();
  });

  describe('configured-server-name accessor (NIM-1988 boundary)', () => {
    it('reports nothing and reads no config while the frozen snapshot is unsettled', async () => {
      const provider = new ClaudeCodeProvider();
      let resolveConfig: (value: Record<string, unknown>) => void = () => {};
      const getMcpServersConfig = vi.fn(
        () => new Promise<Record<string, unknown>>((resolve) => { resolveConfig = resolve; }),
      );
      internals(provider).mcpConfigService = { getMcpServersConfig };

      // Kick off the snapshot the way a turn would, then read the accessor
      // before it settles.
      const pending = internals(provider).getMcpServersSnapshot({ workspacePath: '/tmp/ws' });

      expect(provider.getMcpConfiguredServerNames()).toBeNull();
      expect(getMcpServersConfig).toHaveBeenCalledTimes(1);

      resolveConfig({ trackers: { command: 'node' } });
      await pending;

      expect(provider.getMcpConfiguredServerNames()).toEqual(['trackers']);
      // Still exactly one config read: the accessor never triggered its own.
      expect(getMcpServersConfig).toHaveBeenCalledTimes(1);
    });

    it('does not force a config read when no turn has built the snapshot yet', () => {
      const provider = new ClaudeCodeProvider();
      const getMcpServersConfig = vi.fn(async () => ({ trackers: {} }));
      internals(provider).mcpConfigService = { getMcpServersConfig };

      expect(provider.getMcpConfiguredServerNames()).toBeNull();
      expect(getMcpServersConfig).not.toHaveBeenCalled();
      expect(internals(provider).mcpServersSnapshotJsonPromise).toBeUndefined();
    });

    it('exposes names only — never the credential-bearing snapshot values', async () => {
      const provider = new ClaudeCodeProvider();
      internals(provider).mcpConfigService = {
        getMcpServersConfig: async () => ({
          remote: {
            url: 'https://internal.example.com/mcp',
            headers: { Authorization: 'Bearer super-secret' },
            env: { API_KEY: 'sk-live-nope' },
          },
        }),
      };

      await internals(provider).getMcpServersSnapshot({ workspacePath: '/tmp/ws' });

      const status = provider.getMcpSessionStatus();
      expect(status.configuredNames).toEqual(['remote']);
      expect(JSON.stringify(status)).not.toContain('super-secret');
      expect(JSON.stringify(status)).not.toContain('sk-live-nope');
    });

    it('hands back a copy so a caller cannot mutate the session snapshot', async () => {
      const provider = new ClaudeCodeProvider();
      internals(provider).mcpConfigService = {
        getMcpServersConfig: async () => ({ trackers: {} }),
      };
      await internals(provider).getMcpServersSnapshot({ workspacePath: '/tmp/ws' });

      provider.getMcpConfiguredServerNames()!.push('injected');

      expect(provider.getMcpConfiguredServerNames()).toEqual(['trackers']);
    });
  });

  it('never reaches for setMcpServers or toggleMcpServer', async () => {
    // Both would replace the dynamic server set mid-session, which is exactly
    // the churn the snapshot freeze exists to prevent. A future "improve the
    // refresh" change that calls either should fail here.
    const provider = new ClaudeCodeProvider();
    const setMcpServers = vi.fn();
    const toggleMcpServer = vi.fn();
    const poll = stubPolls(provider, [[connected('trackers')]]);
    Object.assign(internals(provider).mcpQuery!, { setMcpServers, toggleMcpServer });

    await internals(provider).checkMcpServerStatuses();
    provider.getMcpSessionStatus();

    expect(poll).toHaveBeenCalled();
    expect(setMcpServers).not.toHaveBeenCalled();
    expect(toggleMcpServer).not.toHaveBeenCalled();
  });
});
