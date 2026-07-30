/**
 * usagePollingServer tests -- the MCP tool surface exposing the
 * already-existing Claude/Codex/Ollama usage services to a running session
 * (they were previously renderer-IPC-only; see the module doc for the gap).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { claudeUsageServiceMock, codexUsageServiceMock, ollamaUsageServiceMock } = vi.hoisted(() => ({
  claudeUsageServiceMock: {
    recordActivity: vi.fn(),
    getCachedUsage: vi.fn(),
    refresh: vi.fn(),
  },
  codexUsageServiceMock: {
    recordActivity: vi.fn(),
    getCachedUsage: vi.fn(),
    refresh: vi.fn(),
  },
  ollamaUsageServiceMock: {
    getUsage: vi.fn(),
  },
}));

vi.mock('../../services/ClaudeUsageService', () => ({
  claudeUsageService: claudeUsageServiceMock,
}));
vi.mock('../../services/CodexUsageService', () => ({
  codexUsageService: codexUsageServiceMock,
}));
vi.mock('../../services/OllamaUsageService', () => ({
  ollamaUsageService: ollamaUsageServiceMock,
}));

import { USAGE_POLLING_TOOL_SCHEMAS, dispatchUsagePollingTool } from '../usagePollingServer';

describe('usagePollingServer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    claudeUsageServiceMock.getCachedUsage.mockReturnValue({
      fiveHour: { utilization: 42, resetsAt: '2026-07-30T18:00:00.000Z' },
      sevenDay: { utilization: 15, resetsAt: '2026-08-06T00:00:00.000Z' },
      lastUpdated: Date.now(),
    });
    codexUsageServiceMock.getCachedUsage.mockReturnValue({
      limits: [
        {
          id: 'codex',
          name: null,
          planType: 'pro',
          windows: [{ slot: 'primary', usedPercent: 12, windowDurationMins: 300, resetsAt: null }],
          credits: null,
          individualLimit: null,
          rateLimitReachedType: null,
        },
      ],
      limitsAvailable: true,
      lastUpdated: Date.now(),
    });
    ollamaUsageServiceMock.getUsage.mockResolvedValue({
      limitsAvailable: true,
      session: { utilization: 0, resetsAt: null, models: [{ name: 'gpt-oss:120b', requestCount: 1 }] },
      weekly: { utilization: 5.1, resetsAt: null, models: [{ name: 'glm-5.2', requestCount: 253 }] },
      costUSD: 0,
      proxyReachable: false,
      configuredAliases: [],
      planTiers: [{ tier: 'Free', concurrentCloudModels: 1, weeklyGpuQuota: 'baseline' }],
      lastUpdated: Date.now(),
    });
  });

  it('exposes exactly one tool: get_provider_usage', () => {
    expect(USAGE_POLLING_TOOL_SCHEMAS.map((t) => t.name)).toEqual(['get_provider_usage']);
  });

  it('returns a combined report for all three providers when none is specified', async () => {
    const result = await dispatchUsagePollingTool('get_provider_usage', {});
    expect(result.isError).toBe(false);
    const text = result.content[0].text;
    expect(text).toContain('Claude Code usage:');
    expect(text).toContain('OpenAI Codex usage:');
    expect(text).toContain('Ollama Cloud usage:');
  });

  it('scopes to a single provider when specified', async () => {
    const result = await dispatchUsagePollingTool('get_provider_usage', { provider: 'claude-code' });
    const text = result.content[0].text;
    expect(text).toContain('Claude Code usage:');
    expect(text).not.toContain('OpenAI Codex usage:');
    expect(text).not.toContain('Ollama Cloud');
  });

  it('rejects an invalid provider value instead of silently ignoring it', async () => {
    const result = await dispatchUsagePollingTool('get_provider_usage', { provider: 'gpt-5.4' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid provider');
  });

  it('calls refresh() instead of getCachedUsage() when forceRefresh is set', async () => {
    claudeUsageServiceMock.refresh.mockResolvedValue({
      fiveHour: { utilization: 99, resetsAt: null },
      sevenDay: { utilization: 50, resetsAt: null },
      lastUpdated: Date.now(),
    });

    await dispatchUsagePollingTool('get_provider_usage', { provider: 'claude-code', forceRefresh: true });

    expect(claudeUsageServiceMock.refresh).toHaveBeenCalledTimes(1);
    expect(claudeUsageServiceMock.getCachedUsage).not.toHaveBeenCalled();
  });

  it('falls back to refresh() when there is no cached data yet', async () => {
    claudeUsageServiceMock.getCachedUsage.mockReturnValue(null);
    claudeUsageServiceMock.refresh.mockResolvedValue({
      fiveHour: { utilization: 5, resetsAt: null },
      sevenDay: { utilization: 1, resetsAt: null },
      lastUpdated: Date.now(),
    });

    const result = await dispatchUsagePollingTool('get_provider_usage', { provider: 'claude-code' });

    expect(claudeUsageServiceMock.refresh).toHaveBeenCalledTimes(1);
    expect(result.content[0].text).toContain('5%');
  });

  it('surfaces a provider error inline rather than throwing', async () => {
    claudeUsageServiceMock.getCachedUsage.mockReturnValue({
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: { utilization: 0, resetsAt: null },
      lastUpdated: Date.now(),
      error: 'Authentication expired. Please re-login to Claude Code.',
    });

    const result = await dispatchUsagePollingTool('get_provider_usage', { provider: 'claude-code' });

    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain('unavailable -- Authentication expired');
  });

  it('throws MethodNotFound for an unknown tool name', async () => {
    await expect(dispatchUsagePollingTool('mcp__nimbalyst-host__not_a_real_tool', {})).rejects.toThrow();
  });
});
