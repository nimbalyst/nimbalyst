/**
 * CodexAuthService -- drives the codex app-server's `account/*` RPCs from a
 * single lazy long-lived child, so the renderer can show login status and run
 * the ChatGPT browser flow / API-key login in-app instead of via the codex CLI.
 *
 * Lazy spawn: the child is only started on the first auth interaction. Once
 * alive it stays up for the rest of the app's lifetime so we can receive
 * async `account/login/completed` and `account/updated` notifications. The
 * codex binary persists auth to ~/.codex/auth.json, which session children
 * read on their own startup -- no need to coordinate state in memory.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { BrowserWindow } from 'electron';
import { JsonRpcClient } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/jsonRpcClient';
import {
  getCodexVendorPathEntries,
  resolveCodexBinaryPath,
} from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/codexAppServerBinary';
import { resolvePackagedCodexBinaryPath } from '@nimbalyst/runtime/ai/server/providers/codex/codexBinaryPath';
import type {
  AccountAuthMode,
  AccountKind,
  AccountLoginCompletedNotification,
  AccountLoginStartResponse,
  AccountRateLimitsReadResponse,
  AccountRateLimitsUpdatedNotification,
  AccountReadResponse,
  AccountUpdatedNotification,
  InitializeResponse,
} from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/types';
import { logger } from '../utils/logger';
import { getEnhancedPath } from './CLIManager';

export interface CodexAuthStatus {
  account: AccountKind;
  requiresOpenaiAuth: boolean;
  authMode: AccountAuthMode;
  planType: string | null;
}

export interface CodexLoginStartedChatGpt {
  type: 'chatgpt';
  loginId: string;
  authUrl: string;
}

class CodexAuthServiceImpl {
  private child: ChildProcessWithoutNullStreams | null = null;
  private client: JsonRpcClient | null = null;
  private initializing: Promise<JsonRpcClient> | null = null;
  private currentLoginId: string | null = null;
  private cachedStatus: CodexAuthStatus | null = null;
  private rateLimitsUpdatedListeners = new Set<() => void>();

  async getStatus(refreshToken = false): Promise<CodexAuthStatus> {
    const client = await this.ensureChild();
    const res = await client.request<AccountReadResponse>('account/read', { refreshToken });
    // logger.main.info('[CodexAuth] account/read result', {
    //   refreshToken,
    //   account: res.account ? { type: res.account.type, hasEmail: 'email' in res.account, planType: 'planType' in res.account ? res.account.planType : null } : null,
    //   requiresOpenaiAuth: res.requiresOpenaiAuth,
    // });
    const status: CodexAuthStatus = {
      account: res.account,
      requiresOpenaiAuth: res.requiresOpenaiAuth,
      authMode: this.deriveAuthMode(res.account),
      planType: res.account && res.account.type === 'chatgpt' ? res.account.planType : null,
    };
    this.cachedStatus = status;
    return status;
  }

  async getRateLimits(): Promise<AccountRateLimitsReadResponse> {
    const client = await this.ensureChild();
    return client.request<AccountRateLimitsReadResponse>('account/rateLimits/read', {});
  }

  onRateLimitsUpdated(listener: () => void): () => void {
    this.rateLimitsUpdatedListeners.add(listener);
    return () => this.rateLimitsUpdatedListeners.delete(listener);
  }

  /** Browser flow: returns the auth URL. Codex emits `account/login/completed` when done. */
  async startChatGptLogin(): Promise<CodexLoginStartedChatGpt> {
    const client = await this.ensureChild();
    const res = await client.request<AccountLoginStartResponse>('account/login/start', { type: 'chatgpt' });
    if (res.type !== 'chatgpt') {
      throw new Error('[CodexAuth] account/login/start returned unexpected type: ' + res.type);
    }
    this.currentLoginId = res.loginId;
    return { type: 'chatgpt', loginId: res.loginId, authUrl: res.authUrl };
  }

  /** API-key flow: codex stores the key in ~/.codex/auth.json so session children see it. */
  async loginWithApiKey(apiKey: string): Promise<void> {
    if (!apiKey || !apiKey.trim()) {
      throw new Error('API key is required');
    }
    const client = await this.ensureChild();
    await client.request<AccountLoginStartResponse>('account/login/start', { type: 'apiKey', apiKey });
  }

  async cancelChatGptLogin(): Promise<void> {
    if (!this.currentLoginId || !this.client) return;
    try {
      await this.client.request('account/login/cancel', { loginId: this.currentLoginId });
    } finally {
      this.currentLoginId = null;
    }
  }

  async logout(): Promise<void> {
    const client = await this.ensureChild();
    await client.request('account/logout', {});
    this.cachedStatus = null;
  }

  getCachedStatus(): CodexAuthStatus | null {
    return this.cachedStatus;
  }

  shutdown(): void {
    this.currentLoginId = null;
    try { this.client?.close('shutdown'); } catch { /* noop */ }
    this.client = null;
    if (this.child && !this.child.killed) {
      try { this.child.stdin?.end(); } catch { /* noop */ }
      try { this.child.kill(); } catch { /* noop */ }
    }
    this.child = null;
    this.initializing = null;
  }

  private deriveAuthMode(account: AccountKind): AccountAuthMode {
    if (!account) return null;
    if (account.type === 'apiKey') return 'apikey';
    if (account.type === 'chatgpt') return 'chatgpt';
    return null;
  }

  private ensureChild(): Promise<JsonRpcClient> {
    if (this.client) return Promise.resolve(this.client);
    if (this.initializing) return this.initializing;

    this.initializing = (async () => {
      const binaryPath = resolveCodexBinaryPath(() => resolvePackagedCodexBinaryPath());
      const env = this.buildEnv(binaryPath);
      const child = spawn(binaryPath, ['app-server', '--listen', 'stdio://'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        logger.main.debug('[CodexAuth] stderr:', chunk.toString().trim());
      });
      child.on('exit', (code, signal) => {
        logger.main.warn('[CodexAuth] codex app-server exited', { code, signal });
        this.client = null;
        this.child = null;
        this.initializing = null;
      });
      const client = new JsonRpcClient(child, {
        logger: {
          log: (m, ...a) => logger.main.debug('[CodexAuth]', m, ...a),
          warn: (m, ...a) => logger.main.warn('[CodexAuth]', m, ...a),
        },
      });
      client.onNotification((method, params) => this.handleNotification(method, params));
      try {
        await client.request<InitializeResponse>('initialize', {
          clientInfo: { name: 'nimbalyst-auth', version: process.env.NIMBALYST_VERSION ?? '0.0.0' },
          capabilities: { experimentalApi: true },
        });
        client.notify('initialized', {});
      } catch (err) {
        try { client.close('init failed'); } catch { /* noop */ }
        try { child.kill(); } catch { /* noop */ }
        throw err;
      }
      this.child = child;
      this.client = client;
      return client;
    })();

    return this.initializing.catch((err) => {
      this.initializing = null;
      throw err;
    });
  }

  private buildEnv(binaryPath: string): NodeJS.ProcessEnv {
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    const helperPathEntries = getCodexVendorPathEntries(binaryPath);
    const enhancedPath = getEnhancedPath();
    const existingPath = baseEnv.PATH ?? baseEnv.Path ?? '';
    const merged = Array.from(new Set([
      ...helperPathEntries,
      ...enhancedPath.split(path.delimiter).filter(Boolean),
      ...existingPath.split(path.delimiter).filter(Boolean),
    ])).join(path.delimiter);
    baseEnv.PATH = merged;
    delete baseEnv.Path;
    return baseEnv;
  }

  private handleNotification(method: string, params: unknown): void {
    if (method === 'account/updated') {
      const n = params as AccountUpdatedNotification;
      const planType = n.planType ?? this.cachedStatus?.planType ?? null;
      const account: AccountKind =
        n.authMode === 'apikey' ? { type: 'apiKey' } :
        n.authMode === 'chatgpt' ? { type: 'chatgpt', email: this.cachedStatusEmail() ?? '', planType: planType ?? '' } :
        null;
      this.cachedStatus = {
        account,
        requiresOpenaiAuth: !account,
        authMode: n.authMode,
        planType,
      };
      this.broadcast('openai-codex:auth-updated', this.cachedStatus);
      return;
    }
    if (method === 'account/login/completed') {
      const n = params as AccountLoginCompletedNotification;
      this.currentLoginId = null;
      this.broadcast('openai-codex:auth-login-completed', n);
      // Always refresh after a completion so account email / planType are accurate.
      this.getStatus().catch((err) => logger.main.warn('[CodexAuth] refresh after login/completed failed:', err));
      return;
    }
    if (method === 'account/rateLimits/updated') {
      const notification = params as AccountRateLimitsUpdatedNotification;
      if (!notification.rateLimits) return;
      for (const listener of this.rateLimitsUpdatedListeners) {
        listener();
      }
    }
  }

  private cachedStatusEmail(): string | null {
    const account = this.cachedStatus?.account;
    return account && account.type === 'chatgpt' ? account.email : null;
  }

  private broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }
}

export const codexAuthService = new CodexAuthServiceImpl();
