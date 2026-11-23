// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Checks how `claude-code:detect-account-models` wires its real pieces: the saved list is
 * read (so a model saved earlier is not reported as added), the new list is saved, and the
 * model cache is cleared only after a successful run. The open windows are told to reload
 * their model pickers after the cache is cleared, and only after a successful run.
 */
const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown) => Promise<unknown>>();
  return {
    handlers,
    getAccessTokenForApi: vi.fn(),
    getClaudeCodeDiscoveredModels: vi.fn(),
    setClaudeCodeDiscoveredModels: vi.fn(),
    clearCache: vi.fn(),
    getAllWindows: vi.fn(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, fn: (event: unknown) => Promise<unknown>) => {
    mocks.handlers.set(channel, fn);
  },
  safeOn: () => {},
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

vi.mock('@nimbalyst/runtime/electron/claudeCodeEnvironment', () => ({
  setupClaudeCodeEnvironment: vi.fn(),
  resolveClaudeCodeExecutablePath: vi.fn(),
}));

vi.mock('../../services/ClaudeCodeDetector', () => ({
  claudeCodeDetector: { getStatus: vi.fn(), clearCache: vi.fn() },
}));

vi.mock('../../utils/logger', () => ({
  logger: { ipc: { error: vi.fn(), info: vi.fn() }, main: { warn: vi.fn(), info: vi.fn() } },
}));

vi.mock('../../services/analytics/AnalyticsService.ts', () => ({
  AnalyticsService: { getInstance: () => ({ sendEvent: vi.fn() }) },
}));

vi.mock('../../utils/store', () => ({
  shouldShowClaudeCodeWindowsWarning: vi.fn(() => false),
  dismissClaudeCodeWindowsWarning: vi.fn(),
  getClaudeCodeDiscoveredModels: mocks.getClaudeCodeDiscoveredModels,
  setClaudeCodeDiscoveredModels: mocks.setClaudeCodeDiscoveredModels,
}));

vi.mock('../../services/ClaudeUsageService', () => ({
  claudeUsageService: { getAccessTokenForApi: mocks.getAccessTokenForApi },
}));

vi.mock('@nimbalyst/runtime/ai/server/ModelRegistry', () => ({
  ModelRegistry: { clearCache: mocks.clearCache },
}));

import { registerClaudeCodeHandlers } from '../ClaudeCodeHandlers';

const TOKEN = 'fake-token-for-tests-1234';

const ACCOUNT_LIST = {
  data: [
    { id: 'claude-mythos-5-2', display_name: 'Claude Mythos 5.2', line: 'mythos', max_input_tokens: 1_000_000 },
    { id: 'claude-mythos-5-1', display_name: 'Claude Mythos 5.1', line: 'mythos', max_input_tokens: 1_000_000 },
  ],
};

async function invokeDetect() {
  const handler = mocks.handlers.get('claude-code:detect-account-models');
  if (!handler) throw new Error('detect-account-models handler not registered');
  return handler({});
}

describe('claude-code:detect-account-models', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    vi.clearAllMocks();
    mocks.getAccessTokenForApi.mockResolvedValue(TOKEN);
    mocks.getAllWindows.mockReturnValue([]);
    registerClaudeCodeHandlers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the saved list, so only new models are reported, then saves and clears the cache', async () => {
    mocks.getClaudeCodeDiscoveredModels.mockReturnValue([{ model: 'claude-mythos-5-2', label: 'Claude Mythos 5.2' }]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ACCOUNT_LIST), { status: 200, headers: { 'content-type': 'application/json' } })));

    const result = await invokeDetect();

    expect(result).toEqual({
      ok: true,
      added: [{ model: 'claude-mythos-5-1', label: 'Claude Mythos 5.1' }],
      totalFromAccount: 2,
    });
    expect(mocks.getClaudeCodeDiscoveredModels).toHaveBeenCalled();
    expect(mocks.setClaudeCodeDiscoveredModels).toHaveBeenCalledTimes(1);
    expect((mocks.setClaudeCodeDiscoveredModels.mock.calls[0][0] as { model: string }[]).map((o) => o.model)).toEqual([
      'claude-mythos-5-2',
      'claude-mythos-5-1',
    ]);
    expect(mocks.clearCache).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it('saves nothing and keeps the model cache when the sign-in is missing', async () => {
    mocks.getAccessTokenForApi.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await invokeDetect();

    expect(result).toMatchObject({ ok: false, error: 'not-signed-in' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.setClaudeCodeDiscoveredModels).not.toHaveBeenCalled();
    expect(mocks.clearCache).not.toHaveBeenCalled();
  });

  describe('telling open windows to reload their model pickers', () => {
    /** A stand-in window that records what main sends to it. */
    const fakeWindow = (destroyed = false) => ({
      isDestroyed: () => destroyed,
      webContents: { send: vi.fn(), isDestroyed: () => destroyed },
    });

    it('sends the change signal to every open window after a successful run, once the cache is cleared', async () => {
      const first = fakeWindow();
      const second = fakeWindow();
      mocks.getAllWindows.mockReturnValue([first, second]);
      mocks.getClaudeCodeDiscoveredModels.mockReturnValue([]);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ACCOUNT_LIST), { status: 200, headers: { 'content-type': 'application/json' } })));
      // The windows read the list again at once, so the cache has to be empty by then.
      let cacheClearsWhenSent = -1;
      first.webContents.send.mockImplementation(() => {
        cacheClearsWhenSent = mocks.clearCache.mock.calls.length;
      });

      await invokeDetect();

      expect(cacheClearsWhenSent).toBe(1);

      expect(first.webContents.send).toHaveBeenCalledWith('claude-code:account-models-changed');
      expect(second.webContents.send).toHaveBeenCalledWith('claude-code:account-models-changed');
    });

    it('skips a window that is already closed', async () => {
      const closed = fakeWindow(true);
      const open = fakeWindow();
      mocks.getAllWindows.mockReturnValue([closed, open]);
      mocks.getClaudeCodeDiscoveredModels.mockReturnValue([]);
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(ACCOUNT_LIST), { status: 200, headers: { 'content-type': 'application/json' } })));

      await invokeDetect();

      expect(closed.webContents.send).not.toHaveBeenCalled();
      expect(open.webContents.send).toHaveBeenCalledTimes(1);
    });

    it('sends nothing when the run fails', async () => {
      const win = fakeWindow();
      mocks.getAllWindows.mockReturnValue([win]);
      mocks.getAccessTokenForApi.mockResolvedValue(null);

      await invokeDetect();

      expect(win.webContents.send).not.toHaveBeenCalled();
    });
  });
});
