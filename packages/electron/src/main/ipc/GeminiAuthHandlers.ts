/**
 * IPC handlers for Gemini (Antigravity) Google OAuth authentication.
 *
 * Drives the Antigravity language server's native auth RPCs (`GetAuthStatus`,
 * `Login`, `GetLoginSession`, `CancelLogin`, `AuthLogout`) so users can sign
 * in, switch Google accounts, and sign out directly from Settings -> Gemini or
 * the Gemini Usage popover without leaving Nimbalyst.
 */

import { BrowserWindow } from 'electron';
import { AntigravityServerManager, type AntigravityEndpoint } from '@nimbalyst/runtime/ai/server/providers/geminiAntigravity/AntigravityServerManager';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { systemShell } from '../utils/systemShell';
import { geminiUsageService } from '../services/GeminiUsageService';

const log = logger.ipc;

export interface GeminiAuthStatus {
  installed: boolean;
  isLoggedIn: boolean;
  email: string | null;
  name: string | null;
  planName: string | null;
  tier: string | null;
  loginInProgress: boolean;
  loginAuthUrl: string | null;
  error?: string;
}

export interface GeminiAuthActionResult {
  success: boolean;
  started?: boolean;
  alreadyInProgress?: boolean;
  authUrl?: string | null;
  error?: string;
}

let activeLoginPromise: Promise<unknown> | null = null;
let activeLoginAuthUrl: string | null = null;
let exitHookRegistered = false;
let externalAccountUnsubscribe: (() => void) | null = null;

function broadcastGeminiAuth(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

async function ensureGeminiAuthEndpoint(): Promise<{
  server: AntigravityServerManager;
  ep: AntigravityEndpoint | null;
}> {
  const server = AntigravityServerManager.shared();
  const running = await server.findRunningEndpoint().catch(() => null);
  if (running) {
    return { server, ep: running };
  }
  if (AntigravityServerManager.isInstalled()) {
    if (!exitHookRegistered) {
      exitHookRegistered = true;
      process.once('exit', () => {
        try {
          if (server.currentEndpoint()?.owned) server.stop();
        } catch {
          /* best effort */
        }
      });
    }
    const ep = await server.ensureRunning();
    return { server, ep };
  }
  return { server, ep: null };
}

async function invalidateAfterAuthChange(
  server: AntigravityServerManager,
  knownEmail: string | null,
): Promise<void> {
  server.clearEnumCache();
  geminiUsageService.setKnownAccountEmail(knownEmail);
  await geminiUsageService.refresh().catch(() => null);
  broadcastGeminiAuth('gemini-auth:updated', { timestamp: Date.now() });
}

async function readGeminiAuthStatus(): Promise<GeminiAuthStatus> {
  const installed = AntigravityServerManager.isInstalled();
  try {
    const { server, ep } = await ensureGeminiAuthEndpoint();
    if (!ep) {
      return {
        installed,
        isLoggedIn: false,
        email: null,
        name: null,
        planName: null,
        tier: null,
        loginInProgress: false,
        loginAuthUrl: null,
        error: installed
          ? 'Could not start Antigravity language server.'
          : 'Antigravity is not installed.',
      };
    }

    const [authRes, loginSession] = await Promise.all([
      server.getAuthStatus(ep).catch(() => null),
      server.getLoginSession(ep).catch(() => null),
    ]);

    const hasValidAuth = Boolean(authRes?.authResult?.hasValidAuth);
    let email: string | null = null;
    let name: string | null = null;
    let planName: string | null = null;
    let tier: string | null = null;

    if (hasValidAuth) {
      const us = await server.getUserStatus(ep).catch(() => null);
      email = typeof us?.email === 'string' && us.email.trim() ? us.email.trim() : null;
      name = typeof us?.name === 'string' && us.name.trim() ? us.name.trim() : null;
      planName =
        typeof us?.planStatus?.planInfo?.planName === 'string' &&
        us.planStatus.planInfo.planName.trim()
          ? us.planStatus.planInfo.planName.trim()
          : null;
      tier =
        typeof us?.planStatus?.planInfo?.teamsTier === 'string'
          ? us.planStatus.planInfo.teamsTier
          : null;
      geminiUsageService.setKnownAccountEmail(email);
    } else {
      geminiUsageService.setKnownAccountEmail(null);
    }

    const activeUrl =
      typeof loginSession?.authUrl === 'string' && loginSession.authUrl
        ? loginSession.authUrl
        : activeLoginAuthUrl;
    if (loginSession?.active && activeUrl) {
      activeLoginAuthUrl = activeUrl;
    }

    const inProgress = Boolean(activeLoginPromise || loginSession?.active);
    return {
      installed: true,
      isLoggedIn: hasValidAuth,
      email,
      name,
      planName,
      tier,
      loginInProgress: inProgress,
      loginAuthUrl: inProgress ? activeUrl || null : null,
    };
  } catch (error) {
    return {
      installed,
      isLoggedIn: false,
      email: null,
      name: null,
      planName: null,
      tier: null,
      loginInProgress: Boolean(activeLoginPromise),
      loginAuthUrl: activeLoginAuthUrl,
      error: error instanceof Error ? error.message : 'Failed to check Google sign-in status',
    };
  }
}

async function startGeminiLoginFlow(
  server: AntigravityServerManager,
  ep: AntigravityEndpoint,
): Promise<GeminiAuthActionResult> {
  if (activeLoginPromise) {
    const sess = await server.getLoginSession(ep).catch(() => null);
    const url = sess?.authUrl || activeLoginAuthUrl;
    if (url && /^https:\/\//i.test(url)) {
      await systemShell.openExternal(url).catch(() => {});
    }
    return { success: true, alreadyInProgress: true, authUrl: url || null };
  }

  activeLoginAuthUrl = null;
  let settledEarly = false;

  const loginPromise = server
    .startGoogleLogin(ep)
    .then(async (res) => {
      settledEarly = true;
      activeLoginPromise = null;
      activeLoginAuthUrl = null;
      const st = await readGeminiAuthStatus().catch(() => null);
      await invalidateAfterAuthChange(server, st?.email ?? null);
      const ok = Boolean(res?.authResult?.hasValidAuth || st?.isLoggedIn);
      broadcastGeminiAuth('gemini-auth:login-completed', {
        success: ok,
        email: st?.email ?? null,
        planName: st?.planName ?? null,
        error: ok ? null : res?.authResult?.uiMessage || 'Google sign-in did not complete',
      });
      return res;
    })
    .catch((err) => {
      settledEarly = true;
      activeLoginPromise = null;
      activeLoginAuthUrl = null;
      broadcastGeminiAuth('gemini-auth:login-completed', {
        success: false,
        error: err instanceof Error ? err.message : 'Google sign-in cancelled or failed',
      });
      broadcastGeminiAuth('gemini-auth:updated', { timestamp: Date.now() });
      return null;
    });

  activeLoginPromise = loginPromise;
  broadcastGeminiAuth('gemini-auth:updated', { timestamp: Date.now() });

  // Poll briefly so the renderer has a fallback "Open browser" URL if needed.
  // Antigravity's Login RPC opens the system browser natively on macOS/Windows.
  for (let i = 0; i < 10; i++) {
    if (settledEarly) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
    const sess = await server.getLoginSession(ep).catch(() => null);
    if (sess?.authUrl) {
      activeLoginAuthUrl = sess.authUrl;
      break;
    }
  }

  broadcastGeminiAuth('gemini-auth:updated', { timestamp: Date.now() });
  return { success: true, started: !settledEarly, authUrl: activeLoginAuthUrl };
}

/** Reset module-level in-flight login state (for unit tests). */
export function resetGeminiAuthHandlerStateForTests(): void {
  activeLoginPromise = null;
  activeLoginAuthUrl = null;
  externalAccountUnsubscribe?.();
  externalAccountUnsubscribe = null;
}

export function registerGeminiAuthHandlers(): void {
  externalAccountUnsubscribe?.();
  externalAccountUnsubscribe = geminiUsageService.onExternalAccountChange(() => {
    broadcastGeminiAuth('gemini-auth:updated', { timestamp: Date.now() });
  });

  safeHandle('gemini-auth:status', async (): Promise<GeminiAuthStatus> => {
    return readGeminiAuthStatus();
  });

  safeHandle('gemini-auth:login', async (): Promise<GeminiAuthActionResult> => {
    try {
      const { server, ep } = await ensureGeminiAuthEndpoint();
      if (!ep) {
        return { success: false, error: 'Antigravity is not installed or could not start.' };
      }
      return await startGeminiLoginFlow(server, ep);
    } catch (error) {
      log.warn('[GeminiAuthHandlers] login failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Google sign-in failed',
      };
    }
  });

  safeHandle('gemini-auth:switch-account', async (): Promise<GeminiAuthActionResult> => {
    try {
      const { server, ep } = await ensureGeminiAuthEndpoint();
      if (!ep) {
        return { success: false, error: 'Antigravity is not installed or could not start.' };
      }
      if (activeLoginPromise) {
        await server.cancelGoogleLogin(ep).catch(() => {});
        activeLoginPromise = null;
        activeLoginAuthUrl = null;
      }
      await server.googleLogout(ep).catch(() => {});
      await invalidateAfterAuthChange(server, null);
      return await startGeminiLoginFlow(server, ep);
    } catch (error) {
      log.warn('[GeminiAuthHandlers] switch-account failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Account switch failed',
      };
    }
  });

  safeHandle('gemini-auth:cancel-login', async (): Promise<GeminiAuthActionResult> => {
    try {
      const { server, ep } = await ensureGeminiAuthEndpoint();
      if (ep) {
        await server.cancelGoogleLogin(ep).catch(() => {});
      }
      activeLoginPromise = null;
      activeLoginAuthUrl = null;
      broadcastGeminiAuth('gemini-auth:updated', { timestamp: Date.now() });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to cancel sign-in',
      };
    }
  });

  safeHandle('gemini-auth:logout', async (): Promise<GeminiAuthActionResult> => {
    try {
      const { server, ep } = await ensureGeminiAuthEndpoint();
      if (!ep) {
        return { success: false, error: 'Antigravity is not installed or could not start.' };
      }
      if (activeLoginPromise) {
        await server.cancelGoogleLogin(ep).catch(() => {});
        activeLoginPromise = null;
        activeLoginAuthUrl = null;
      }
      await server.googleLogout(ep);
      await invalidateAfterAuthChange(server, null);
      return { success: true };
    } catch (error) {
      log.warn('[GeminiAuthHandlers] logout failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Sign out failed',
      };
    }
  });

  safeHandle(
    'gemini-auth:open-url',
    async (_event, url?: unknown): Promise<GeminiAuthActionResult> => {
      const target =
        typeof url === 'string' && /^https:\/\//i.test(url) ? url : activeLoginAuthUrl;
      if (!target || !/^https:\/\//i.test(target)) {
        return { success: false, error: 'No active sign-in URL' };
      }
      await systemShell.openExternal(target);
      return { success: true };
    },
  );

  log.info('[GeminiAuthHandlers] Gemini Google auth IPC handlers registered');
}
