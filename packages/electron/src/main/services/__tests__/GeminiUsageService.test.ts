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
});
