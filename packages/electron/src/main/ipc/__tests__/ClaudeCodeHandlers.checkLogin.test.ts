import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Verifies that `claude-code:check-login` is *honest*: it must resolve the same
 * binary the run path uses (bundled / custom only, NO system fallback) so the
 * login widget can't report "logged in" when the only path that actually sends
 * messages is broken. See NIM-895.
 */
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: any, data: any) => Promise<any>>();
  return {
    handlers,
    query: vi.fn(),
    accountInfo: vi.fn(),
    setupClaudeCodeEnvironment: vi.fn(() => ({ PATH: '/fake/path' })),
    resolveClaudeCodeExecutablePath: vi.fn(),
    sendEvent: vi.fn(),
  };
});

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (event: any, data: any) => Promise<any>) => {
    mocks.handlers.set(channel, fn);
  },
  safeOn: () => {},
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mocks.query,
}));

vi.mock('@nimbalyst/runtime/electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: mocks.setupClaudeCodeEnvironment,
  resolveClaudeCodeExecutablePath: mocks.resolveClaudeCodeExecutablePath,
}));

vi.mock('../../services/ClaudeCodeDetector', () => ({
  claudeCodeDetector: { getStatus: vi.fn(), clearCache: vi.fn() },
}));

vi.mock('../../utils/logger', () => ({
  logger: { ipc: { error: vi.fn(), info: vi.fn() } },
}));

vi.mock('../../services/analytics/AnalyticsService.ts', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: mocks.sendEvent }) },
}));

vi.mock('../../utils/store', () => ({
  shouldShowClaudeCodeWindowsWarning: vi.fn(() => false),
  dismissClaudeCodeWindowsWarning: vi.fn(),
}));

import { registerClaudeCodeHandlers } from '../ClaudeCodeHandlers';

async function invokeCheckLogin() {
  const handler = mocks.handlers.get('claude-code:check-login');
  if (!handler) throw new Error('check-login handler not registered');
  return handler({}, undefined);
}

describe('claude-code:check-login honesty', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.query.mockReset();
    mocks.accountInfo.mockReset();
    mocks.resolveClaudeCodeExecutablePath.mockReset();
    mocks.sendEvent.mockReset();
    mocks.query.mockImplementation(() => ({ accountInfo: mocks.accountInfo }));
    registerClaudeCodeHandlers();
  });

  it('resolves the binary WITHOUT system fallback (mirrors the run path)', async () => {
    mocks.resolveClaudeCodeExecutablePath.mockReturnValue('/bundled/claude');
    mocks.accountInfo.mockResolvedValue({ email: 'user@example.com' });

    await invokeCheckLogin();

    expect(mocks.resolveClaudeCodeExecutablePath).toHaveBeenCalledWith(
      expect.objectContaining({ allowSystemFallback: false })
    );
  });

  it('reports NOT logged in (with an error) when the bundled binary is missing, without calling the SDK', async () => {
    mocks.resolveClaudeCodeExecutablePath.mockReturnValue(undefined);

    const result = await invokeCheckLogin();

    expect(result.isLoggedIn).toBe(false);
    expect(result.error).toBeTruthy();
    // Must NOT silently fall through to the SDK (which could self-resolve system claude).
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('reports logged in when the bundled binary resolves and accountInfo returns an email', async () => {
    mocks.resolveClaudeCodeExecutablePath.mockReturnValue('/bundled/claude');
    mocks.accountInfo.mockResolvedValue({ email: 'user@example.com', subscriptionType: 'max' });

    const result = await invokeCheckLogin();

    expect(result.isLoggedIn).toBe(true);
    expect(result.email).toBe('user@example.com');
  });
});
