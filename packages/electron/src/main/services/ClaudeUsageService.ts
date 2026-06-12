/**
 * ClaudeUsageService - Tracks Claude Code API usage limits
 *
 * This service:
 * - Reads OAuth credentials from the platform credential store:
 *   - macOS: macOS Keychain (where Claude Code stores them)
 *   - Windows/Linux: ~/.claude/.credentials.json file
 * - Calls Anthropic's usage API to get 5-hour session and 7-day weekly limits
 * - Implements activity-aware polling (active when using Claude, sleeps when idle)
 * - Broadcasts usage updates to renderer via IPC
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';

export interface ClaudeUsageData {
  fiveHour: {
    utilization: number; // 0-100 percentage
    resetsAt: string | null; // ISO timestamp
  };
  sevenDay: {
    utilization: number;
    resetsAt: string | null;
  };
  sevenDayOpus?: {
    utilization: number;
    resetsAt: string | null;
  };
  lastUpdated: number; // Unix timestamp
  error?: string;
}

interface KeychainCredentials {
  claudeAiOauth?: {
    accessToken?: string;
  };
}

const USAGE_API_URL = 'https://api.anthropic.com/api/oauth/usage';
const KEYCHAIN_SERVICES = ['Claude Code-credentials', 'Claude Code']; // Primary and fallback
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes before going to sleep
const KEYCHAIN_RETRY_DELAY_MS = 2000; // Retry delay for keychain errors (post-unlock)
const KEYCHAIN_MAX_RETRIES = 3;
const NETWORK_RETRY_DELAY_MS = 3000; // Retry delay for network errors
const NETWORK_MAX_RETRIES = 3;
const USAGE_ERROR_BODY_MAX_CHARS = 600;

class ClaudeUsageServiceImpl {
  private cachedUsage: ClaudeUsageData | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private lastActivityTime: number = 0;
  private isPolling: boolean = false;
  private isSleeping: boolean = true;
  private inflightRefresh: Promise<ClaudeUsageData> | null = null;
  private claudeCodeVersion: string | null = null;

  /**
   * Initialize the service. Does not start polling until activity is detected.
   */
  initialize(): void {
    logger.main.info('[ClaudeUsageService] Initialized (sleeping until activity detected)');
  }

  private getClaudeCodeVersion(): string {
    if (this.claudeCodeVersion) return this.claudeCodeVersion;
    try {
      // Read the real Claude Code version from the SDK's manifest.json
      // (package.json has the npm version e.g. 0.2.69, but manifest.json has the actual CLI version e.g. 2.1.69)
      const sdkDir = path.dirname(require.resolve('@anthropic-ai/claude-agent-sdk'));
      const manifest = JSON.parse(fs.readFileSync(path.join(sdkDir, 'manifest.json'), 'utf-8'));
      this.claudeCodeVersion = manifest.version || 'unknown';
    } catch {
      this.claudeCodeVersion = 'unknown';
    }
    return this.claudeCodeVersion!;
  }

  /**
   * Called when user sends a message to a Claude agent session.
   * Wakes up the service and triggers an immediate refresh.
   */
  async recordActivity(): Promise<void> {
    this.lastActivityTime = Date.now();

    if (this.isSleeping) {
      // logger.main.info('[ClaudeUsageService] Waking up due to activity');
      this.isSleeping = false;
      this.startPolling();
      // Immediate refresh on wake
      await this.refresh();
    }
  }

  /**
   * Get the current cached usage data. Returns null if no data available.
   */
  getCachedUsage(): ClaudeUsageData | null {
    return this.cachedUsage;
  }

  /**
   * Force a refresh of usage data from the API.
   * Deduplicates concurrent calls — if a refresh is already in flight, returns the same promise.
   */
  async refresh(): Promise<ClaudeUsageData> {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }

    this.inflightRefresh = this.doRefresh();
    try {
      return await this.inflightRefresh;
    } finally {
      this.inflightRefresh = null;
    }
  }

  private async doRefresh(): Promise<ClaudeUsageData> {
    try {
      const token = this.getAccessToken();
      if (!token) {
        const source = process.platform === 'darwin' ? 'macOS Keychain' : '~/.claude/.credentials.json';
        logger.main.warn(
          `[ClaudeUsageService] No Claude OAuth token found in ${source}. ` +
          'Claude usage indicator will remain hidden until Claude Code login is restored.'
        );
        const errorData: ClaudeUsageData = {
          fiveHour: { utilization: 0, resetsAt: null },
          sevenDay: { utilization: 0, resetsAt: null },
          lastUpdated: Date.now(),
          error: 'No Claude Code credentials found. Please log in to Claude Code.',
        };
        this.cachedUsage = errorData;
        this.broadcastUpdate();
        return errorData;
      }

      const usageData = await this.fetchUsageData(token);
      this.cachedUsage = usageData;
      this.broadcastUpdate();
      return usageData;
    } catch (error) {
      logger.main.error('[ClaudeUsageService] Error refreshing usage:', error);
      const errorData: ClaudeUsageData = {
        fiveHour: { utilization: 0, resetsAt: null },
        sevenDay: { utilization: 0, resetsAt: null },
        lastUpdated: Date.now(),
        error: error instanceof Error ? error.message : 'Unknown error fetching usage',
      };
      this.cachedUsage = errorData;
      this.broadcastUpdate();
      return errorData;
    }
  }

  /**
   * Stop the service and clean up timers.
   */
  stop(): void {
    this.stopPolling();
    logger.main.info('[ClaudeUsageService] Stopped');
  }

  private startPolling(): void {
    if (this.isPolling) return;

    this.isPolling = true;
    this.pollTimer = setInterval(() => {
      this.pollTick();
    }, POLL_INTERVAL_MS);

    // logger.main.info('[ClaudeUsageService] Started polling (every 30 minutes)');
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.isPolling = false;
  }

  private async pollTick(): Promise<void> {
    // Check if we should go to sleep due to inactivity
    const timeSinceActivity = Date.now() - this.lastActivityTime;
    if (timeSinceActivity > IDLE_TIMEOUT_MS) {
      logger.main.info('[ClaudeUsageService] Going to sleep due to inactivity');
      this.isSleeping = true;
      this.stopPolling();
      return;
    }

    // Refresh usage data
    await this.refresh();
  }

  private getAccessToken(): string | null {
    if (process.platform === 'darwin') {
      return this.getAccessTokenFromKeychain();
    }
    // Windows and Linux: read from ~/.claude/.credentials.json
    return this.getAccessTokenFromCredentialsFile();
  }

  private getAccessTokenFromKeychain(): string | null {
    // Try each keychain service name (primary and fallback)
    for (const serviceName of KEYCHAIN_SERVICES) {
      const token = this.tryGetTokenFromKeychain(serviceName);
      if (token) {
        return token;
      }
    }

    logger.main.debug('[ClaudeUsageService] Claude Code credentials not found in any keychain entry');
    return null;
  }

  private getAccessTokenFromCredentialsFile(): string | null {
    try {
      const credentialsPath = path.join(os.homedir(), '.claude', '.credentials.json');
      if (!fs.existsSync(credentialsPath)) {
        logger.main.debug('[ClaudeUsageService] Credentials file not found:', credentialsPath);
        return null;
      }

      const fileContent = fs.readFileSync(credentialsPath, 'utf8');
      const credentials: KeychainCredentials = JSON.parse(fileContent);
      const token = credentials.claudeAiOauth?.accessToken;

      if (!token) {
        logger.main.debug('[ClaudeUsageService] No access token in credentials file');
        return null;
      }

      return token;
    } catch (error) {
      logger.main.warn('[ClaudeUsageService] Error reading credentials file:', error);
      return null;
    }
  }

  private tryGetTokenFromKeychain(serviceName: string): string | null {
    try {
      // Read credentials from macOS Keychain
      const result = execSync(
        `security find-generic-password -s "${serviceName}" -w`,
        { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      ).trim();

      // Parse the JSON credentials
      const credentials: KeychainCredentials = JSON.parse(result);
      const token = credentials.claudeAiOauth?.accessToken;

      if (!token) {
        logger.main.debug(`[ClaudeUsageService] No access token in keychain entry: ${serviceName}`);
        return null;
      }

      return token;
    } catch (error) {
      // Security command returns error if item not found - this is expected
      if (error instanceof Error && error.message.includes('could not be found')) {
        // Silent - will try fallback
        return null;
      }
      // Log other errors but continue to try fallback
      logger.main.warn(`[ClaudeUsageService] Error reading keychain entry ${serviceName}:`, error);
      return null;
    }
  }

  private async fetchUsageData(accessToken: string): Promise<ClaudeUsageData> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < NETWORK_MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(USAGE_API_URL, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'anthropic-beta': 'oauth-2025-04-20',
            'User-Agent': `claude-code/${this.getClaudeCodeVersion()}`,
          },
        });

        if (!response.ok) {
          const errorBody = await this.readErrorBody(response);

          if (response.status === 401) {
            // Non-retryable: auth expired
            logger.main.warn(
              `[ClaudeUsageService] Usage API returned 401 (unauthorized). Claude OAuth token is likely expired; user should re-login.` +
              (errorBody ? ` Response body: ${errorBody}` : '')
            );
            throw new Error('Authentication expired. Please re-login to Claude Code.');
          }

          if (response.status === 403) {
            logger.main.warn(
              '[ClaudeUsageService] Usage API returned 403 (forbidden). ' +
              'User may be authenticated for Claude Code but missing usage API authorization.' +
              (errorBody ? ` Response body: ${errorBody}` : '')
            );
            throw new Error(
              'Usage API access forbidden (403). Your account may not have usage API permissions.'
            );
          }

          if (response.status === 429) {
            // Non-retryable: rate limited. Don't make it worse by retrying.
            logger.main.warn(
              '[ClaudeUsageService] Usage API returned 429 (rate limited). Will retry at next poll interval.' +
              (errorBody ? ` Response body: ${errorBody}` : '')
            );
            throw new Error('Rate limited (429). Will retry later.');
          }

          logger.main.warn(
            `[ClaudeUsageService] Usage API error response: ${response.status} ${response.statusText}` +
            (errorBody ? ` Response body: ${errorBody}` : '')
          );
          throw new Error(`API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();

        return {
          fiveHour: {
            utilization: data.five_hour?.utilization ?? 0,
            resetsAt: data.five_hour?.resets_at ?? null,
          },
          sevenDay: {
            utilization: data.seven_day?.utilization ?? 0,
            resetsAt: data.seven_day?.resets_at ?? null,
          },
          sevenDayOpus: data.seven_day_opus ? {
            utilization: data.seven_day_opus.utilization ?? 0,
            resetsAt: data.seven_day_opus.resets_at ?? null,
          } : undefined,
          lastUpdated: Date.now(),
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // Don't retry auth errors or rate limits
        if (lastError.message.includes('Authentication expired') ||
            lastError.message.includes('Rate limited') ||
            lastError.message.includes('access forbidden')) {
          throw lastError;
        }

        // Retry on network errors
        if (attempt < NETWORK_MAX_RETRIES - 1) {
          logger.main.warn(
            `[ClaudeUsageService] Fetch attempt ${attempt + 1} failed (${lastError.message}). ` +
            `Retrying in ${NETWORK_RETRY_DELAY_MS}ms...`
          );
          await this.sleep(NETWORK_RETRY_DELAY_MS);
        }
      }
    }

    throw lastError || new Error('Failed to fetch usage data after retries');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async readErrorBody(response: Response): Promise<string> {
    try {
      const bodyText = (await response.text()).trim();
      if (!bodyText) return '';

      let normalized = bodyText;
      try {
        normalized = JSON.stringify(JSON.parse(bodyText));
      } catch {
        // Keep plain text if body is not JSON
      }

      if (normalized.length > USAGE_ERROR_BODY_MAX_CHARS) {
        return `${normalized.slice(0, USAGE_ERROR_BODY_MAX_CHARS)}...`;
      }
      return normalized;
    } catch {
      return '';
    }
  }

  private broadcastUpdate(): void {
    // Send update to all browser windows
    const windows = BrowserWindow.getAllWindows();
    for (const window of windows) {
      if (!window.isDestroyed()) {
        window.webContents.send('claude-usage:update', this.cachedUsage);
      }
    }
    if (this.cachedUsage) {
      for (const listener of claudeUsageUpdateListeners) {
        try {
          listener(this.cachedUsage);
        } catch {
          // Listener errors must not break the window broadcast path.
        }
      }
    }
  }

  getCached(): ClaudeUsageData | null {
    return this.cachedUsage;
  }
}

// Out-of-window subscribers (e.g. mobile settings sync) that want refreshed
// usage without an IPC round trip.
const claudeUsageUpdateListeners = new Set<(usage: ClaudeUsageData) => void>();
export function onClaudeUsageUpdate(listener: (usage: ClaudeUsageData) => void): () => void {
  claudeUsageUpdateListeners.add(listener);
  return () => claudeUsageUpdateListeners.delete(listener);
}

// Singleton instance
export const claudeUsageService = new ClaudeUsageServiceImpl();
