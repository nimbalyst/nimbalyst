/**
 * IPC handlers for Codex authentication.
 *
 * Drives the codex app-server's `account/*` RPCs through CodexAuthService.
 * The handlers are intentionally thin -- all protocol state lives in the
 * service.
 */

import { shell } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { logger } from '../utils/logger';
import { codexAuthService, type CodexAuthStatus } from '../services/CodexAuthService';

const log = logger.ipc;
const CODEX_DOCS_URL = 'https://developers.openai.com/codex';

interface CheckLoginResult {
  installed: boolean;
  isLoggedIn: boolean;
  authMode: CodexAuthStatus['authMode'];
  email: string | null;
  planType: string | null;
  message: string;
  error?: string;
}

function toCheckLoginResult(status: CodexAuthStatus): CheckLoginResult {
  const isLoggedIn = !!status.account;
  const email = status.account && status.account.type === 'chatgpt' ? status.account.email : null;
  const planType = status.planType;
  let message: string;
  if (!isLoggedIn) {
    message = 'Not signed in.';
  } else if (status.authMode === 'chatgpt') {
    message = planType ? `Signed in with ChatGPT (${planType}).` : 'Signed in with ChatGPT.';
  } else if (status.authMode === 'apikey') {
    message = 'Signed in with API key.';
  } else {
    message = 'Signed in.';
  }
  return {
    installed: true,
    isLoggedIn,
    authMode: status.authMode,
    email,
    planType,
    message,
  };
}

export function registerCodexAuthHandlers(): void {
  safeHandle('openai-codex:check-login', async (): Promise<CheckLoginResult> => {
    try {
      const status = await codexAuthService.getStatus();
      const result = toCheckLoginResult(status);
      // log.info('[CodexAuthHandlers] check-login:', { isLoggedIn: result.isLoggedIn, authMode: result.authMode });
      return result;
    } catch (error: any) {
      log.warn('[CodexAuthHandlers] check-login failed:', error?.message ?? error);
      return {
        installed: false,
        isLoggedIn: false,
        authMode: null,
        email: null,
        planType: null,
        message: 'Codex CLI is unavailable.',
        error: error?.message ?? 'Codex CLI is unavailable.',
      };
    }
  });

  safeHandle('openai-codex:login-chatgpt', async (): Promise<{ success: boolean; loginId?: string; error?: string }> => {
    try {
      const started = await codexAuthService.startChatGptLogin();
      log.info('[CodexAuthHandlers] login-chatgpt: opening', { loginId: started.loginId });
      await shell.openExternal(started.authUrl);
      return { success: true, loginId: started.loginId };
    } catch (error: any) {
      log.warn('[CodexAuthHandlers] login-chatgpt failed:', error?.message ?? error);
      return { success: false, error: error?.message ?? 'Login failed' };
    }
  });

  safeHandle('openai-codex:login-apikey', async (_event, apiKey: string): Promise<{ success: boolean; error?: string }> => {
    try {
      await codexAuthService.loginWithApiKey(apiKey);
      log.info('[CodexAuthHandlers] login-apikey: ok');
      return { success: true };
    } catch (error: any) {
      log.warn('[CodexAuthHandlers] login-apikey failed:', error?.message ?? error);
      return { success: false, error: error?.message ?? 'Login failed' };
    }
  });

  safeHandle('openai-codex:cancel-login', async (): Promise<{ success: boolean; error?: string }> => {
    try {
      await codexAuthService.cancelChatGptLogin();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message ?? 'Cancel failed' };
    }
  });

  safeHandle('openai-codex:logout', async (): Promise<{ success: boolean; error?: string }> => {
    try {
      await codexAuthService.logout();
      log.info('[CodexAuthHandlers] logout: ok');
      return { success: true };
    } catch (error: any) {
      log.warn('[CodexAuthHandlers] logout failed:', error?.message ?? error);
      return { success: false, error: error?.message ?? 'Logout failed' };
    }
  });

  safeHandle('openai-codex:get-auth-docs-url', async () => {
    return { url: CODEX_DOCS_URL };
  });

  // Kept for backwards-compat with any caller that still invokes the old
  // shell-based "open Terminal" login. Now just runs the ChatGPT browser flow.
  safeHandle('openai-codex:login', async (): Promise<{ success: boolean; message: string; error?: string }> => {
    try {
      const started = await codexAuthService.startChatGptLogin();
      await shell.openExternal(started.authUrl);
      return { success: true, message: 'Opened ChatGPT login in your browser.' };
    } catch (error: any) {
      return { success: false, message: 'Failed to start Codex login.', error: error?.message ?? 'Login failed' };
    }
  });
}
