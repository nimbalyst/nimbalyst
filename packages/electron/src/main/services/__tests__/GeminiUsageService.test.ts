// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    main: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  },
}));

import { geminiUsageService } from '../GeminiUsageService';
import { AntigravityServerManager } from '@nimbalyst/runtime/ai/server/providers/geminiAntigravity/AntigravityServerManager';
import { AntigravityUsageMeter } from '@nimbalyst/runtime/ai/server/providers/geminiAntigravity/AntigravityUsageMeter';

describe('GeminiUsageService hub discovery', () => {
  beforeEach(() => {
    AntigravityServerManager.shared().clearEndpoint();
  });

  afterEach(() => {
    geminiUsageService.stop();
    AntigravityServerManager.shared().clearEndpoint();
    vi.restoreAllMocks();
  });

  it('attaches read-only to a running Antigravity hub without spawning when currentEndpoint() is null', async () => {
    const server = AntigravityServerManager.shared();
    const ensureRunning = vi.spyOn(server, 'ensureRunning');
    const findRunning = vi.spyOn(server, 'findRunningEndpoint').mockResolvedValue({
      httpsPort: 63063,
      csrf: 'tok',
      owned: false,
    });
    vi.spyOn(AntigravityUsageMeter.prototype, 'getSnapshot').mockResolvedValue({
      account: {
        planName: 'Pro',
        monthlyPromptCredits: 50_000,
        availablePromptCredits: 42_000,
      },
      models: {
        MODEL_GEMINI_4_NEON: {
          model: 'MODEL_GEMINI_4_NEON',
          label: 'Gemini 4 Neon (High)',
          remainingFraction: 0.75,
          resetTime: '2026-11-24T18:00:00Z',
        },
      },
      warn: false,
    });

    const data = await geminiUsageService.refresh();

    expect(findRunning).toHaveBeenCalledTimes(1);
    expect(ensureRunning).not.toHaveBeenCalled();
    expect(data.available).toBe(true);
    expect(data.limitsAvailable).toBe(true);
    expect(data.fiveHour.utilization).toBe(25);
    expect(data.credits?.balance).toBe(42_000);
  });

  it('returns notStarted when no endpoint is cached and no hub is running', async () => {
    const server = AntigravityServerManager.shared();
    const ensureRunning = vi.spyOn(server, 'ensureRunning');
    vi.spyOn(server, 'findRunningEndpoint').mockResolvedValue(null);

    const data = await geminiUsageService.refresh();

    expect(ensureRunning).not.toHaveBeenCalled();
    expect(data.available).toBe(false);
    expect(data.notStarted).toBe(true);
  });

  it('clears the stale endpoint and retries hub discovery once on RPC failure (port rotation)', async () => {
    const server = AntigravityServerManager.shared();
    const clearSpy = vi.spyOn(server, 'clearEndpoint');
    const findRunning = vi
      .spyOn(server, 'findRunningEndpoint')
      .mockResolvedValueOnce({ httpsPort: 50001, csrf: 'old-tok', owned: false })
      .mockResolvedValueOnce({ httpsPort: 50002, csrf: 'new-tok', owned: false });

    const getSnapshot = vi
      .spyOn(AntigravityUsageMeter.prototype, 'getSnapshot')
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:50001'))
      .mockResolvedValueOnce({
        account: { planName: 'Pro' },
        models: {
          MODEL_GEMINI: {
            model: 'MODEL_GEMINI',
            remainingFraction: 0.4,
            resetTime: '2026-11-24T19:00:00Z',
          },
        },
        warn: false,
      });

    const data = await geminiUsageService.refresh();

    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(findRunning).toHaveBeenCalledTimes(2);
    expect(getSnapshot).toHaveBeenCalledTimes(2);
    expect(data.available).toBe(true);
    expect(data.fiveHour.utilization).toBeCloseTo(60);
  });

  // The poll must never reach ensureRunning(), which spawns a server when the
  // discovered hub has gone away by the time the usage RPC runs.
  it('reads usage from the discovered hub without going through ensureRunning()', async () => {
    const server = AntigravityServerManager.shared();
    const hub = { httpsPort: 50020, csrf: 'hub-tok', owned: false };
    vi.spyOn(server, 'findRunningEndpoint').mockResolvedValue(hub);
    const ensureRunning = vi.spyOn(server, 'ensureRunning').mockResolvedValue(hub);
    const rpc = vi
      .spyOn(server as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, 'rpc')
      .mockResolvedValue({ userStatus: {} });

    await geminiUsageService.refresh();

    expect(ensureRunning).not.toHaveBeenCalled();
    expect(rpc).toHaveBeenCalledWith('GetUserStatus', {}, hub, 15_000);
  });

  // A GetUserStatus timeout on a busy server Nimbalyst spawned must not drop
  // its endpoint: the child is still alive, and a null endpoint makes the next
  // turn's ensureRunning() spawn a second language server and orphan the first.
  it('keeps an owned endpoint when the usage RPC times out', async () => {
    const server = AntigravityServerManager.shared();
    const owned = { httpsPort: 50010, csrf: 'own-tok', owned: true };
    (server as unknown as { endpoint: unknown }).endpoint = owned;
    const clearSpy = vi.spyOn(server, 'clearEndpoint');
    const findRunning = vi.spyOn(server, 'findRunningEndpoint');
    vi.spyOn(AntigravityUsageMeter.prototype, 'getSnapshot').mockRejectedValueOnce(
      new Error('Antigravity GetUserStatus timed out after 15s (port 50010, prompt 0KB, limit 15s)'),
    );

    const data = await geminiUsageService.refresh();

    expect(clearSpy).not.toHaveBeenCalled();
    expect(findRunning).not.toHaveBeenCalled();
    expect(server.currentEndpoint()).toBe(owned);
    expect(data.available).toBe(false);
  });

  it('keeps an attached endpoint when the usage RPC times out rather than refusing the connection', async () => {
    const server = AntigravityServerManager.shared();
    const attached = { httpsPort: 50011, csrf: 'hub-tok', owned: false };
    (server as unknown as { endpoint: unknown }).endpoint = attached;
    const clearSpy = vi.spyOn(server, 'clearEndpoint');
    vi.spyOn(AntigravityUsageMeter.prototype, 'getSnapshot').mockRejectedValueOnce(
      new Error('Antigravity GetUserStatus timed out after 15s (port 50011, prompt 0KB, limit 15s)'),
    );

    const data = await geminiUsageService.refresh();

    expect(clearSpy).not.toHaveBeenCalled();
    expect(server.currentEndpoint()).toBe(attached);
    expect(data.available).toBe(false);
  });

  it('maps 5-hour and weekly Gemini quota pools from RetrieveUserQuotaSummary', async () => {
    const server = AntigravityServerManager.shared();
    const hub = { httpsPort: 50030, csrf: 'hub-tok', owned: false };
    vi.spyOn(server, 'findRunningEndpoint').mockResolvedValue(hub);
    const rpc = vi
      .spyOn(server as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, 'rpc')
      .mockImplementation(async (method: unknown) => {
        if (method === 'RetrieveUserQuotaSummary') {
          return {
            response: {
              groups: [
                {
                  displayName: 'Claude and GPT models',
                  buckets: [
                    { bucketId: '3p-weekly', window: 'weekly', remainingFraction: 0.2, resetTime: '2026-12-02T00:00:00Z' },
                    { bucketId: '3p-5h', window: '5h', remainingFraction: 0.1, resetTime: '2026-11-26T19:00:00Z' },
                  ],
                },
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.96, resetTime: '2026-12-03T13:17:23Z' },
                    { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.88, resetTime: '2026-11-26T18:17:23Z' },
                  ],
                },
              ],
            },
          };
        }
        return {
          userStatus: {
            planStatus: { planInfo: { planName: 'Pro' }, availablePromptCredits: 500 },
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 4 Neon (High)',
                  modelOrAlias: { model: 'MODEL_PLACEHOLDER_M532' },
                  quotaInfo: { remainingFraction: 0.94, resetTime: '2026-11-26T18:17:23Z' },
                },
              ],
            },
          },
        };
      });

    const data = await geminiUsageService.refresh();

    expect(rpc).toHaveBeenCalledWith('RetrieveUserQuotaSummary', {}, hub, 15_000);
    expect(rpc).toHaveBeenCalledWith('GetUserStatus', {}, hub, 15_000);
    expect(data.available).toBe(true);
    expect(data.limitsAvailable).toBe(true);
    expect(data.windowSource).toBe('summary');
    expect(data.hasFiveHour).toBe(true);
    expect(data.hasSevenDay).toBe(true);
    expect(data.fiveHour.utilization).toBeCloseTo(12);
    expect(data.fiveHour.resetsAt).toBe('2026-11-26T18:17:23Z');
    expect(data.sevenDay.utilization).toBeCloseTo(4);
    expect(data.sevenDay.resetsAt).toBe('2026-12-03T13:17:23Z');
    expect(data.credits?.balance).toBe(500);
  });

  it('supports weekly-only quota summaries (no 5-hour bucket)', async () => {
    const server = AntigravityServerManager.shared();
    const hub = { httpsPort: 50031, csrf: 'hub-tok', owned: false };
    vi.spyOn(server, 'findRunningEndpoint').mockResolvedValue(hub);
    vi.spyOn(server as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, 'rpc')
      .mockImplementation(async (method: unknown) => {
        if (method === 'RetrieveUserQuotaSummary') {
          return {
            response: {
              groups: [
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    { bucketId: 'gemini-weekly', window: 'weekly', remainingFraction: 0.7, resetTime: '2026-12-03T00:00:00Z' },
                  ],
                },
              ],
            },
          };
        }
        return { userStatus: {} };
      });

    const data = await geminiUsageService.refresh();

    expect(data.windowSource).toBe('summary');
    expect(data.hasFiveHour).toBe(false);
    expect(data.hasSevenDay).toBe(true);
    expect(data.sevenDay.utilization).toBeCloseTo(30);
    expect(data.sevenDay.resetsAt).toBe('2026-12-03T00:00:00Z');
  });

  it('falls back to per-model GetUserStatus quotas when RetrieveUserQuotaSummary is unsupported', async () => {
    const server = AntigravityServerManager.shared();
    const hub = { httpsPort: 50032, csrf: 'hub-tok', owned: false };
    vi.spyOn(server, 'findRunningEndpoint').mockResolvedValue(hub);
    vi.spyOn(server as unknown as { rpc: (...args: unknown[]) => Promise<unknown> }, 'rpc')
      .mockImplementation(async (method: unknown) => {
        if (method === 'RetrieveUserQuotaSummary') {
          throw new Error('Antigravity RetrieveUserQuotaSummary HTTP 404: unimplemented');
        }
        return {
          userStatus: {
            cascadeModelConfigData: {
              clientModelConfigs: [
                {
                  label: 'Gemini 4 Neon (High)',
                  modelOrAlias: { model: 'MODEL_A' },
                  quotaInfo: { remainingFraction: 0.65, resetTime: '2026-11-26T18:00:00Z' },
                },
                {
                  label: 'Gemini 4 Carbon (High)',
                  modelOrAlias: { model: 'MODEL_B' },
                  quotaInfo: { remainingFraction: 0.85, resetTime: '2026-11-26T19:00:00Z' },
                },
              ],
            },
          },
        };
      });

    const data = await geminiUsageService.refresh();

    expect(data.available).toBe(true);
    expect(data.limitsAvailable).toBe(true);
    expect(data.windowSource).toBe('models');
    expect(data.fiveHour.utilization).toBeCloseTo(35);
    expect(data.sevenDay.utilization).toBeCloseTo(15);
  });
});
