// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const registeredHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
const sentMessages: Array<{ channel: string; payload: unknown }> = [];

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            sentMessages.push({ channel, payload });
          },
        },
      },
    ]),
  },
}));

vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    registeredHandlers.set(channel, handler);
  },
}));

vi.mock('../../utils/logger', () => ({
  logger: {
    ipc: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    main: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  },
}));

const openExternalMock = vi.fn(async (_url?: string) => {});
vi.mock('../../utils/systemShell', () => ({
  systemShell: {
    openExternal: (url: string) => openExternalMock(url),
  },
}));

import { AntigravityServerManager } from '@nimbalyst/runtime/ai/server/providers/geminiAntigravity/AntigravityServerManager';
import { geminiUsageService } from '../../services/GeminiUsageService';
import {
  registerGeminiAuthHandlers,
  resetGeminiAuthHandlerStateForTests,
} from '../GeminiAuthHandlers';

describe('GeminiAuthHandlers', () => {
  const hub = { httpsPort: 61234, csrf: 'tok', owned: false };

  beforeEach(() => {
    registeredHandlers.clear();
    sentMessages.length = 0;
    openExternalMock.mockClear();
    resetGeminiAuthHandlerStateForTests();
    AntigravityServerManager.shared().clearEndpoint();
    registerGeminiAuthHandlers();
  });

  afterEach(() => {
    resetGeminiAuthHandlerStateForTests();
    geminiUsageService.stop();
    AntigravityServerManager.shared().clearEndpoint();
    vi.restoreAllMocks();
  });

  it('returns signed-in account email and plan from gemini-auth:status', async () => {
    const server = AntigravityServerManager.shared();
    vi.spyOn(AntigravityServerManager, 'isInstalled').mockReturnValue(true);
    vi.spyOn(server, 'findRunningEndpoint').mockResolvedValue(hub);
    vi.spyOn(server, 'getAuthStatus').mockResolvedValue({ authResult: { hasValidAuth: true } });
    vi.spyOn(server, 'getLoginSession').mockResolvedValue({ active: false });
    vi.spyOn(server, 'getUserStatus').mockResolvedValue({
      email: 'dev@example.com',
      name: 'Dev User',
      planStatus: { planInfo: { planName: 'Pro', teamsTier: 'TEAMS_TIER_PRO' } },
    });

    const handler = registeredHandlers.get('gemini-auth:status')!;
    const res = await handler();

    expect(res).toEqual({
      installed: true,
      isLoggedIn: true,
      email: 'dev@example.com',
      name: 'Dev User',
      planName: 'Pro',
      tier: 'TEAMS_TIER_PRO',
      loginInProgress: false,
      loginAuthUrl: null,
    });
  });

  it('logs out, clears caches, refreshes usage, and starts Google login on switch-account', async () => {
    const server = AntigravityServerManager.shared();
    vi.spyOn(AntigravityServerManager, 'isInstalled').mockReturnValue(true);
    vi.spyOn(server, 'findRunningEndpoint').mockResolvedValue(hub);
    const logoutSpy = vi.spyOn(server, 'googleLogout').mockResolvedValue();
    const clearEnumSpy = vi.spyOn(server, 'clearEnumCache');
    const refreshSpy = vi.spyOn(geminiUsageService, 'refresh').mockResolvedValue({
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: { utilization: 0, resetsAt: null },
      lastUpdated: Date.now(),
    });
    const loginSpy = vi
      .spyOn(server, 'startGoogleLogin')
      .mockResolvedValue({ authResult: { hasValidAuth: true } });
    vi.spyOn(server, 'getAuthStatus').mockResolvedValue({ authResult: { hasValidAuth: true } });
    vi.spyOn(server, 'getLoginSession').mockResolvedValue({ active: false });
    vi.spyOn(server, 'getUserStatus').mockResolvedValue({
      email: 'next@example.com',
      planStatus: { planInfo: { planName: 'Pro' } },
    });

    const handler = registeredHandlers.get('gemini-auth:switch-account')!;
    const res = await handler();

    expect(res).toMatchObject({ success: true });
    expect(logoutSpy).toHaveBeenCalledWith(hub);
    expect(loginSpy).toHaveBeenCalledWith(hub);
    expect(clearEnumSpy).toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalled();
    expect(sentMessages.some((m) => m.channel === 'gemini-auth:login-completed')).toBe(true);
  });

  it('validates https:// URLs on gemini-auth:open-url', async () => {
    const handler = registeredHandlers.get('gemini-auth:open-url')!;

    await expect(handler({}, 'javascript:alert(1)')).resolves.toEqual({
      success: false,
      error: 'No active sign-in URL',
    });
    expect(openExternalMock).not.toHaveBeenCalled();

    await expect(handler({}, 'https://accounts.google.com/o/oauth2/v2/auth')).resolves.toEqual({
      success: true,
    });
    expect(openExternalMock).toHaveBeenCalledExactlyOnceWith(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
  });

  it('signs out via AuthLogout and broadcasts gemini-auth:updated', async () => {
    const server = AntigravityServerManager.shared();
    vi.spyOn(AntigravityServerManager, 'isInstalled').mockReturnValue(true);
    vi.spyOn(server, 'findRunningEndpoint').mockResolvedValue(hub);
    const logoutSpy = vi.spyOn(server, 'googleLogout').mockResolvedValue();
    vi.spyOn(geminiUsageService, 'refresh').mockResolvedValue({
      fiveHour: { utilization: 0, resetsAt: null },
      sevenDay: { utilization: 0, resetsAt: null },
      lastUpdated: Date.now(),
    });

    const handler = registeredHandlers.get('gemini-auth:logout')!;
    const res = await handler();

    expect(res).toEqual({ success: true });
    expect(logoutSpy).toHaveBeenCalledWith(hub);
    expect(sentMessages.some((m) => m.channel === 'gemini-auth:updated')).toBe(true);
  });
});
